# Register DC-Remote-Device as a scheduled task that starts at login
$node   = "C:\Program Files\nodejs\node.exe"
$script = "C:\Users\prest\Desktop\Desktop-Projects\Desktop-Commander-Remote\device\dist\index.js"
$wdir   = "C:\Users\prest\Desktop\Desktop-Projects\Desktop-Commander-Remote\device"

$action    = New-ScheduledTaskAction -Execute $node -Argument $script -WorkingDirectory $wdir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName "DC-Remote-Device" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Select-Object TaskName, State

Write-Host ""
Write-Host "Starting now..."
Start-ScheduledTask -TaskName "DC-Remote-Device"
Start-Sleep 2
Get-ScheduledTask -TaskName "DC-Remote-Device" | Select-Object TaskName, State
