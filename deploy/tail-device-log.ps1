[CmdletBinding()]
param(
    [int]$Tail = 20,
    [switch]$Follow,
    [string]$LogPath = (Join-Path $PSScriptRoot '..\device\device.current.log')
)

$resolved = (Resolve-Path -LiteralPath $LogPath -ErrorAction Stop).Path
$prevEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
    if ($Follow) {
        Get-Content -LiteralPath $resolved -Tail $Tail -Wait -Encoding UTF8
    } else {
        Get-Content -LiteralPath $resolved -Tail $Tail -Encoding UTF8
    }
} finally {
    [Console]::OutputEncoding = $prevEncoding
}
