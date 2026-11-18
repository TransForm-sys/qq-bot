# Start the bot fully detached from the caller, so it survives the parent shell.
# ASCII-only. Prints the resulting pid, or FAILED.
$root = Split-Path -Parent $PSScriptRoot

$existing = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })
if ($existing.Count -ge 1) {
    Write-Output ("ALREADY_RUNNING pid={0}" -f (($existing | ForEach-Object { $_.ProcessId }) -join ","))
    exit 0
}

# WScript.Shell.Run detaches via the shell COM object; a child of this script would be
# killed when the parent exits (observed), which is why Start-Process / cmd /c are not used.
$sh = New-Object -ComObject WScript.Shell
$sh.CurrentDirectory = $root
$cmd = 'cmd /c node src\index.ts > data\bot-stdout.log 2>&1'
[void]$sh.Run($cmd, 0, $false)

Start-Sleep -Seconds 5
$now = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })
if ($now.Count -ge 1) {
    Write-Output ("STARTED pid={0} log=data\bot-stdout.log" -f $now[0].ProcessId)
    exit 0
}
Write-Output "FAILED: check data\bot-stdout.log"
exit 2
