#!/usr/bin/env bash
# Start Desktop Commander Hub + Device as a local 1-1 stack on macOS/Linux
# Usage: ./start-local.sh

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_DIR="$ROOT/hub"
DEVICE_DIR="$ROOT/device"

HUB_CONFIG_DIR="${HOME}/.desktop-commander-hub"
KEYS_FILE="${HUB_CONFIG_DIR}/api-keys.json"

# Ensure hub is built
if [ ! -f "$HUB_DIR/dist/index.js" ]; then
    echo "Building hub..."
    (cd "$HUB_DIR" && npm run build)
fi

# Ensure device is built
if [ ! -f "$DEVICE_DIR/dist/index.js" ]; then
    echo "Building device..."
    (cd "$DEVICE_DIR" && npm run build)
fi

# Read or create API key
API_KEY=""
if [ -f "$KEYS_FILE" ]; then
    API_KEY=$(python3 -c "import json; print(json.load(open('$KEYS_FILE'))[0]['key'])" 2>/dev/null || true)
fi

if [ -z "$API_KEY" ]; then
    echo "No API key found. Starting hub once to generate it..."
    (cd "$HUB_DIR" && node dist/index.js &)
    HUB_PID=$!
    sleep 3
    kill $HUB_PID 2>/dev/null || true
    API_KEY=$(python3 -c "import json; print(json.load(open('$KEYS_FILE'))[0]['key'])" 2>/dev/null || true)
fi

echo "========================================"
echo "Desktop Commander Local 1-1 Stack"
echo "========================================"
echo "Hub API Key: $API_KEY"
echo "Hub SSE:     http://localhost:3000/sse"
echo "Device:      $(hostname)-local"
echo "========================================"

# Start hub in background (single-port mode)
(cd "$HUB_DIR" && PORT=3000 PUBLIC_URL="${PUBLIC_URL:-https://hub.pkking.computer}" OAUTH_ACCESS_TOKEN_TTL_SECONDS="${OAUTH_ACCESS_TOKEN_TTL_SECONDS:-2592000}" node dist/index.js &)
HUB_PID=$!

# Give hub time to start
sleep 2

# Start device pointing to local hub
export DC_HUB_URL="ws://localhost:3000"
export DC_HUB_API_KEY="$API_KEY"
export DC_DEVICE_ID="$(hostname)-local"
export DC_DEVICE_NAME="$(hostname) Local"
export DC_HOME_DIR="${DC_HOME_DIR:-$HOME}"

cleanup() {
    echo ""
    echo "Shutting down hub (PID $HUB_PID)..."
    kill $HUB_PID 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT

(cd "$DEVICE_DIR" && node dist/index.js)
