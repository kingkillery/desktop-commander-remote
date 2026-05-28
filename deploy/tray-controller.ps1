Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$trayLogPath = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\tray.current.log'
$taskName = 'DC-Remote-Device'
$hubTaskName = 'DC-Remote-Hub'
$cloudflaredTaskName = 'DC-Remote-Cloudflared'
$trayTaskName = 'DC-Remote-Tray'
$rootPath = Split-Path -Parent $PSScriptRoot
$logPath = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\device\device.current.log'
$hubLogPath = Join-Path $rootPath 'hub\hub.current.log'
$cloudflaredLogPath = Join-Path $rootPath 'cloudflared.current.log'
$envPath = Join-Path $rootPath 'device\.env'

function Write-TrayLog([string]$message) {
    try {
        $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $trayLogPath -Value "[$timestamp] $message" -Encoding UTF8
    } catch {}
}

function Limit-MenuText([string]$text, [int]$maxLength = 120) {
    if (-not $text) { return '' }
    $singleLine = ($text -replace '\s+', ' ').Trim()
    if ($singleLine.Length -le $maxLength) { return $singleLine }
    return $singleLine.Substring(0, $maxLength - 3) + '...'
}

function Get-EnvValue([string]$key) {
    if (-not (Test-Path -LiteralPath $envPath)) { return $null }
    $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if ($line) {
        return ($line -split '=', 2)[1].Trim()
    }
    return $null
}

function Set-EnvValue([string]$key, [string]$value) {
    $lines = @()
    $found = $false
    if (Test-Path -LiteralPath $envPath) {
        $lines = Get-Content -LiteralPath $envPath
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*$key\s*=") {
                $lines[$i] = "$key=$value"
                $found = $true
            }
        }
    }
    if (-not $found) {
        $lines += "$key=$value"
    }
    $lines | Set-Content -LiteralPath $envPath -Encoding UTF8
}

function Get-HomeDir {
    $val = Get-EnvValue 'DC_HOME_DIR'
    if ($val) { return $val }
    return 'C:\dev'
}

function Get-TaskState([string]$name) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        return 'Not registered'
    }

    return [string]$task.State
}

function Test-ProcessPattern([string[]]$patterns) {
    $match = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cmd = $_.CommandLine
        if (-not $cmd) { return $false }
        foreach ($pattern in $patterns) {
            if ($cmd -like $pattern) { return $true }
        }
        return $false
    } | Select-Object -First 1

    return $null -ne $match
}

function Get-DeviceState {
    if (Test-ProcessPattern @('*Desktop-Commander-Remote*device*dist*index.js*')) {
        return 'Running'
    }
    Get-TaskState $taskName
}

function Get-HubState {
    if (Test-ProcessPattern @('*Desktop-Commander-Remote*hub*dist*index.js*')) {
        return 'Running'
    }
    Get-TaskState $hubTaskName
}

function Get-CloudflaredState {
    if (Test-ProcessPattern @('*cloudflared*tunnel*run*dc-hub-windows*')) {
        return 'Running'
    }
    Get-TaskState $cloudflaredTaskName
}

function Get-LastLogLine([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        return 'No log file yet'
    }

    $line = Get-Content -LiteralPath $path -Tail 8 -ErrorAction SilentlyContinue |
        Where-Object { $_ -and $_.Trim() } |
        Select-Object -Last 1
    if ($line) {
        return Limit-MenuText ([string]$line)
    }

    return 'Log is empty'
}

function Get-HubHealthSummary {
    $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { return 'Listening on localhost:3000' }
    return 'Not listening'
}

function Stop-RepoProcesses([string[]]$patterns) {
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cmd = $_.CommandLine
        if (-not $cmd) { return $false }
        foreach ($pattern in $patterns) {
            if ($cmd -like $pattern) { return $true }
        }
        return $false
    }

    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-ServerStack {
    Start-ScheduledTask -TaskName $hubTaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $cloudflaredTaskName -ErrorAction SilentlyContinue
}

function Stop-ServerStack {
    Stop-ScheduledTask -TaskName $cloudflaredTaskName -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $hubTaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Stop-RepoProcesses @(
        '*cloudflared*tunnel*run*dc-hub-windows*',
        '*Desktop-Commander-Remote*hub*dist*index.js*'
    )
}

function Restart-ServerStack {
    Stop-ServerStack
    Start-Sleep -Seconds 1
    Start-ServerStack
}

function Refresh-Tray {
    try {
        $state = Get-DeviceState
        $hubState = Get-HubState
        $cloudflaredState = Get-CloudflaredState
        $trayState = Get-TaskState $trayTaskName
        $hubHealth = Get-HubHealthSummary
        $lastLine = Get-LastLogLine $logPath

        $homeDir = Get-HomeDir
        $notifyIcon.Text = Limit-MenuText "DC Remote: Hub $hubState / Device $state" 63
        $serverStatusItem.Text = "Server: Hub $hubState, Tunnel $cloudflaredState"
        $hubHealthItem.Text = "Hub health: $hubHealth"
        $statusItem.Text = "Device task: $state"
        $trayStatusItem.Text = "Tray task: $trayState"
        $lastLogItem.Text = "Recent: $lastLine"
        $homeDirItem.Text = Limit-MenuText "Home: $homeDir"

        $startItem.Enabled = $state -ne 'Running'
        $stopItem.Enabled = $state -eq 'Running'
        $startServerItem.Enabled = $hubState -ne 'Running' -or $cloudflaredState -ne 'Running'
        $stopServerItem.Enabled = $hubState -eq 'Running' -or $cloudflaredState -eq 'Running'

        if ($hubHealth -like 'Listening*' -and $state -eq 'Running') {
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
        } elseif ($hubState -eq 'Not registered' -or $state -eq 'Not registered') {
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
        } else {
            $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
        }
    } catch {
        Write-TrayLog "Refresh failed: $($_.Exception.Message)"
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
        $notifyIcon.Text = 'DC Remote: refresh failed'
        $serverStatusItem.Text = 'Server: refresh failed'
        $hubHealthItem.Text = 'Hub health: unknown'
        $statusItem.Text = 'Device task: unknown'
        $trayStatusItem.Text = 'Tray task: unknown'
    }
}

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$serverStatusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$serverStatusItem.Enabled = $false
[void]$contextMenu.Items.Add($serverStatusItem)

$hubHealthItem = New-Object System.Windows.Forms.ToolStripMenuItem
$hubHealthItem.Enabled = $false
[void]$contextMenu.Items.Add($hubHealthItem)

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
[void]$contextMenu.Items.Add($statusItem)

$trayStatusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$trayStatusItem.Enabled = $false
[void]$contextMenu.Items.Add($trayStatusItem)

$lastLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$lastLogItem.Enabled = $false
[void]$contextMenu.Items.Add($lastLogItem)

$homeDirItem = New-Object System.Windows.Forms.ToolStripMenuItem
$homeDirItem.Enabled = $false
[void]$contextMenu.Items.Add($homeDirItem)

[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$startServerItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startServerItem.Text = 'Start server'
$startServerItem.Add_Click({
    Start-ServerStack
    Start-Sleep -Milliseconds 500
    Refresh-Tray
})
[void]$contextMenu.Items.Add($startServerItem)

$stopServerItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopServerItem.Text = 'Stop server'
$stopServerItem.Add_Click({
    Stop-ServerStack
    Start-Sleep -Milliseconds 500
    Refresh-Tray
})
[void]$contextMenu.Items.Add($stopServerItem)

$restartServerItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartServerItem.Text = 'Restart server'
$restartServerItem.Add_Click({
    Restart-ServerStack
    Start-Sleep -Milliseconds 500
    Refresh-Tray
})
[void]$contextMenu.Items.Add($restartServerItem)

[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem.Text = 'Start device'
$startItem.Add_Click({
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Refresh-Tray
})
[void]$contextMenu.Items.Add($startItem)

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem.Text = 'Stop device'
$stopItem.Add_Click({
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Refresh-Tray
})
[void]$contextMenu.Items.Add($stopItem)

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = 'Restart device'
$restartItem.Add_Click({
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Refresh-Tray
})
[void]$contextMenu.Items.Add($restartItem)

$setHomeDirItem = New-Object System.Windows.Forms.ToolStripMenuItem
$setHomeDirItem.Text = 'Set home directory...'
$setHomeDirItem.Add_Click({
    Add-Type -AssemblyName Microsoft.VisualBasic
    $current = Get-HomeDir
    $newDir = [Microsoft.VisualBasic.Interaction]::InputBox('Enter the home directory for DC Remote file operations:', 'Set Home Directory', $current)
    if ($newDir -and $newDir.Trim()) {
        $newDir = $newDir.Trim()
        if (-not (Test-Path -LiteralPath $newDir)) {
            $result = [System.Windows.Forms.MessageBox]::Show("Directory does not exist. Create it?", "Create Directory?", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
            if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
                New-Item -ItemType Directory -Path $newDir -Force | Out-Null
            } else {
                return
            }
        }
        Set-EnvValue 'DC_HOME_DIR' $newDir
        $restart = [System.Windows.Forms.MessageBox]::Show("Home directory updated to:`n$newDir`n`nRestart device now to apply?", "Restart Device?", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($restart -eq [System.Windows.Forms.DialogResult]::Yes) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
            Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        }
        Refresh-Tray
    }
})
[void]$contextMenu.Items.Add($setHomeDirItem)

[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openLogItem.Text = 'Open device log'
$openLogItem.Add_Click({
    if (Test-Path -LiteralPath $logPath) {
        Start-Process notepad.exe -ArgumentList $logPath
    }
})
[void]$contextMenu.Items.Add($openLogItem)

$openHubLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openHubLogItem.Text = 'Open hub log'
$openHubLogItem.Add_Click({
    if (Test-Path -LiteralPath $hubLogPath) {
        Start-Process notepad.exe -ArgumentList $hubLogPath
    }
})
[void]$contextMenu.Items.Add($openHubLogItem)

$openCloudflaredLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openCloudflaredLogItem.Text = 'Open tunnel log'
$openCloudflaredLogItem.Add_Click({
    if (Test-Path -LiteralPath $cloudflaredLogPath) {
        Start-Process notepad.exe -ArgumentList $cloudflaredLogPath
    }
})
[void]$contextMenu.Items.Add($openCloudflaredLogItem)

$openTrayLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openTrayLogItem.Text = 'Open tray log'
$openTrayLogItem.Add_Click({
    if (Test-Path -LiteralPath $trayLogPath) {
        Start-Process notepad.exe -ArgumentList $trayLogPath
    }
})
[void]$contextMenu.Items.Add($openTrayLogItem)

$refreshItem = New-Object System.Windows.Forms.ToolStripMenuItem
$refreshItem.Text = 'Refresh'
$refreshItem.Add_Click({ Refresh-Tray })
[void]$contextMenu.Items.Add($refreshItem)

[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = 'Exit tray'
$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
[void]$contextMenu.Items.Add($exitItem)

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Visible = $true
$notifyIcon.Text = 'DC Remote'
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Add_DoubleClick({ Refresh-Tray })

Write-TrayLog 'Tray starting'
Refresh-Tray
try {
    [System.Windows.Forms.Application]::Run()
} catch {
    Write-TrayLog "Tray crashed: $($_.Exception.Message)"
    throw
} finally {
    Write-TrayLog 'Tray exiting'
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
}
