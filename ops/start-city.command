#!/bin/bash
# Installed beside play.sh: start the saved local city and open the game.
set -euo pipefail
PLAY="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$PLAY/play.sh" ]; then
  echo "This launcher must be installed beside NemoWorld's play.sh."
  exit 1
fi
if ! curl --fail --silent --max-time 3 http://127.0.0.1:3100/api/v1/health >/dev/null || ! lsof -nP -iTCP:14004 -sTCP:LISTEN >/dev/null 2>&1; then
  "$PLAY/play.sh" start --no-model
fi
open 'http://127.0.0.1:3100/city'
if [ -d "$PLAY/Harr.app" ]; then open "$PLAY/Harr.app"; else "$PLAY/play.sh" client; fi
echo 'Use your existing Veloren character. Visit the city from the city page after linking it once.'
