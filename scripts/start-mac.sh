#!/bin/bash
set -eu
local_world_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$local_world_root"

# Reuse a compatible installation. Everything else stays inside this project.
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
  exec node scripts/local-launch.mjs
fi
if [ "$(uname -s)" != Darwin ]; then
  echo 'This automatic runtime installer is for Mac. Install Node.js 24 or newer on this computer.' >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) local_world_arch=arm64 ;;
  x86_64)
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
      local_world_arch=arm64
    else
      local_world_arch=x64
    fi ;;
  *) echo 'This Mac architecture is unsupported.' >&2; exit 1 ;;
esac
local_world_version=v24.19.0
local_world_package="node-${local_world_version}-darwin-${local_world_arch}"
local_world_runtime="$local_world_root/.runtime/$local_world_package"
local_world_node="$local_world_runtime/node"
if [ ! -x "$local_world_node" ]; then
  echo 'Preparing a private Node.js runtime for Shared World. This first download needs Internet access.'
  mkdir -p "$local_world_root/.runtime"
  local_world_stage="$(mktemp -d "$local_world_root/.runtime/install.XXXXXX")"
  trap 'rm -rf "$local_world_stage"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  local_world_archive="$local_world_stage/$local_world_package.tar.gz"
  curl --fail --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "https://nodejs.org/dist/$local_world_version/$local_world_package.tar.gz" -o "$local_world_archive"
  # Pinned from the official HTTPS SHASUMS256.txt, checked 2026-10-11.
  case "$local_world_arch" in
    arm64) local_world_expected=8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d ;;
    x64) local_world_expected=d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316 ;;
  esac
  local_world_actual="$(shasum -a 256 "$local_world_archive" | awk '{print $1}')"
  if [ "$local_world_actual" != "$local_world_expected" ]; then
    echo 'The runtime checksum does not match. Setup stopped before extracting or running it.' >&2
    exit 1
  fi
  tar -xzf "$local_world_archive" -C "$local_world_stage" "$local_world_package/bin/node" "$local_world_package/LICENSE"
  mkdir -p "$local_world_runtime"
  cp "$local_world_stage/$local_world_package/LICENSE" "$local_world_runtime/LICENSE"
  chmod 755 "$local_world_stage/$local_world_package/bin/node"
  mv -f "$local_world_stage/$local_world_package/bin/node" "$local_world_node"
  rm -rf "$local_world_stage"
  trap - EXIT INT TERM
fi
exec "$local_world_node" scripts/local-launch.mjs
