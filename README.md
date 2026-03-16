# Desktop Commander Remote (Self-Hosted)

Replicates [mcp.desktopcommander.app](https://mcp.desktopcommander.app) on your own infrastructure via Tailscale — no cloud dependency, no OAuth, no Supabase.

## Architecture

```
[Claude Desktop / ChatGPT]
        | MCP over SSE (:3000)
        v
[Hub Server]  <-- WebSocket (:3001, Tailscale) -->  [Device Client]
  - MCP SSE server                                    - Bridges local Desktop Commander
  - WebSocket relay                                   - Executes tool calls locally
  - API key auth                                      - Returns results to hub
  - Device registry
```

**vs. original mcp.desktopcommander.app:**
- No Supabase dependency -> Pure WebSocket relay
- No OAuth flow -> Simple API key auth
- No cloud lock-in -> Runs on Pi, any VM, or Docker

**Hub can run anywhere:**
- Raspberry Pi (current: `pk@100.71.124.50` via Tailscale)
- Any cloud VM (GCP, AWS, Hetzner) with a Tailscale sidecar container
- Local machine for development

---

## Quick Start

### Pi / Linux Hub (systemd, no Docker)

```bash
cd deploy
pip install -r requirements.txt

# First-time full deploy to Pi
fab -H pk@100.71.124.50 deploy

# Show hub URL + API key
fab -H pk@100.71.124.50 show-config
```

### Cloud VM Hub (Docker + Tailscale sidecar)

```bash
# On the remote host — copy hub/ directory first
cd hub

# Create .env from example and fill in your Tailscale auth key
cp .env.example .env
# Edit .env: set TS_AUTHKEY=tskey-auth-...

# Start hub + Tailscale sidecar
docker compose --profile cloud up -d

# Or use Fabric
fab -H user@host deploy-docker
```

### Local / Pi with Docker

```bash
cd hub
docker compose --profile local up -d   # uses host Tailscale, no sidecar
```

---

## Device Registration

### Windows (Scheduled Task at Logon)

```powershell
# From repo root — run once in an elevated terminal
powershell -File deploy\register-windows.ps1
```

This registers a `DC-Remote-Device` scheduled task that starts the device client at logon.
The device client reads credentials from `device\.env`.

`device\.env`:
```
DC_HUB_URL=ws://100.71.124.50:3001
DC_HUB_API_KEY=<your-api-key>
DC_DEVICE_ID=my-windows-pc
DC_DEVICE_NAME=My Windows PC
```

### Mac / Linux (launchd / systemd)

```bash
# From deploy/ directory
fab -H k@100.76.176.119 deploy-device   # Mac (launchd)
fab -H user@host deploy-device          # Linux (systemd)
```

First-time SSH key setup (run once on the Mac):
```bash
echo 'ssh-ed25519 AAAA... your-public-key' >> ~/.ssh/authorized_keys
```

---

## Connect an AI Client

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "desktop-commander-remote": {
      "type": "sse",
      "url": "http://100.71.124.50:3000/sse"
    }
  }
}
```

---

## Directory Structure

```
.
├── hub/                    Node.js hub server
│   ├── src/
│   │   ├── index.ts            Express + WebSocket + MCP server
│   │   ├── device-registry.ts  Manages connected devices + routes tool calls
│   │   ├── auth.ts             API key management
│   │   └── types.ts            Protocol types
│   ├── Dockerfile              Multi-stage node:22-alpine build
│   ├── docker-compose.yml      Profiles: cloud (+ Tailscale sidecar), local (host network)
│   ├── .env.example            TS_AUTHKEY, TS_HOSTNAME, HUB_NETWORK_MODE
│   └── .dockerignore
│
├── device/                 Device client (runs on each machine)
│   ├── src/
│   │   ├── index.ts            Entry point, loads .env
│   │   ├── device-client.ts    WebSocket connection + tool call handler
│   │   ├── dc-integration.ts   Bridges to local Desktop Commander MCP
│   │   └── types.ts
│   └── .env                    DC_HUB_URL, DC_HUB_API_KEY, DC_DEVICE_ID, DC_DEVICE_NAME
│
└── deploy/                 Fabric deployment scripts
    ├── fabfile.py              All deployment tasks (hub, device, docker)
    ├── config.py               Host constants
    ├── register-windows.ps1    Windows scheduled task registration
    └── requirements.txt
```

---

## Fabric Tasks

### Hub (Pi / Linux)

| Command | Description |
|---------|-------------|
| `fab -H pk@100.71.124.50 deploy` | First-time full deploy (Node, deps, build, systemd) |
| `fab -H pk@100.71.124.50 update` | Push code changes + restart |
| `fab -H pk@100.71.124.50 status` | Check systemd service health + connected devices |
| `fab -H pk@100.71.124.50 logs` | Tail live hub logs |
| `fab -H pk@100.71.124.50 restart` | Restart hub service |
| `fab -H pk@100.71.124.50 show-config` | Print hub URL, WebSocket URL, API key |
| `fab -H pk@100.71.124.50 create-key` | Generate a new API key |

### Device

| Command | Description |
|---------|-------------|
| `fab -H user@host deploy-device` | Deploy device client (Mac/Linux, auto-detects launchd vs systemd) |
| `fab -H user@host device-logs` | Tail device client logs |
| `fab setup-windows` | Print Windows setup instructions |

### Docker (Cloud)

| Command | Description |
|---------|-------------|
| `fab -H user@host deploy-docker` | Push hub source + start Docker Compose (cloud profile) |
| `fab -H user@host docker-update` | Rebuild and restart containers |
| `fab -H user@host docker-logs` | Tail hub container logs |
| `fab -H user@host docker-status` | Show container status |

---

## Docker — Cloud Deployment Detail

`hub/docker-compose.yml` has two profiles:

**`cloud`** — hub + Tailscale sidecar (for any cloud VM):
```yaml
services:
  tailscale:   # sidecar: gets a Tailscale IP for the VM
  hub:         # shares Tailscale's network namespace
    network_mode: service:tailscale
```
The hub is reachable via the VM's Tailscale IP. No public ports needed.

**`local`** — hub only with `network_mode: host` (for Pi, uses host's Tailscale interface).

Required `.env` for cloud mode:
```
TS_AUTHKEY=tskey-auth-...    # from https://login.tailscale.com/admin/settings/keys
TS_HOSTNAME=dc-remote-hub
PORT=3000
WS_PORT=3001
```

---

## Multi-Device Support

When multiple devices are connected, tools are prefixed with the device ID:
- `windows-pc_read_file`, `windows-pc_write_file`
- `mac-mini_read_file`, `mac-mini_write_file`

With a single device connected, no prefix — tools appear directly.

---

## Ports

| Port | Purpose |
|------|---------|
| 3000 | MCP SSE server (AI clients — Claude Desktop, ChatGPT, etc.) |
| 3001 | WebSocket server (device clients connect here) |

Both are accessible via Tailscale. Do **not** expose to the public internet without a TLS reverse proxy (Nginx/Caddy) in front.

---

## Network (Current Setup)

| Node | Tailscale IP | Role | Status |
|------|-------------|------|--------|
| Pi (pk-jim2) | 100.71.124.50 | Hub | Running |
| MSI (Windows) | 100.xx.xx.xx | Device | Connected (26 tools) |
| Mac Mini | 100.76.176.119 | Device | Pending SSH key |
