# AGENTS.md — Desktop Commander Remote

## Canonical repository

**https://github.com/kingkillery/desktop-commander-remote**

This is the canonical fork of Desktop Commander Remote. All development,
issues, and pull requests should target this repository. The original upstream
is `wonderwhy-er/desktop-commander-remote`; changes are periodically evaluated
against upstream but the kingkillery fork is the source of truth for this
deployment.

---

## Repository layout

```
hub/          MCP hub server  (runs in the cloud / on a Pi)
device/       Device client   (runs on the local Windows machine)
mcp-client/   Lightweight REST → MCP bridge for simple callers
deploy/       Scheduled-task registration, tray controller, fabfile
docs/         Architecture notes
```

---

## Architecture overview

```
AI client (ChatGPT / Claude)
    │  MCP over SSE  (HTTPS)
    ▼
Hub server   ──  hub/src/index.ts
    │  WebSocket (single-port)
    ▼
Device client ── device/src/device-client.ts
    │  stdio MCP
    ▼
Desktop Commander (local MCP server)
```

The hub exposes MCP-over-SSE to AI clients and forwards tool calls over a
persistent WebSocket to whichever device client is registered.  The device
client spawns Desktop Commander as a child process and proxies its tools
through to the hub.

---

## Running locally (Windows)

```powershell
# One-shot: builds if needed, starts hub + device in a single terminal
.\start-local.ps1
```

### Scheduled tasks (production)

The tray controller (`deploy\tray-controller.ps1`) manages four tasks:

| Task name            | What it runs                         |
|----------------------|--------------------------------------|
| `DC-Remote-Hub`      | `node hub\dist\index.js`             |
| `DC-Remote-Device`   | `node device\dist\index.js`          |
| `DC-Remote-Cloudflared` | cloudflared tunnel                |
| `DC-Remote-Tray`     | System-tray status + control app     |

Register them once with `deploy\register-windows.ps1`.

---

## Build & test

```bash
# Hub
cd hub
npm run build     # tsc
npm test          # node:test via tsx (94 tests, no external deps)

# Device
cd device
npm run build
npm test          # node:test via tsx (26 tests)
```

All tests use Node.js built-in `node:test` + `node:assert/strict`.  No Jest,
no Mocha, no extra test-runner packages.

---

## Key environment variables

### Hub (`hub/.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP + WebSocket port (single-port mode) |
| `PUBLIC_URL` | — | Canonical public URL (e.g. `https://hub.pkking.computer`) |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `2592000` (30 d) | Token lifetime |
| `DEFAULT_APPROVED_DIRECTORY` | `C:\Users\prest\.mcporter` | Pre-selected cwd |
| `SSE_KEEPALIVE_INTERVAL_MS` | `30000` | SSE heartbeat interval |
| `DEFAULT_TOOL_TIMEOUT_MS` | `300000` | Per-tool call timeout |

### Device (`device/.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DC_HUB_URL` | `ws://localhost:3001` | Hub WebSocket URL |
| `DC_HUB_API_KEY` | — | **Required** — must match a hub API key |
| `DC_DEVICE_ID` | random UUID | Stable device identifier |
| `DC_DEVICE_NAME` | hostname | Display name shown in hub health |
| `DC_HOME_DIR` | `C:\dev\desktop-projects` | Default home for DC file ops |

---

## Directory policy (security)

Both hub and device enforce an `APPROVED_DIRECTORY_ROOTS` allowlist defined in
`hub/src/directory-policy.ts` and `device/src/directory-policy.ts`.

Current approved roots on this machine:

| ID | Label | Path |
|----|-------|------|
| `user_profile` | User profile | `C:\Users\prest` |
| `dev` | Development | `C:\dev` |
| `spwr_artifacts` | SPWR artifacts | `C:\Users\prest\Desktop\SPWR-Daily\Interconnection-Dash-2026\.artifacts` |

AI clients must call `directory_select` with an approved path before running
commands.  File path arguments are canonicalized and validated against these
roots on every call.

---

## Agent workspace

A dedicated agent workspace lives at `C:\Agent`:

```
C:\Agent\
  inbox\     Drop files here for the agent to process
  outbox\    Agent-produced output files
  scratch\   Temporary / experimental work
  projects\  Longer-lived agent-managed projects
  logs\      Agent session logs
```

Bootstrap a PowerShell session for agent work:

```powershell
. C:\Agent\agent-profile.ps1
```

---

## Test files

| File | Package | Tests | Covers |
|------|---------|-------|--------|
| `hub/src/auth.test.ts` | hub | 18 | AuthManager — keys, OAuth, tokens |
| `hub/src/cli-mcp-adapter.test.ts` | hub | 13 | CliMcpAdapter/Registry |
| `hub/src/device-registry.test.ts` | hub | 8 | DeviceRegistry |
| `hub/src/directory-policy.test.ts` | hub | 8 | Directory allowlist |
| `hub/src/index-helpers.test.ts` | hub | 36 | Inline hub helpers |
| `hub/src/oauth.test.ts` | hub | 7 | OAuth redirect/TTL |
| `hub/src/remote-cli-jobs.test.ts` | hub | 9 | HubJobRegistry, job tools |
| `device/src/device-client-helpers.test.ts` | device | 13 | Batching + tool decoration |
| `device/src/directory-policy.test.ts` | device | 6 | Device allowlist |
| `device/src/job-manager.test.ts` | device | 7 | DeviceJobManager |

---

## Hub API key

API keys are stored in `~/.desktop-commander-hub/api-keys.json`.  The hub
prints the first-run key to stdout on initial startup.  Use the tray's
"Set home directory" dialog or edit `.env` directly to configure the device.

---

## Cloudflare tunnel

The hub is exposed publicly via a named Cloudflare tunnel:

```
dc-hub-windows  →  http://localhost:3000
```

Tunnel config lives in `~/.cloudflared/`.  The `DC-Remote-Cloudflared`
scheduled task runs it headlessly.
