#!/bin/sh
# Start unter Linux/macOS (Entwicklung): nutzt mitgelieferte Werkzeuge in tools/, falls vorhanden.
cd "$(dirname "$0")"
export MRPG_HOME="$(pwd)"
PY=python3; [ -x runtime/python/bin/python3 ] && PY=runtime/python/bin/python3
exec "$PY" app/main.py "$@"
