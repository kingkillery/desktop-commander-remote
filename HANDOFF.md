# Desktop Commander Remote — Handoff

> Generated: 2026-05-11  
> Hub: Mac Mini (`jims-Mac-mini`, `100.76.176.119`)  
> Device: MSI Windows (`msi-windows-main`, `100.93.214.66`)  

---

## Architecture

```
┌─────────────────────────────┐         Tailscale VPN          ┌─────────────────────────────┐
│  Mac Mini Hub               │ ◄────── WebSocket :3001 ─────► │  MSI Windows Device Client  │
│  100.76.176.119:3000/3001   │                                │  (Scheduled Task)           │
│  Node + Express + MCP SSE   │                                │  Node + DC stdio bridge     │
└─────────────────────────────┘                                └─────────────────────────────┘
           ▲                                                              │
           │ SSE /tools                                                 ▼
           │                                                    Desktop Commander
    Claude / Codex / MCP clients                                    (local MCP)
```

- **Port 3000**: HTTP health (`/health`), MCP SSE (`/sse`), REST tools (`/tools/*`)
- **Port 3001**: WebSocket device registrations (`/`) — devices connect here
- **Single-port mode**: Set `SINGLE_PORT=true` in hub `.env` to run everything on one port

---

## How to Stop

### 1. Windows Device Client

```powershell
# Stop scheduled task
Stop-ScheduledTask -TaskName "DC-Remote-Device"
Unregister-ScheduledTask -TaskName "DC-Remote-Device" -Confirm:$false

# Or kill the node process directly
Get-Process node | Where-Object {
    (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like "*device*"
} | Stop-Process -Force
```

### 2. Mac Mini Hub

```bash
# SSH to Mac Mini, then:
ssh <user>@100.76.176.119

# Find hub process
ps aux | grep "node.*hub"
# or
lsof -i :3000

# Kill it
kill <PID>
# or if using PM2
pm2 stop dcr-hub
pm2 delete dcr-hub
```

---

## How to Start

### 1. Start Hub (on Mac Mini)

```bash
cd ~/Desktop-Commander-Remote/hub   # or wherever the repo lives on the Mac
npm install                          # if needed
npm run build
node dist/index.js
```

Or with PM2 for persistence:
```bash
pm2 start dist/index.js --name dcr-hub --cwd ./hub
pm2 save
```

### 2. Start Device Client (on Windows)

**Option A — Scheduled Task (recommended for auto-start):**
```powershell
# Use the bundled script
.\deploy\register-windows.ps1
```

**Option B — Manual:**
```powershell
cd C:\dev\Desktop-Projects\Desktop-Commander-Remote\device
npm install   # if needed
npm run build
node dist\index.js
```

---

## Environment / Config

### Hub `.env` (Mac Mini)
```
PORT=3000
WS_PORT=3001
API_KEY=f212084b-6e26-4fde-84dd-eb2ae11817c5
SINGLE_PORT=false
```

### Device `.env` (Windows)
```
DC_HUB_URL=ws://100.76.176.119:3001
DC_HUB_API_KEY=f212084b-6e26-4fde-84dd-eb2ae11817c5
DC_DEVICE_ID=msi-windows-main
DC_DEVICE_NAME=MSI Windows Main
```

### `mcporter.json` (Windows, for Claude/Codex)
Located at: `C:\Users\prest\Desktop\SPWR-Daily\Interconnection-Dash-2026\config\mcporter.json`
```json
{
  "type": "sse",
  "url": "http://100.76.176.119:3000/sse?api_key=f212084b-6e26-4fde-84dd-eb2ae11817c5",
  "description": "Desktop Commander Remote hub on jims-Mac-mini"
}
```

---

## Quick Health Checks

```powershell
# Hub health
Invoke-RestMethod http://100.76.176.119:3000/health

# List tools via hub
Invoke-RestMethod http://100.76.176.119:3000/tools -Headers @{Authorization="Bearer f212084b-6e26-4fde-84dd-eb2ae11817c5"}

# Test tool call
$body = @{command="whoami";timeout_ms=5000} | ConvertTo-Json
Invoke-RestMethod http://100.76.176.119:3000/tools/start_process -Method POST -Headers @{Authorization="Bearer f212084b-6e26-4fde-84dd-eb2ae11817c5";"Content-Type"="application/json"} -Body $body
```

---

## Network / Tailscale

| Machine | Tailscale IP | Tailscale Name | Role |
|---------|-------------|----------------|------|
| Mac Mini | `100.76.176.119` | `jims-Mac-mini` | Hub |
| MSI Windows | `100.93.214.66` | `msi-1` | Device Client |
| Pi (offline) | `100.71.124.50` | `pk-jim2` | ~~Hub~~ |

- Pi `pk-jim2` has been offline since 2026-03-26. Mac Mini is the current fallback hub.
- All communication goes through Tailscale — no public ports exposed.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `ETIMEDOUT` on device | Hub down or wrong IP | Verify hub is running; check Tailscale connectivity |
| `0x8007010B` task error | Wrong path in scheduled task | Re-run `register-windows.ps1` or fix path manually |
| 0 tools registered | Desktop Commander not found | Install DC globally: `npm i -g @wonderwhy-er/desktop-commander` |
| SSE connection refused | Wrong API key | Check hub `.env` key matches `mcporter.json` |
| Task won't auto-start | Not configured for logon | `register-windows.ps1` sets `AtLogon` trigger |

---

## Repo Locations

- **Primary**: `C:\dev\Desktop-Projects\Desktop-Commander-Remote` (Windows)
- **Mac Mini**: `~/Desktop-Commander-Remote` (assumed — update if different)
- **GitHub**: `kingkillery/desktop-commander-remote` (master branch)
- **Interconnection-Dash-2026** (MCP config): `kingkillery/Interconnection-Dash-2026` (main branch)
