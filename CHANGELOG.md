# Changelog

## 1.0.2 — 2026-10-18

- Recover camera IP changes using identity checks and connection retry behavior adapted from Home Assistant 0.3.7.
- Enable per-camera **Automatically update IP** by default; existing saved IPs become starting addresses. Disable it to keep a fixed address.
- Persist only successfully authenticated addresses in a private account-scoped cache and show them in plugin settings.
- Share and rate-limit recovery discovery, cancel it on timeout/shutdown, and retry longer router outages while video is requested.
- Keep healthy connections, HomeKit identities, pairing codes and Source quality selections during recovery.
- Verify every source quality saves and reopens in both automatic and fixed IP modes.

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
