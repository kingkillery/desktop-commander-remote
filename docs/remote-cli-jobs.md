# Remote CLI Jobs

Desktop Commander Remote now has two command execution modes.

## One-Shot Tool Calls

Existing Desktop Commander MCP tools still work through the hub. An AI client calls a tool on `/sse`, the hub routes the request to the connected device over WebSocket, and the device forwards it to the local Desktop Commander MCP server.

Use this for short, request/response operations.

## Managed Jobs

Managed jobs are for CLI work that needs status, tailing, cancellation, or operator visibility.

MCP tools:
- `job_start` - start a command on a connected device.
- `job_status` - fetch the latest summary for a job.
- `job_tail` - read recent stdout and stderr.
- `job_cancel` - stop a running job.
- `job_list` - list jobs known by the hub.

REST endpoints use the same bearer API key style as the existing `/tools` endpoints:
- `GET /jobs`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/events`
- `POST /jobs/start`
- `POST /jobs/:jobId/cancel`

Safety defaults:
- Device jobs spawn with `windowsHide: true` on Windows.
- Output is bounded in memory on the device.
- Jobs have a default timeout.
- API-key auth protects REST and MCP access.
- Cancellation stops the process tree on Windows via `taskkill`.
- Jobs require an approved `cwd` from the directory picker or an explicit approved path.

## Directory Picker Mode

The hub exposes safe directory tools for ChatGPT and other MCP clients:
- `directory_roots` returns the approved root directories.
- `directory_list` browses child directories on the connected device.
- `directory_select` sets the current MCP session working directory.
- `directory_current` reports the current selected directory.

Only these roots are available:
- `C:\Users\prest`
- `C:\dev`
- `C:\Users\prest\Desktop\SPWR-Daily\Interconnection-Dash-2026\.artifacts`

Desktop Commander command calls and managed jobs are rejected unless their working directory is within those roots. File path arguments are normalized to approved absolute Windows paths before they reach the device.

## Ruflo Autopilot Loop Mode

Autopilot should treat job control as observable work, not fire-and-forget execution.

Recommended loop:
1. Pick the next unchecked file-checklist item from `.prd/remote-cli-jobs-orchestration.md` or `.prd/remote-cli-jobs-acceptance.md`.
2. Start long-running commands with `job_start`.
3. Poll `job_status` until the job exits, fails, times out, or needs operator attention.
4. Use `job_tail` for concise progress reports.
5. Use `job_cancel` when the loop predicts the command is stuck or no longer relevant.
6. Log progress and schedule the next iteration on the Ruflo autopilot cadence.

This mode keeps the device headless while giving the hub enough state for autonomous progress reporting.
