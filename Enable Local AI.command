#!/bin/bash
cd "$(dirname "$0")" || exit 1
local_ai_node=''
for local_ai_candidate in .runtime/node-*-darwin-*/node; do
  if [ -x "$local_ai_candidate" ]; then local_ai_node="$local_ai_candidate"; break; fi
done
if [ -z "$local_ai_node" ] && command -v node >/dev/null 2>&1; then local_ai_node="$(command -v node)"; fi
if [ -z "$local_ai_node" ]; then
  echo 'Open Start World.command first to install Node, then run this installer again.'
  exit 1
fi
"$local_ai_node" scripts/install-local-ai.mjs
local_ai_exit=$?
echo 'Press Return to close this window.'
read -r
exit "$local_ai_exit"
