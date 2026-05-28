# Register DC-Remote-Device as a scheduled task that starts at login
$node   = 'C:\Program Files\nodejs\node.exe'
$script = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\device\dist\index.js'
$hubScript = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\hub\dist\index.js'
$wdir   = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\device'
$hubDir = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\hub'
$rootDir = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote'
$tray   = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\deploy\tray-controller.ps1'
$runner = Join-Path $wdir 'run-hidden.vbs'
$hubRunner = Join-Path $hubDir 'run-hidden.vbs'
$cloudflaredRunner = Join-Path $rootDir 'cloudflared-run-hidden.vbs'
$log    = Join-Path $wdir 'device.current.log'
$hubLog = Join-Path $hubDir 'hub.current.log'
$cloudflaredLog = Join-Path $rootDir 'cloudflared.current.log'

function Quote-CmdArg([string]$value) {
    '"' + ($value -replace '"', '\"') + '"'
}

function Quote-VbsString([string]$value) {
    '"' + ($value -replace '"', '""') + '"'
}

function Ensure-Utf8Bom([string]$path) {
    # cmd.exe `>>` redirection writes bytes verbatim. Node logs emoji as proper
    # UTF-8 multibyte sequences, but without a BOM PowerShell 5.x's default
    # Get-Content reads the file as Windows-1252 and renders mojibake. Pre-
    # writing a UTF-8 BOM at byte 0 lets default readers auto-detect UTF-8.
    if (Test-Path -LiteralPath $path) {
        try {
            $head = [System.IO.File]::ReadAllBytes($path) | Select-Object -First 3
        } catch {
            return  # File locked by running device — leave it; caller should stop the task first.
        }
        if ($head.Length -ge 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
            return  # Already has BOM.
        }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Move-Item -LiteralPath $path -Destination "$path.old.$stamp" -Force
    }
    [System.IO.File]::WriteAllBytes($path, [byte[]](0xEF, 0xBB, 0xBF))
}

Ensure-Utf8Bom $log
Ensure-Utf8Bom $hubLog
Ensure-Utf8Bom $cloudflaredLog

$cmd = 'cmd.exe /d /c call ' + (Quote-CmdArg $node) + ' ' + (Quote-CmdArg $script) + ' >> ' + (Quote-CmdArg $log) + ' 2>&1'
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = $(Quote-VbsString $wdir)
shell.Run $(Quote-VbsString $cmd), 0, True
"@ | Set-Content -LiteralPath $runner -Encoding ASCII

$hubCmd = 'cmd.exe /d /c set PORT=3000&& set PUBLIC_URL=https://hub.pkking.computer&& set OAUTH_ACCESS_TOKEN_TTL_SECONDS=2592000&& set WS_PORT=&& call ' + (Quote-CmdArg $node) + ' ' + (Quote-CmdArg $hubScript) + ' >> ' + (Quote-CmdArg $hubLog) + ' 2>&1'
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = $(Quote-VbsString $hubDir)
shell.Run $(Quote-VbsString $hubCmd), 0, True
"@ | Set-Content -LiteralPath $hubRunner -Encoding ASCII

$cloudflaredCmd = 'cmd.exe /d /c cloudflared tunnel run dc-hub-windows >> ' + (Quote-CmdArg $cloudflaredLog) + ' 2>&1'
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = $(Quote-VbsString $rootDir)
shell.Run $(Quote-VbsString $cloudflaredCmd), 0, True
"@ | Set-Content -LiteralPath $cloudflaredRunner -Encoding ASCII

$hubAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo ' + (Quote-CmdArg $hubRunner)) -WorkingDirectory $hubDir
$cloudflaredAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo ' + (Quote-CmdArg $cloudflaredRunner)) -WorkingDirectory $rootDir
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo ' + (Quote-CmdArg $runner)) -WorkingDirectory $wdir
$trayAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (Quote-CmdArg $tray)) -WorkingDirectory (Split-Path -Parent $tray)
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName "DC-Remote-Hub" `
    -Action $hubAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Select-Object TaskName, State

Register-ScheduledTask `
    -TaskName "DC-Remote-Cloudflared" `
    -Action $cloudflaredAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Select-Object TaskName, State

Register-ScheduledTask `
    -TaskName "DC-Remote-Device" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Select-Object TaskName, State

Register-ScheduledTask `
    -TaskName "DC-Remote-Tray" `
    -Action $trayAction `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Select-Object TaskName, State

Write-Host ""
Write-Host "Starting now..."
Start-ScheduledTask -TaskName "DC-Remote-Hub"
Start-ScheduledTask -TaskName "DC-Remote-Cloudflared"
Start-Sleep 3
Start-ScheduledTask -TaskName "DC-Remote-Device"
Start-ScheduledTask -TaskName "DC-Remote-Tray"
Start-Sleep 2
Get-ScheduledTask -TaskName "DC-Remote-Hub", "DC-Remote-Cloudflared", "DC-Remote-Device", "DC-Remote-Tray" | Select-Object TaskName, State
