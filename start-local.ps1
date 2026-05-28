#!/usr/bin/env powershell
# Start Desktop Commander Hub + Device as a local 1-1 stack on Windows
# Usage: .\start-local.ps1

$ErrorActionPreference = "Stop"

# Resolve paths
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hubDir = Join-Path $root "hub"
$deviceDir = Join-Path $root "device"

# Hub config
$hubConfigDir = Join-Path $env:USERPROFILE ".desktop-commander-hub"
$keysFile = Join-Path $hubConfigDir "api-keys.json"

# Ensure hub is built
if (-not (Test-Path (Join-Path $hubDir "dist\index.js"))) {
    Write-Host "Building hub..."
    Push-Location $hubDir
    npm run build
    Pop-Location
}

# Ensure device is built
if (-not (Test-Path (Join-Path $deviceDir "dist\index.js"))) {
    Write-Host "Building device..."
    Push-Location $deviceDir
    npm run build
    Pop-Location
}

# Read or create API key
$apiKey = $null
if (Test-Path $keysFile) {
    $keys = Get-Content $keysFile | ConvertFrom-Json
    $apiKey = $keys[0].key
}

if (-not $apiKey) {
    Write-Host "No API key found. Starting hub once to generate it..."
    Push-Location $hubDir
    $proc = Start-Process node -ArgumentList "dist/index.js" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Pop-Location
    $keys = Get-Content $keysFile | ConvertFrom-Json
    $apiKey = $keys[0].key
}

Write-Host "========================================"
Write-Host "Desktop Commander Local 1-1 Stack"
Write-Host "========================================"
Write-Host "Hub API Key: $apiKey"
Write-Host "Hub SSE:     http://localhost:3000/sse"
Write-Host "Device:      msi-windows-main"
Write-Host "========================================`n"

# Start hub in background (single-port mode: WS shares HTTP server)
Push-Location $hubDir
$env:PORT = "3000"
$env:PUBLIC_URL = "https://hub.pkking.computer"
$env:OAUTH_ACCESS_TOKEN_TTL_SECONDS = "2592000"
# Leave WS_PORT unset so hub runs in single-port mode
$hubProc = Start-Process node -ArgumentList "dist/index.js" -PassThru -NoNewWindow
Pop-Location

# Give hub time to start
Start-Sleep -Seconds 2

# Start device pointing to local hub
Push-Location $deviceDir
$env:DC_HUB_URL = "ws://localhost:3000"
$env:DC_HUB_API_KEY = $apiKey
$env:DC_DEVICE_ID = "msi-windows-main"
$env:DC_DEVICE_NAME = "MSI Windows Main"
$env:DC_HOME_DIR = "C:\dev\desktop-projects"

try {
    Write-Host "Starting device client...`n"
    node dist/index.js
} finally {
    Write-Host "`nShutting down hub (PID $($hubProc.Id))..."
    Stop-Process -Id $hubProc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Done."
}
