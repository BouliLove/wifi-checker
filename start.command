#!/bin/bash
# WiFi Office Quality Checker — macOS Launcher
# Double-click this file to start the server and open the app.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8765

echo "==> WiFi Office Quality Checker"
echo "==> Stopping any process on port ${PORT}..."
lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null || true

echo "==> Starting HTTP server at http://localhost:${PORT}/"
cd "${SCRIPT_DIR}/.."
python3 -m http.server ${PORT} &
SERVER_PID=$!

sleep 0.8

echo "==> Opening browser..."
open "http://localhost:${PORT}/wifi-checker/index.html"

echo "==> Server running (PID ${SERVER_PID}). Close this window to stop."
wait ${SERVER_PID}
