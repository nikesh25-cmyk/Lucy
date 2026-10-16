#!/bin/bash
cd "$(dirname "$0")" || exit 1
bash scripts/start-mac.sh
local_world_exit=$?
echo 'Press Return to close this window.'
read -r
exit "$local_world_exit"
