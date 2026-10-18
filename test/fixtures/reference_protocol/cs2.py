"""Async CS2 LAN transport: discovery, UDP ordering/ACKs and TCP framing.

Ported from AlexxIT/go2rtc (MIT; see NOTICE). Packets are accepted only from
the configured camera IP. All length fields and buffers are bounded.
"""

from __future__ import annotations

import asyncio
import ipaddress
import struct
from contextlib import suppress
from typing import Any

from .errors import ProtocolError, TransportError

MAGIC = 0xF1
DRW = 0xD0
ACK = 0xD1
MAX_MESSAGE = 8 * 1024 * 1024
MAX_FRAME = 65535


def message(kind: int, payload: bytes = b"") -> bytes:
    if len(payload) > 65535:
        raise ProtocolError("CS2 datagram is too large")
    return struct.pack(">BBH", MAGIC, kind, len(payload)) + payload


def marshal_command(sequence: int, command: int, payload: bytes) -> bytes:
    inner = struct.pack(">BBHII", ACK, 0, sequence, len(payload) + 4, command) + payload
    return message(DRW, inner)


class DataChannel:
    """Reassemble length-prefixed messages and reorder 16-bit UDP sequences."""

    def __init__(self, *, window: int = 256, queue_size: int = 128) -> None:
        self.expected = 0
        self.window = window
        self.pending: dict[int, bytes] = {}
        self.buffer = bytearray()
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue(queue_size)
        self.pending_bytes = 0

    def feed(self, data: bytes) -> None:
        if len(self.buffer) + len(data) > MAX_MESSAGE + 4:
            raise ProtocolError("CS2 reassembly buffer limit exceeded")
        self.buffer.extend(data)
        while len(self.buffer) >= 4:
            size = struct.unpack_from(">I", self.buffer)[0]
            if size < 1 or size > MAX_MESSAGE:
                raise ProtocolError("Invalid CS2 message length")
            if len(self.buffer) < size + 4:
                return
            packet = bytes(self.buffer[4 : 4 + size])
            del self.buffer[: size + 4]
            try:
                self.queue.put_nowait(packet)
            except asyncio.QueueFull:
                raise TransportError(
                    "Camera receiver could not keep up with incoming media"
                ) from None

    def feed_sequence(self, seq: int, data: bytes) -> bool:
        difference = ((seq - self.expected + 32768) & 0xFFFF) - 32768
        if difference < 0:
            return True  # ACK duplicates; the previous ACK may have been lost.
        if difference > 0:
            if difference > self.window:
                return False
            if seq not in self.pending:
                if len(self.pending) >= self.window or self.pending_bytes + len(data) > MAX_MESSAGE:
                    return False  # Do not ACK a packet we could not retain.
                self.pending[seq] = bytes(data)
                self.pending_bytes += len(data)
            return True
        while True:
            self.feed(data)
            self.expected = (self.expected + 1) & 0xFFFF
            following = self.pending.pop(self.expected, None)
            if following is None:
                return True
            self.pending_bytes -= len(following)
            data = following

    def close(self) -> None:
        # Wake a blocked reader even when the queue was full.
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(None)
        self.pending.clear()
        self.buffer.clear()


class _Datagrams(asyncio.DatagramProtocol):
    def __init__(self, host: str) -> None:
        self.host = host
        self.queue: asyncio.Queue[tuple[bytes, tuple[str, int]] | None] = asyncio.Queue(2048)

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if addr[0] != self.host or len(data) < 4 or data[0] != MAGIC:
            return
        if len(data) != struct.unpack_from(">H", data, 2)[0] + 4:
            return
        with suppress(asyncio.QueueFull):
            self.queue.put_nowait((data, addr))

    def error_received(self, exc: Exception) -> None:
        with suppress(asyncio.QueueFull):
            self.queue.put_nowait(None)


class CS2Connection:
    """One authenticated peer transport. MISS authentication is layered above."""

    def __init__(self) -> None:
        self.protocol = "cs2+udp"
        self._datagrams: _Datagrams | None = None
        self._udp: asyncio.DatagramTransport | None = None
        self._remote: tuple[str, int] = ("", 32108)
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._channels = {0: DataChannel(window=64, queue_size=16), 2: DataChannel()}
        self._sequence = 0
        self._command_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._ack: tuple[int, asyncio.Event] | None = None
        self._error: Exception | None = None
        self._closed = False

    @classmethod
    async def connect(
        cls, host: str, transport: str = "auto", *, port: int = 32108, timeout: float = 8
    ) -> CS2Connection:
        try:
            ip = ipaddress.IPv4Address(host)
            if ip.is_unspecified or ip.is_multicast or int(ip) == 0xFFFFFFFF:
                raise ValueError
        except ipaddress.AddressValueError:
            raise ProtocolError(
                "Configure the camera's local IPv4 address in integration options"
            ) from None
        except ValueError:
            raise ProtocolError("Invalid camera IPv4 address") from None
        if transport not in {"auto", "udp", "tcp"}:
            raise ValueError("Invalid CS2 transport")
        self = cls()
        self._remote = (str(ip), port)
        self._datagrams = _Datagrams(str(ip))
        try:
            self._udp, _ = await asyncio.get_running_loop().create_datagram_endpoint(
                lambda: self._datagrams, local_addr=("0.0.0.0", 0)
            )
            punch = await self._exchange(message(0x30), {0x41}, timeout)
            accepted = (
                {0x42, 0x43} if transport == "auto" else {0x43 if transport == "tcp" else 0x42}
            )
            ready = await self._exchange(punch, accepted, timeout)
            if ready[1] == 0x43:
                self.protocol = "cs2+tcp"
                self._udp.close()
                self._udp = None
                self._reader, self._writer = await asyncio.wait_for(
                    asyncio.open_connection(*self._remote), timeout=timeout
                )
            self._tasks = [asyncio.create_task(self._run()), asyncio.create_task(self._keepalive())]
            return self
        except BaseException:
            await self.close()
            raise

    async def _exchange(self, request: bytes, accepted: set[int], timeout: float) -> bytes:
        assert self._udp is not None and self._datagrams is not None
        deadline = asyncio.get_running_loop().time() + timeout
        while (remaining := deadline - asyncio.get_running_loop().time()) > 0:
            self._udp.sendto(request, self._remote)
            end_attempt = asyncio.get_running_loop().time() + min(1, remaining)
            while (wait := end_attempt - asyncio.get_running_loop().time()) > 0:
                try:
                    item = await asyncio.wait_for(self._datagrams.queue.get(), wait)
                except TimeoutError:
                    break
                if item is None:
                    raise TransportError("Camera UDP socket failed during discovery")
                packet, addr = item
                if packet[1] in accepted and len(packet) >= 16:
                    self._remote = addr  # The camera negotiates a new port.
                    return packet
        raise TransportError(
            "CS2 camera handshake timed out; check the camera IP and LAN connectivity"
        )

    async def _send(self, packet: bytes) -> None:
        if self._closed or self._error is not None:
            raise TransportError("Camera transport is closed")
        async with self._send_lock:
            if self._writer is not None:
                self._writer.write(struct.pack(">HB5x", len(packet), 0x68) + packet)
                await asyncio.wait_for(self._writer.drain(), 5)
            elif self._udp is not None:
                self._udp.sendto(packet, self._remote)
            else:
                raise TransportError("Camera transport is unavailable")

    async def _receive(self) -> bytes:
        if self._reader is not None:
            header = await self._reader.readexactly(8)
            size = struct.unpack_from(">H", header)[0]
            if header[2] != 0x68 or not 4 <= size <= MAX_FRAME:
                raise ProtocolError("Invalid CS2 TCP frame")
            packet = await self._reader.readexactly(size)
            if packet[0] != MAGIC or struct.unpack_from(">H", packet, 2)[0] != len(packet) - 4:
                raise ProtocolError("Invalid CS2 TCP packet length")
            return packet
        assert self._datagrams is not None
        item = await self._datagrams.queue.get()
        if item is None:
            raise TransportError("Camera UDP socket failed")
        packet, addr = item
        if addr != self._remote:
            # Same IP with an unnegotiated port is not this session.
            return b""
        return packet

    async def _run(self) -> None:
        try:
            while not self._closed:
                packet = await self._receive()
                if not packet:
                    continue
                kind = packet[1]
                if kind == DRW:
                    if len(packet) < 8 or packet[4] != ACK:
                        raise ProtocolError("Invalid CS2 channel header")
                    channel_id = packet[5]
                    channel = self._channels.get(channel_id)
                    if channel is None:
                        continue
                    seq = struct.unpack_from(">H", packet, 6)[0]
                    if self.protocol == "cs2+tcp":
                        channel.feed(packet[8:])
                    elif channel.feed_sequence(seq, packet[8:]):
                        await self._send(
                            message(ACK, struct.pack(">BBHH", ACK, channel_id, 1, seq))
                        )
                elif kind == ACK:
                    self._handle_ack(packet)
                elif kind == 0xE0:
                    await self._send(message(0xE1))
                elif kind == 0xF0:
                    await self._send(message(0xF1))
                    raise TransportError("Camera closed the CS2 session")
        except asyncio.CancelledError:
            raise
        except (OSError, EOFError, asyncio.IncompleteReadError, TimeoutError):
            self._fail(TransportError("Camera connection ended or timed out"))
        except (ProtocolError, TransportError) as err:
            self._fail(err)

    def _handle_ack(self, packet: bytes) -> None:
        if len(packet) < 8 or packet[4] != ACK or packet[5] != 0 or self._ack is None:
            return
        count = struct.unpack_from(">H", packet, 6)[0]
        if len(packet) != 8 + count * 2:
            return
        expected, event = self._ack
        if any(struct.unpack_from(">H", packet, 8 + i * 2)[0] == expected for i in range(count)):
            event.set()

    def _fail(self, error: Exception) -> None:
        self._error = error
        for channel in self._channels.values():
            channel.close()
        if self._ack is not None:
            self._ack[1].set()

    async def _keepalive(self) -> None:
        try:
            while not self._closed and self._error is None:
                await asyncio.sleep(1)
                await self._send(message(0xE0))
        except asyncio.CancelledError:
            raise
        except (OSError, TimeoutError, TransportError):
            self._fail(TransportError("Camera keepalive failed"))

    async def write_command(self, command: int, data: bytes) -> None:
        async with self._command_lock:
            seq = self._sequence
            self._sequence = (seq + 1) & 0xFFFF
            packet = marshal_command(seq, command, data)
            if self.protocol == "cs2+tcp":
                await self._send(packet)
                return
            event = asyncio.Event()
            self._ack = (seq, event)
            try:
                for _ in range(5):
                    await self._send(packet)
                    try:
                        await asyncio.wait_for(event.wait(), 1)
                    except TimeoutError:
                        continue
                    if self._error:
                        raise self._error
                    return
                raise TransportError("Camera did not acknowledge the CS2 command")
            finally:
                self._ack = None

    async def read_channel(self, channel: int, timeout: float | None = 15) -> bytes:
        try:
            packet = await asyncio.wait_for(self._channels[channel].queue.get(), timeout)
        except TimeoutError:
            raise TransportError("Camera media or command response timed out") from None
        if packet is None:
            raise self._error or TransportError("Camera connection closed")
        return packet

    async def close(self) -> None:
        if self._closed:
            return
        if self._error is None and (self._writer is not None or self._udp is not None):
            with suppress(OSError, TimeoutError, TransportError):
                await self._send(message(0xF0))
        self._closed = True
        current = asyncio.current_task()
        tasks = [task for task in self._tasks if task is not current]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._udp is not None:
            self._udp.close()
        if self._writer is not None:
            self._writer.close()
            with suppress(OSError, TimeoutError):
                await asyncio.wait_for(self._writer.wait_closed(), 2)
        for channel in self._channels.values():
            channel.close()
