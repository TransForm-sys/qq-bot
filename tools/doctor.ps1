# qq-bot health check. Read-only: never clicks, never kills, never writes config. ASCII-only.
# Exit: 0 = all good, 1 = warnings, 2 = fatal (bot cannot send/receive).
param([switch]$Deep)

$root = Split-Path -Parent $PSScriptRoot
$botPidFile = Join-Path $root "data\bot-pid.txt"
$fail = 0
$warn = 0

function Say($level, $name, $msg) {
    Write-Output ("[{0,-4}] {1,-18} {2}" -f $level, $name, $msg)
}
function Ok($n, $m) { Say "OK" $n $m }
function Wr($n, $m) { Say "WARN" $n $m; $script:warn++ }
function Er($n, $m) { Say "FAIL" $n $m; $script:fail++ }

# ---------- 1. QQ instances + bot binding ----------
$qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
if ($qq.Count -eq 0) {
    Er "qq-process" "no QQ.exe running -> start QQ and log in the bot account"
} else {
    $windowed = @($qq | Where-Object { $_.MainWindowHandle -ne 0 })
    Ok "qq-process" ("{0} QQ.exe, {1} with a visible window" -f $qq.Count, $windowed.Count)
}

$bp = 0
if (-not (Test-Path $botPidFile)) {
    Er "bot-pid" "data\bot-pid.txt missing -> run: tools\recover.ps1 (or the launcher .bat)"
} else {
    $raw = (Get-Content $botPidFile -Raw).Trim()
    if ($raw -notmatch '^[0-9]+$') { Er "bot-pid" "bad content: $raw" }
    else {
        $bp = [int]$raw
        $p = Get-Process -Id $bp -ErrorAction SilentlyContinue
        if (-not $p) { Er "bot-pid" "pid $bp is gone (QQ restarted?) -> run: tools\recover.ps1 (or the launcher .bat)" }
        elseif ($p.ProcessName -ne "QQ") { Er "bot-pid" "pid $bp is '$($p.ProcessName)', not QQ -> re-run tools\recover.ps1" }
        else { Ok "bot-pid" "pid $bp alive (QQ)" }
    }
}

# ---------- 2. bot window (send path needs it) ----------
# NOTE: MainWindowHandle is unreliable (QQ also owns a 160x28 floating window),
# so reuse ui-windows.ps1 (read-only enumeration) and take the largest VISIBLE one.
if ($bp -gt 0) {
    $p = Get-Process -Id $bp -ErrorAction SilentlyContinue
    if ($p) {
        $rows = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools\ui-windows.ps1") 2>$null
        $bestW = 0; $bestH = 0; $bestL = 0; $bestT = 0; $hiddenBig = 0
        foreach ($line in $rows) {
            if ($line -notmatch '^\d+\|') { continue }
            $f = $line -split '\|'
            if ([int]$f[0] -ne $bp) { continue }
            # Chrome_WidgetWin_0 is QQ's untitled host frame; only _1 is the chat window
            if ($f[3] -ne 'Chrome_WidgetWin_1') { continue }
            $wh = ($f[4] -split 'x')
            $w = [int]$wh[0]; $ht = [int]$wh[1]
            if ($f[2] -eq 'visible') {
                if ($w -ge 480 -and $ht -ge 360 -and ($w * $ht) -gt ($bestW * $bestH)) { $bestW = $w; $bestH = $ht }
            } else {
                # Do NOT size-gate this: a minimised chat window reports a bogus
                # 160x28 rect, and gating on it made a perfectly healthy parked bot
                # look like "no usable window" (VERDICT: FATAL every minute).
                $hiddenBig++
            }
        }
        if ($bestW -eq 0) {
            # Minimized on purpose (reply.parkWindowAfterSend). QQ raises a system
            # notification only while its window is MINIMIZED: a window sitting on the
            # desktop, and even one hidden with SW_HIDE, produce no notification at all
            # (measured 2026-11-18). The send path restores it on demand.
            if ($hiddenBig -gt 0) { Ok "bot-window" "minimized/hidden (auto-restored on next send)" }
            else { Er "bot-window" "no usable window (>=480x360) -> open the bot chat panel" }
        } else {
            Wr "bot-window" "window is OPEN on screen ${bestW}x${bestH} -> QQ will stop raising notifications; minimize it"
        }
    }
}

# ---------- 3. session lock + heartbeat ----------
# Locked workstation = SetForegroundWindow fails = every reply fails (R-30).
$ss = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools\session-state.ps1") 2>$null
if ($ss -eq "LOCKED") { Er "session" "workstation LOCKED -> UI sending cannot work until you unlock" }
elseif ($ss -eq "ACTIVE") { Ok "session" "unlocked (UI sending possible)" }
else { Wr "session" "state unknown" }

# Heartbeat = process alive AND event loop alive (R-31).
$hbFile = Join-Path $root "data\heartbeat.json"
if (-not (Test-Path $hbFile)) {
    Wr "heartbeat" "no data\heartbeat.json -> bot has not started the heartbeat (old build?)"
} else {
    try {
        $hb = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $age = [int](($nowMs - [int64]$hb.at) / 1000)
        if ($age -le 150) { Ok "heartbeat" "beat ${age}s ago, up $([int]($hb.uptimeMs/60000))min" }
        elseif ($age -le 600) { Wr "heartbeat" "beat ${age}s ago -> event loop slow or process wedged" }
        else { Er "heartbeat" "beat ${age}s ago -> process wedged or asleep; run tools\watchdog.ps1" }
        if ([int64]$hb.gapMs -gt 180000) {
            Wr "sleep-gap" ("last beat gap " + [int]([int64]$hb.gapMs / 1000) + "s -> machine slept, messages may be lost")
        }
    } catch { Wr "heartbeat" "unreadable" }
}

# ---------- 4. receive activity ----------
# Idle is not a fault: if nobody messages the bot, notify-archive.jsonl will not grow.
# The interesting signal is "notification DB keeps being written but we parsed no QQ event",
# which means the QQ toast path broke (notify toggle / handler id / Focus Assist).
$arch = Join-Path $root "data\notify-archive.jsonl"
$notif = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Notifications\wpndatabase.db"

$notifAge = -1
if (Test-Path $notif) {
    $notifAge = [int]((Get-Date) - (Get-Item $notif).LastWriteTime).TotalMinutes
    $notifMsg = "present, last write ${notifAge}min ago"
    if ($notifAge -gt 1440) { Wr "notif-db" ($notifMsg + " -> WPN may be disabled") }
    else { Ok "notif-db" $notifMsg }
} else {
    Er "notif-db" "wpndatabase.db not found"
}

if (-not (Test-Path $arch)) {
    Wr "receive" "no data\notify-archive.jsonl yet -> no message received since switching to notify mode"
} else {
    $age = [int]((Get-Date) - (Get-Item $arch).LastWriteTime).TotalMinutes
    if ($age -le 240) {
        Ok "receive" "last event ${age}min ago"
    } elseif ($notifAge -ge 0 -and $notifAge -le 60) {
        Wr "receive" ("notifications are arriving (db {0}min) but no QQ event for {1}min -> check QQ notify content toggle / WebUI alerts" -f $notifAge, $age)
    } else {
        Wr "receive" ("last event {0}min ago (idle - nobody messaged the bot). If you expected messages, check QQ notify toggle + Focus Assist" -f $age)
    }
}

# ---------- 5. bot process ----------
$bots = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })
if ($bots.Count -eq 0) { Wr "bot-process" "not running -> npm run bot" }
elseif ($bots.Count -gt 1) { Wr "bot-process" ("{0} instances running (duplicate replies): {1}" -f $bots.Count, (($bots | ForEach-Object { $_.ProcessId }) -join ",")) }
else { Ok "bot-process" ("pid {0}" -f $bots[0].ProcessId) }

# ---------- 6. config ----------
# PS 5.1 Get-Content defaults to ANSI; config.json is UTF-8 -> must read explicitly
$cfgText = [System.IO.File]::ReadAllText((Join-Path $root "config.json"), [System.Text.Encoding]::UTF8)
$cfg = $cfgText | ConvertFrom-Json
$ready = @($cfg.providers | Where-Object { $_.enabled -and ($_.apiKey -or ($_.baseURL -match '127\.0\.0\.1|localhost')) })
if (-not $cfg.models.default) {
    Er "llm-config" "models.default is empty -> pick a model in WebUI (http://127.0.0.1:8787)"
} elseif ($ready.Count -eq 0) {
    Er "llm-config" ("no provider has an apiKey -> fill one in WebUI " + $cfg.models.default)
} else {
    Ok "llm-config" ("{0} | {1} provider(s) ready" -f $cfg.models.default, $ready.Count)
}
if ($cfg.receive -ne 'notify') { Wr "receive-mode" "receive=$($cfg.receive) (expected notify)" }
else { Ok "receive-mode" "notify ($($cfg.receiveIntervalMs)ms)" }

# ---------- 7. deep: does bot-pid actually own the DB salt? ----------
if ($Deep -and $bp -gt 0) {
    $dbCopy = Join-Path $root "data\dbcopy\nt_msg.db"
    if (-not (Test-Path $dbCopy)) {
        Wr "deep-bind" "skipped: data\dbcopy\nt_msg.db missing (salt check unavailable)"
    } else {
        Write-Output "[..]  deep scan (mem-allsalt-scan, up to 240s)..."
        $log = Join-Path $root "data\salt-scan.log"
        powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools\mem-allsalt-scan.ps1") *> $log 2>&1
        $scanRc = $LASTEXITCODE
        $new = (Get-Content $botPidFile -Raw).Trim()
        if ($scanRc -ne 0) { Wr "deep-bind" "salt scan failed (exit $scanRc) -> see data\salt-scan.log" }
        elseif ($new -eq "$bp") { Ok "deep-bind" "pid $bp is confirmed by salt hits" }
        else { Er "deep-bind" "binding changed $bp -> $new (was stale)" }
    }
}

Write-Output " "
if ($fail -gt 0) { Write-Output "VERDICT: FATAL ($fail fail, $warn warn)"; exit 2 }
if ($warn -gt 0) { Write-Output "VERDICT: DEGRADED ($warn warn)"; exit 1 }
Write-Output "VERDICT: HEALTHY"
exit 0
