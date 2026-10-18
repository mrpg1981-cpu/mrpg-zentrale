#!/bin/sh
# MRPG Zentrale starten (Linux / CachyOS / macOS)
cd "$(dirname "$0")"
NODE=./runtime/node/bin/node; [ -x "$NODE" ] || NODE=node
command -v "$NODE" >/dev/null 2>&1 || { echo "Node.js fehlt – installieren (pacman -S nodejs npm) oder nach runtime/node entpacken."; exit 1; }
[ -d node_modules ] || { echo "> Erster Start: installiere Pakete …"; npm install --omit=dev || exit 1; }
exec "$NODE" server.js "$@"
