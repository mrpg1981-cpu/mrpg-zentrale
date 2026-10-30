#!/usr/bin/env bash
cd "$(dirname "$0")"
nohup python3 pc_scanner.py --serve "$@" >/dev/null 2>&1 &
disown
echo "Scanner laeuft im Hintergrund, der Browser oeffnet sich gleich."
