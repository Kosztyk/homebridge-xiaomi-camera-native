# Homebridge Xiaomi Camera Native

Direct Xiaomi **MISS over CS2** cameras for Homebridge, by **Kosztyk**.

This plugin ports the protocol in Xiaomi Camera Native for Home Assistant
0.3.0 to Node.js, with address recovery adapted from version 0.3.7. It connects
to the camera on your LAN and exposes a real
HomeKit camera with live video and snapshots. It does not need Home Assistant,
go2rtc, Python, a separate container, or Xiaomi's native camera SDK at runtime.

**Version 1.0.2 adds automatic IP recovery.** Automated tests exercise the original
Python camera emulator, real Homebridge 1.11.1 and 2.4.0 classes, and real
FFmpeg decoding, including encrypted SRTP output. This Node.js implementation
has not yet been tested against physical cameras or paired with an iPhone.
The account flows have simulated HTTP tests; the first live Xiaomi account
login also needs verification on your installation.

## Features

- Per-camera HomeKit setup codes, QR codes, copy buttons and pairing status.
- Xiaomi account setup inside the Homebridge plugin settings.
- Password sign-in, CAPTCHA and supported email/SMS verification steps.
- Existing numeric account ID and **account passToken** sign-in.
- China, Europe, India, Russia, Singapore and US account regions.
- Camera discovery, selection, exclusions, name and local IP overrides.
- Automatic recovery and persistence of verified camera IP changes.
- Native Node.js CS2 UDP/TCP negotiation, sequencing, ACKs and encryption.
- H.264 and H.265 source video converted to H.264 for HomeKit.
- JPEG snapshots, request coalescing and a short snapshot cache.
- Up to two HomeKit viewers per camera.
- One shared camera connection for video, snapshots and motor controls.
- Four momentary pan/tilt controls for the supported motorized models.
- On-demand video with an adjustable idle timeout and bounded reconnects.

Audio, two-way talk, motion events, SD-card access, zoom, presets and **HomeKit
Secure Video recording** are not included. These are live-view HomeKit cameras,
not HKSV recording cameras. The plugin does not publish an RTSP server.

## Requirements

- Node.js **22.12 or newer in the 22.x series**, 24.x or 26.x.
- Homebridge 1.8+ or 2.x. The development checks used 1.11.1 and 2.4.0 on Node 24.
- FFmpeg with `libx264` and H.265 decoding. A compatible optional FFmpeg package
  is requested during installation; an existing `ffmpeg` on PATH is the fallback.
- The same Xiaomi account and region used in Mi Home.
- Direct LAN access from Homebridge to each camera.
- Internet access to Xiaomi for account login and fresh camera session keys.

Video stays on the LAN. The Xiaomi cloud is still needed for authentication
and connection provisioning. Do not forward the camera ports to the internet.
CS2 starts with UDP port **32108**, then uses the negotiated UDP or TCP port.
HomeKit also needs its usual local accessory and UDP streaming connectivity.

On Debian/Ubuntu, system FFmpeg can be installed with:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg
```

## Install the supplied package

Copy `homebridge-xiaomi-camera-native-1.0.2.tgz` onto your Homebridge host, then
install it with the Node/npm installation used by Homebridge:

```sh
sudo npm install -g ./homebridge-xiaomi-camera-native-1.0.2.tgz
```

For your packaged Homebridge installation, use its bundled npm and plugin directory:

```sh
export PATH="/opt/homebridge/bin:$PATH"
npm install --prefix /var/lib/homebridge /tmp/homebridge-xiaomi-camera-native-1.0.2.tgz
hb-service restart
```

The supplied installer also detects this packaged Homebridge layout.
If your Homebridge installation is managed under a different npm prefix, use
that installation's plugin installation mechanism and the same TGZ.

1. Restart Homebridge so its UI can find the new plugin.
2. Open **Plugins → Homebridge Xiaomi Camera Native → Settings**.
3. Select the same region as Mi Home. For a European account, use **Europe (`de`)**.
4. Sign in, completing any CAPTCHA or supported email/SMS code challenge.
5. Select your cameras. Leave **Automatically update IP** checked for DHCP recovery.
6. Click **Save settings**, then restart Homebridge.
7. Pair each camera separately in Apple Home, as described below.

This 1.0.2 update is supplied for local installation. Publishing this update to
npm or GitHub is a separate step.

### Pair each camera with Apple Home

Cameras are published as **external accessories**, which is Homebridge's
camera accessory mechanism. Adding only the main Homebridge bridge does not
automatically pair these cameras.

After installing this update, restart Homebridge and reopen the plugin's
settings. The **Add cameras to Apple Home** section shows each running camera's
name, HomeKit code, QR code, **Copy code** button and pairing status. Use
**Refresh pairing details** after restarting or pairing a camera.

On a second screen, scan that camera's QR code in Apple Home. On the same
phone, choose **Add Accessory → More Options**, select the camera by name and
enter its displayed code. Repeat for each selected camera. An **Already paired**
label means Homebridge has a saved HomeKit pairing for that camera; another
pairing is not needed. Existing pairings and accessory identities are preserved.

Pairing details are available even if Xiaomi account login needs attention.
They come from the actual camera's HomeKit records, so child-bridge codes and
the camera's own QR setup ID are honored. QR images are generated on the
Homebridge host. No camera stream or Xiaomi cloud request is opened to show
pairing details. After changing your camera selection, save, restart Homebridge
and refresh the list.

The code and QR appear once Homebridge has published the camera. Until then,
the settings show a starting/restart message. The same account, region and
Xiaomi device ID produce a stable accessory UUID across restarts.

For a first test, close the corresponding Mi Home live view and stop the old
Home Assistant/go2rtc stream for that camera. Some cameras limit simultaneous
MISS sessions. Test one camera before enabling several.

## Supported camera targets

| Camera | Xiaomi model | Default source quality |
| --- | --- | --- |
| Mi 360 Home Security Camera 2K | `chuangmi.camera.029a02` | HD / 2 |
| Xiaomi Smart Camera C200 | `chuangmi.camera.046c04` | HD / 3 |
| Xiaomi Smart Camera C301 | `mxiang.camera.c301` | Automatic / 0 |

These targets come from the supplied Home Assistant integration; physical
compatibility of this Homebridge port still needs confirmation. Other cameras
that offer CS2 through Xiaomi's MISS provisioning may work. A camera returned
by account discovery is not by itself evidence of CS2 support. TUTK, Agora,
MTP and legacy camera protocols are unsupported and produce a clear error.

## Pan and tilt

Supported motorized cameras expose **Pan Left**, **Pan Right**, **Tilt Up** and
**Tilt Down** as momentary switch controls belonging to the camera accessory.
Each activation sends one discrete motor step and resets the switch to off.
These controls use the existing connection while video is playing. When idle,
the plugin opens a short control-only connection without starting an encoder.

Apple Home does not provide a directional-button extension in its live camera
player. These controls are accessory controls; they are not arrows overlaid on
Apple's video player. Their presentation and grouping depend on the Home app.
They may also be used in scenes and automations.

The MISS command requests one step rather than continuous movement. There is
no separate stop action. Busy movements are rejected and a failed action is
not replayed on a new connection. UDP retransmission uses the same sequence
number for delivery. Transport delivery does not confirm physical movement or
position on every camera firmware.

## Camera IP changes and source quality

**Automatically update IP** is enabled by default for each camera, including
existing configurations. The saved IPv4 address is a starting address in this
mode. After a failed connection, the plugin tries a newly discovered address
for the same Xiaomi device ID and model, and checks the MAC when both records
have one. Each address gets fresh camera session keys. A new IP becomes the
remembered address only after successful camera authentication.

Working addresses are saved privately per Xiaomi account and region under
`xiaomi-camera-native/addresses-<account-hash>.json` in Homebridge storage. They
survive restarts. Reopen or refresh the plugin settings to see the verified IP.
Recovery does not rewrite `config.json`, restart Homebridge, or change HomeKit
pairings. A healthy shared camera connection remains open during discovery.

Cloud recovery is shared across cameras and limited to one refresh per
30 seconds, including failures, with a 10-second discovery timeout. Automatic
sessions continue retrying with backoff while video is requested, so a longer
router outage does not exhaust the old four-attempt limit. A later snapshot,
live view or pan/tilt request can also initiate recovery. Failed motor commands
are not replayed.

The Home Assistant version can additionally use its router `device_tracker`
entities. Homebridge has no equivalent tracker data in this plugin, so this
port relies on Xiaomi reporting the new local IP. If that information is stale,
enter the current IP or reserve an address on the router. To keep a deliberate
fixed address, enter it and uncheck **Automatically update IP**, then save and
restart Homebridge.

**Source quality** is saved per camera and restored when settings reopen. All
nine choices (`auto`, `hd`, `sd`, and `0`–`5`) are retained during IP recovery.
Save and restart Homebridge after changing source quality; recovery itself
does not change it. Source quality selects the camera input, while the output
height setting limits the video delivered to HomeKit.

## Video, startup time and CPU

The default maximum is **1280×720 at 20 fps**, H.264, up to 1500 kbit/s. Lower
resolution sources are not upscaled. HomeKit negotiates the actual output
size, frame rate, profile, level, bitrate and packet size within these caps.
Both H.264 and H.265 camera feeds are encoded with `libx264` so that negotiated
HomeKit settings can be honored. Hardware encoding and stream copy are not
implemented in this version.

Each HomeKit viewer has an FFmpeg encoder, while all viewers and snapshots
share the one Xiaomi connection. Snapshots briefly run a separate FFmpeg
decoder; identical concurrent requests are coalesced. Video starts on demand
and normally stops **15 seconds** after the last consumer disconnects. Apple
Home's automatic thumbnail requests also count as consumers.

A cold start includes cloud provisioning, the LAN handshake and waiting for a
keyframe. Warm consumers can reuse a bounded recent keyframe buffer. To keep a
connection warm longer, raise **Stop after idle** to e.g. 60–300 seconds. This
also keeps receiving camera video longer. CPU use rises with the number of
simultaneous viewers; use 480p/360p and 15 fps when needed.

## Manual configuration

The UI saves an opaque `authId` in `config.json`. The reusable account/session
credentials are stored separately under your Homebridge storage directory in
`xiaomi-camera-native/account-<authId>.json`, with mode 0600. Passwords are not
saved. Treat that account file as a secret and do not publish it.

Without the custom UI, configure an account ID and **account passToken**:

```json
{
  "platform": "XiaomiCameraNative",
  "name": "Xiaomi Camera Native",
  "region": "de",
  "userId": "YOUR_NUMERIC_XIAOMI_ACCOUNT_ID",
  "passToken": "YOUR_ACCOUNT_PASSTOKEN",
  "maxHeight": 720,
  "exposePanTilt": true,
  "cameras": []
}
```

This manual method stores the passToken in `config.json`; keep that file
private. The passToken is an account credential, not a camera device token.
An account may require interactive sign-in again when that credential expires.

An empty camera array means discover all cameras by default. Placeholder rows
without `did` are ignored; no such rows are generated by the UI. For selection
of only specific IDs, use `includeOnlyConfigured: true` and supply those IDs:

```json
{
  "includeOnlyConfigured": true,
  "cameras": [
    {
      "did": "YOUR_CAMERA_DEVICE_ID",
      "host": "192.168.68.97",
      "autoUpdateIp": true,
      "name": "Living Camera",
      "quality": "hd",
      "transport": "auto",
      "exclude": false
    }
  ]
}
```

The fragment above is merged into your existing platform config. Set
`exclude: true` to omit a camera. With `includeOnlyConfigured: true`, an empty
array intentionally publishes no cameras. Change selections in the UI and
restart Homebridge to apply them. Remove excluded cameras from Apple Home if
you previously paired them; selection does not delete HomeKit pairings.

Additional options are documented in `config.schema.json`. `ffmpegPath`
accepts an executable path, not a shell command. Source quality accepts `auto`,
`sd`, `hd`, or string values `0`–`5`. Source HD does not override the HomeKit
output height cap.

## Troubleshooting

- **Not in Home:** pair the external camera itself, in addition to the main bridge.
- **Account has no cameras:** check the Xiaomi account and region in Mi Home.
- **Missing IP / handshake timeout:** leave **Automatically update IP** enabled
  and confirm Homebridge can reach the camera directly. If Xiaomi still reports
  an old address, enter the current camera IPv4 address and restart Homebridge.
  Automatic transport is preferred.
- **Unsupported CS2 vendor:** this camera uses a different protocol; changing
  its IP or video quality cannot add support for it.
- **Account expired:** sign in again in the plugin settings, save and restart.
- **No video / snapshot timeout:** close other camera sessions, check FFmpeg
  with `ffmpeg -encoders` and ensure `libx264` is available.
- **CPU use:** lower the output height, fps or concurrent viewer count.
- **Slow first image:** cold setup takes longer; try a longer idle timeout and
  compare opening a warm view. Physical startup performance is not measured yet.

Debug logging reports connection failures without account tokens. FFmpeg
arguments/stderr are deliberately not logged because they can contain private
source URLs or HomeKit encryption keys.

## Development and publishing

The source archive includes runtime code, the custom setup UI, metadata,
LICENSE/NOTICE, lockfile, example config, CI checks and tests. Runtime code is
plain CommonJS JavaScript and needs no compilation.

```sh
npm ci
npm run check
# Python is used only by the independent development-test camera emulator.
python3 -m pip install -r requirements-test.txt
npm test
npm pack
```

Tests also need system `ffmpeg` and `ffprobe`. See `VALIDATION.md` for the
executed checks and remaining hardware verification. To publish from your own
checkout, create the repository named in `package.json`, sign into npm with
the account that should own the package, and run `npm publish`. Author metadata
does not transfer npm package ownership. The repository/package are not created
or published automatically by this source archive.

## License

MIT. Copyright (c) 2026 Kosztyk. Protocol adaptations include code originally
by Alexey Khit / AlexxIT/go2rtc. See `LICENSE` and `NOTICE`. go2rtc is credited
as a protocol source; no go2rtc program is installed or executed.
