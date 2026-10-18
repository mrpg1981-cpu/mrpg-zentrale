#!/bin/sh
cd "$(dirname "$0")"
NODE=./runtime/node/bin/node; [ -x "$NODE" ] || NODE=node
exec "$NODE" server.js "$@"
