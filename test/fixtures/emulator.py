"""Synthetic Xiaomi peer using the real local UDP/TCP sockets and crypto."""

import asyncio
import json
import struct
from contextlib import suppress

import support  # noqa: F401
from xiaomi_native_protocol.cloud import Provisioning
from xiaomi_native_protocol.crypto import decode_media, encode_media, generate_keypair, shared_key
from xiaomi_native_protocol.cs2 import ACK, DRW, message


class CameraEmulator(asyncio.DatagramProtocol):
    def __init__(self, frames=None, codec=4, tcp=False, reorder=False):
        self.frames = frames or []
        self.codec = codec
        self.tcp = tcp
        self.reorder = reorder
        self.public, self.private = generate_keypair()
        self.port = 0
        self.udp = None
        self.server = None
        self.writer = None
        self.peer = None
        self.key = None
        self.channel_seq = {0: 0, 2: 0}
        self.received = set()
        self.video_quality = None
        self.task = None
        self.clients = []
        self.pings = 0
        self.motor_operations = []
        self.authentications = 0
        self.media_starts = 0

    async def start(self):
        self.server = await asyncio.start_server(self._tcp_peer, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.udp, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: self, local_addr=("127.0.0.1", self.port)
        )
        return self

    def datagram_received(self, packet, addr):
        if packet[1] == 0x30:
            if addr != self.peer:
                if self.task is not None:
                    self.task.cancel()
                self.received.clear()
                self.channel_seq = {0: 0, 2: 0}
            self.peer = addr
            self.udp.sendto(message(0x41, bytes(12)), addr)
        elif packet[1] == 0x41:
            self.udp.sendto(message(0x43 if self.tcp else 0x42, bytes(12)), addr)
        else:
            self._handle(packet)

    async def _tcp_peer(self, reader, writer):
        self.writer = writer
        self.clients.append(writer)
        try:
            while True:
                header = await reader.readexactly(8)
                size = struct.unpack_from(">H", header)[0]
                self._handle(await reader.readexactly(size))
        except (asyncio.IncompleteReadError, ConnectionError):
            pass

    def _send(self, packet):
        if self.tcp:
            if self.writer is not None:
                self.writer.write(struct.pack(">HB5x", len(packet), 0x68) + packet)
        else:
            self.udp.sendto(packet, self.peer)

    def _handle(self, packet):
        kind = packet[1]
        if kind == 0xF0:
            if self.task is not None:
                self.task.cancel()
            return
        if kind == 0xE0:
            self.pings += 1
            self._send(message(0xE1))
        if kind != DRW:
            return
        channel, seq = packet[5], struct.unpack_from(">H", packet, 6)[0]
        if not self.tcp:
            self._send(message(ACK, struct.pack(">BBHH", ACK, channel, 1, seq)))
        if seq in self.received:
            return
        self.received.add(seq)
        command = struct.unpack_from(">I", packet, 12)[0]
        payload = packet[16:]
        if command == 0x100:
            self.authentications += 1
            auth = json.loads(payload)
            self.key = shared_key(bytes.fromhex(auth["public_key"]), self.private)
            self._send_channel(0, struct.pack("<I", 0x101) + b'{"result":"success"}')
        elif command == 0x1001:
            plain = decode_media(self.key, payload)
            if struct.unpack_from(">I", plain)[0] == 0x102:
                self.media_starts += 1
                settings = json.loads(plain[4:])
                self.video_quality = settings["videoquality"]
                assert settings["enableaudio"] == 0
                if self.frames:
                    self.task = asyncio.create_task(self._emit())
            elif struct.unpack_from(">I", plain)[0] == 0x112:
                settings = json.loads(plain[4:])
                # Independent peer-side decoding of the on-wire operation.
                self.motor_operations.append(settings["operation"])
                response = encode_media(self.key, b'\x00\x00\x01\x13{"ret":0}\x00')
                self._send_channel(0, struct.pack(">I", 0x1001) + response)

    def _send_channel(self, channel, data):
        data = struct.pack(">I", len(data)) + data
        packets = []
        while data:
            chunk, data = data[:700], data[700:]
            seq = self.channel_seq[channel]
            self.channel_seq[channel] = (seq + 1) & 65535
            packets.append(message(DRW, struct.pack(">BBH", ACK, channel, seq) + chunk))
        if self.reorder and not self.tcp and len(packets) >= 3:
            packets[0], packets[1] = packets[1], packets[0]
        for packet in packets:
            self._send(packet)

    async def _emit(self):
        index = 0
        while True:
            encrypted = encode_media(self.key, self.frames[index % len(self.frames)])
            header = struct.pack(
                "<IIIIQ8x", len(encrypted), self.codec, index, 0, 500000 + index * 50
            )
            self._send_channel(2, header + encrypted)
            index += 1
            await asyncio.sleep(0.04)

    def provisioning(self):
        public, private = generate_keypair()
        return Provisioning(public, private, self.public, "synthetic-signature", "cs2")

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.udp is not None:
            self.udp.close()
        for writer in self.clients:
            writer.close()
            with suppress(ConnectionError):
                await writer.wait_closed()
        self.server.close()
        await self.server.wait_closed()
