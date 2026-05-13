Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$taskName = 'DC-Remote-Device'
$trayTaskName = 'DC-Remote-Tray'
$logPath = 'C:\dev\Desktop-Projects\Desktop-Commander-Remote\device\device.current.log'
$envPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'device\.env'

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

function Get-DeviceState {
    Get-TaskState $taskName
}

function Get-LastLogLine {
    if (-not (Test-Path -LiteralPath $logPath)) {
        return 'No log file yet'
    }

    $line = Get-Content -LiteralPath $logPath -Tail 40 -ErrorAction SilentlyContinue |
        Where-Object { $_ -and $_.Trim() } |
        Select-Object -Last 1
    if ($line) {
        return [string]$line
    }

    return 'Log is empty'
}

function Refresh-Tray {
    $state = Get-DeviceState
    $trayState = Get-TaskState $trayTaskName
    $lastLine = Get-LastLogLine

    $homeDir = Get-HomeDir
    $notifyIcon.Text = "DC Remote: $state"
    $statusItem.Text = "Device task: $state"
    $trayStatusItem.Text = "Tray task: $trayState"
    $lastLogItem.Text = "Recent: $lastLine"
    $homeDirItem.Text = "Home: $homeDir"

    $startItem.Enabled = $state -ne 'Running'
    $stopItem.Enabled = $state -eq 'Running'

    if ($state -eq 'Running') {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    } elseif ($state -eq 'Not registered') {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Error
    } else {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    }
}

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

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
$openLogItem.Text = 'Open log'
$openLogItem.Add_Click({
    if (Test-Path -LiteralPath $logPath) {
        Start-Process notepad.exe -ArgumentList $logPath
    }
})
[void]$contextMenu.Items.Add($openLogItem)

$refreshItem = New-Object System.Windows.Forms.ToolStripMenuItem
$refreshItem.Text = 'Refresh'
$refreshItem.Add_Click({ Refresh-Tray })
[void]$contextMenu.Items.Add($refreshItem)

[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = 'Exit tray'
$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    $timer.Stop()
    [System.Windows.Forms.Application]::Exit()
})
[void]$contextMenu.Items.Add($exitItem)

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Visible = $true
$notifyIcon.Text = 'DC Remote'
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
$notifyIcon.Add_DoubleClick({ Refresh-Tray })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh-Tray })
$timer.Start()

Refresh-Tray
[System.Windows.Forms.Application]::Run()
