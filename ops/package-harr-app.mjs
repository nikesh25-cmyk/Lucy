// Wrap an already built local client; no downloads, builds, credentials or new world.
import { copyFileSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function packageHarrApp(directory) {
  const root = resolve(directory), app = join(root, 'play/Harr.app');
  const binary = join(root, 'wt/target/integ/release/veloren-voxygen');
  if (!statSync(binary).isFile() || !statSync(join(root, 'wt/veloren-integ/assets')).isDirectory()) throw Error('Built client and assets required.');
  if (existsSync(app)) throw Error('Harr.app already exists; preserve it before creating another package.');
  mkdirSync(app); mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  copyFileSync(binary, join(app, 'Contents/MacOS/veloren-voxygen'));
  chmodSync(join(app, 'Contents/MacOS/veloren-voxygen'), 0o755);
  writeFileSync(join(app, 'Contents/MacOS/Harr'), `#!/bin/sh
set -e
APP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLAY="$(cd "$APP_ROOT/.." && pwd)"
ROOT="$(cd "$PLAY/.." && pwd)"
"$PLAY/Start NemoWorld City.command" --prepare-only
export VELOREN_ASSETS="$ROOT/wt/veloren-integ/assets"
export VELOREN_USERDATA="$PLAY/userdata"
cd "$ROOT/wt/veloren-integ" || exit 1
exec "$APP_ROOT/Contents/MacOS/veloren-voxygen" "$@"
`, { mode: 0o755 });
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.nemoworld.harr</string>
<key>CFBundleName</key><string>Harr</string>
<key>CFBundleDisplayName</key><string>Harr — NemoWorld</string>
<key>CFBundleExecutable</key><string>Harr</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw Error('Usage: node package-harr-app.mjs LYRA_INTEGRATION_ROOT');
  console.log(packageHarrApp(process.argv[2]));
}
