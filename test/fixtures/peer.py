"""Drive the original Python camera emulator from Node.js over JSON lines."""
import asyncio
import json
import re
import sys
from pathlib import Path
from emulator import CameraEmulator

async def main():
    transport, codec, fixture = sys.argv[1:]
    codec = int(codec)
    data = Path(fixture).read_bytes()
    aud = b'\x09' if codec == 4 else b'\x46\x01'
    starts = [m.start() for m in re.finditer(b'\x00\x00\x00?\x01' + aud, data)]
    starts[0] = 0
    frames = [data[a:b] for a, b in zip(starts, starts[1:] + [len(data)])]
    camera = await CameraEmulator(frames, codec=codec, tcp=transport == 'tcp', reorder=True).start()
    provision = camera.provisioning()
    print(json.dumps({'port':camera.port,'public':provision.public.hex(),'private':provision.private.hex(),'devicePublic':provision.device_public.hex(),'signature':provision.signature}), flush=True)
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line or line.strip() == 'close':
                break
            print(json.dumps({'authentications':camera.authentications,'mediaStarts':camera.media_starts,'quality':camera.video_quality,'operations':camera.motor_operations,'pings':camera.pings}),flush=True)
    finally:
        await camera.close()

asyncio.run(main())
