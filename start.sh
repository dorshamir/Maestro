#!/usr/bin/env bash
# Run to start Maestro. Do not open public/index.html directly.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is required but was not found on PATH."; exit 1; }
exec node server.js
