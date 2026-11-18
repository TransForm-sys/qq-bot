# Scan EVERY QQ.exe process for the DB salt needles and bind the BOT instance.
# Selection rules (fixed 2026-11-17):
#   1. the bot pid is the ONE WITH THE MOST NEEDLE HITS (not the last one scanned);
#   2. the windowed ancestor must itself be QQ.exe with a real window, else keep the hit pid;
#   3. never write a non-QQ pid into bot-pid.txt.
# ASCII-only.
$root = Split-Path -Parent $PSScriptRoot

# FAIL FAST. Without the DB copy the needles degrade to empty strings and the scan
# silently grinds through every QQ process address space (looks like a hang).
$dbCopy = Join-Path $root "data\dbcopy\nt_msg.db"
if (-not (Test-Path $dbCopy)) {
    Write-Output "RESULT: data\dbcopy\nt_msg.db is missing -> cannot derive salt needles"
    Write-Output "  copy <QQ data root>\<uin>\nt_qq\nt_db\nt_msg.db to data\dbcopy\nt_msg.db first"
    Write-Output "bot-pid.txt left untouched"
    exit 4
}

Add-Type -Path "$root\tools\memscan2.cs"
$dbBytes = [System.IO.File]::ReadAllBytes($dbCopy)
if (-not $dbBytes -or $dbBytes.Length -lt 2048) {
    Write-Output "RESULT: data\dbcopy\nt_msg.db is unreadable or too small ($($dbBytes.Length) bytes)"
    Write-Output "bot-pid.txt left untouched"
    exit 4
}
$p2 = New-Object byte[] 16
[Array]::Copy($dbBytes, 1024, $p2, 0, 16)
$p2raw = ([BitConverter]::ToString($p2)).Replace("-", "").ToLower()
$p2asciiHex = ([BitConverter]::ToString([System.Text.Encoding]::ASCII.GetBytes($p2raw))).Replace("-", "").ToLower()
$f2 = New-Object byte[] 64
[Array]::Copy($dbBytes, 47, $f2, 0, 64)
$f2raw = ([BitConverter]::ToString($f2)).Replace("-", "").ToLower()
$needles = @($p2raw, $p2asciiHex, $f2raw) | Where-Object { $_ -and $_.Length -ge 8 -and $_ -notmatch '^(00)+$' }
if ($needles.Count -eq 0) {
    Write-Output "RESULT: salt needles came out empty/zero -> data\dbcopy\nt_msg.db is not a QQ NT DB copy"
    Write-Output "bot-pid.txt left untouched"
    exit 4
}

$procs = Get-CimInstance Win32_Process -Filter "Name='QQ.exe'"
$hits = @{}
$candsByPid = @{}
foreach ($ci in $procs) {
    $proc = Get-Process -Id $ci.ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    try {
        $cands = [MemScan2]::Scan($proc.Id, 4294967296, $needles)
    } catch {
        Write-Output "pid $($proc.Id) scan failed: $($_.Exception.Message)"
        continue
    }
    Write-Output "pid $($proc.Id) candidates: $($cands.Count)"
    if ($cands.Count -gt 0) {
        $hits[$proc.Id] = $cands.Count
        $candsByPid[$proc.Id] = $cands
    }
}

if ($hits.Count -eq 0) {
    Write-Output "RESULT: no salt hits in any QQ process (bot instance not running?)"
    Write-Output "bot-pid.txt left untouched"
    exit 1
}

$bestPid = ($hits.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
Write-Output "best hit pid: $bestPid ($($hits[$bestPid]) candidates)"

# Safety floor. The bot account shows ~68 hits; a non-bot QQ instance only shows a
# handful of stray matches (~18 observed). Binding the wrong instance means every
# reply gets sent from the user's MAIN account (R-09, the worst failure mode).
# So: refuse to rebind when the best candidate is below the floor, and keep the
# existing (stale) binding instead - a stale pid fails closed.
$MIN_HITS = 40
if ([int]$hits[$bestPid] -lt $MIN_HITS) {
    Write-Output ("RESULT: best candidate has only {0} hits (< {1}) -> refusing to rebind" -f $hits[$bestPid], $MIN_HITS)
    Write-Output "bot-pid.txt left untouched (log in the BOT account, then re-run)"
    exit 3
}

# windowed ancestor: QQ.exe only, otherwise keep the hit pid itself
$botPid = $bestPid
$cur = $bestPid
for ($i = 0; $i -lt 8; $i++) {
    $cc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $cc) { break }
    $pp = Get-Process -Id $cc.ParentProcessId -ErrorAction SilentlyContinue
    if (-not $pp) { break }
    if ($pp.ProcessName -eq "QQ" -and $pp.MainWindowHandle -ne 0) { $botPid = $pp.Id; break }
    $cur = $pp.Id
}
Write-Output "windowed ancestor: $botPid"

$finalName = (Get-Process -Id $botPid -ErrorAction SilentlyContinue).ProcessName
if ($finalName -ne "QQ") {
    Write-Output "RESULT: resolved pid $botPid is '$finalName', not QQ -> keeping $bestPid"
    $botPid = $bestPid
}

# candidates from the bot pid only (keeps the key-search corpus clean)
$out = @($candsByPid[$bestPid])
$out | Out-File "$root\data\salt-candidates.txt" -Encoding ASCII
Set-Content "$root\data\bot-pid.txt" -Value $botPid -Encoding ASCII

# string-keyed copy: PS 5.1 ConvertTo-Json rejects integer keys
$hitMap = @{}
foreach ($k in $hits.Keys) { $hitMap["$k"] = $hits[$k] }
$audit = [ordered]@{
    at         = (Get-Date).ToString("s")
    botPid     = $botPid
    bestHitPid = $bestPid
    hits       = $hitMap
    candidates = $out.Count
}
$audit | ConvertTo-Json -Depth 4 | Out-File "$root\data\salt-scan.json" -Encoding ASCII
Write-Output "RESULT: bot-pid=$botPid candidates=$($out.Count)"
