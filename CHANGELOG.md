# Changelog

## 1.0.1 — 2026-10-18

- Show each published camera's actual HomeKit code, QR code and paired status in plugin settings.
- Copy pairing codes, with a selection fallback when clipboard access is unavailable.
- Refresh pairing details without signing into Xiaomi or opening a camera stream.
- Preserve existing HomeKit camera identities and pairings.
- Detect bundled Node/npm in the local installer for packaged Homebridge hosts.
- Test QR decoding against actual HAP setup payloads and saved pairing data.

## 1.0.0 — 2026-10-18

- Initial Homebridge port of Xiaomi Camera Native 0.3.0's direct MISS/CS2 protocol.
- Node.js cloud login, CAPTCHA/verification, token refresh and camera discovery.
- External HomeKit cameras with H.264 live video and JPEG snapshots.
- Default 720p output, shared Xiaomi connections and on-demand capture.
- Pan/tilt momentary controls for the three motorized camera targets.
- Homebridge account setup UI, selection and per-camera IP/transport overrides.
- Independent Python-peer, FFmpeg, SRTP and real Homebridge API tests.

Physical-camera, live-account and iPhone-pairing validation remain outstanding.
