# Stop the bot node process only. Never touches QQ itself (the bot account stays logged in).
# ASCII-only.
$root = Split-Path -Parent $PSScriptRoot

$bots = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })

if ($bots.Count -eq 0) {
    Write-Output "bot is not running"
    exit 0
}

foreach ($b in $bots) {
    try {
        Stop-Process -Id $b.ProcessId -Force -Confirm:$false -ErrorAction Stop
        Write-Output ("stopped pid " + $b.ProcessId)
    } catch {
        Write-Output ("failed to stop pid " + $b.ProcessId + ": " + $_.Exception.Message.Split([Environment]::NewLine)[0])
    }
}

Start-Sleep -Seconds 1
$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })
if ($left.Count -eq 0) {
    Write-Output "bot stopped (QQ untouched)"
    exit 0
}
Write-Output ("still running: " + (($left | ForEach-Object { $_.ProcessId }) -join ","))
exit 1
