#!/usr/bin/env bash
set -euo pipefail

installer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_archive="${1:-${installer_dir}/homebridge-xiaomi-camera-native-1.0.2.tgz}"

managed_homebridge=false
if [[ -x /opt/homebridge/bin/node && -f /opt/homebridge/bin/npm && -d /var/lib/homebridge ]]; then
  export PATH="/opt/homebridge/bin:$PATH"
  managed_homebridge=true
fi

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Node.js and npm must be installed for Homebridge." >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(!([22,24,26].includes(major)&&(major!==22||minor>=12))) { console.error("Use Node.js 22.12+, 24.x or 26.x."); process.exit(1); }'
if [[ ! -f "$package_archive" ]]; then
  echo "Package not found: $package_archive" >&2
  echo "Put the TGZ beside this script, or pass its full path as the first argument." >&2
  exit 1
fi

if [[ "$managed_homebridge" == true ]]; then
  npm install --prefix /var/lib/homebridge "$package_archive"
else
  npm install --global "$package_archive"
fi
echo "Installed Homebridge Xiaomi Camera Native 1.0.2."
echo "Restart Homebridge, open this plugin's settings, sign in, select cameras and save."
echo "Restart again, then reopen settings to see each camera's HomeKit code and QR code."
