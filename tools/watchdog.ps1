# Watchdog for the QQ bot. Reads data\heartbeat.json and fixes the common "silently dead" states.
# ASCII-only. Read-only by default except when it decides to restart / restore the window.
#
# What it detects:
#   - bot process gone            -> start it again (start-bot.ps1)
#   - heartbeat stale (>180s)     -> event loop blocked / process wedged -> kill + restart
#   - heartbeat gap > 3 min       -> machine slept/hibernated (just report; messages may be lost)
#   - duplicate instances         -> report (two bots fight over the same UI)
#   - bot window missing          -> optionally restore (ui-restore.ps1 -Yes)
#   - session locked              -> report; sending is impossible until unlock
param(
    [switch]$Loop,
    [int]$IntervalSec = 60,
    [int]$StaleSec = 180,
    [switch]$NoStart,
    [switch]$RestoreWindow,
    [switch]$ParkWindow,
    [switch]$RescanPid
)

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
$hbFile = Join-Path $root "data\heartbeat.json"
$pidFile = Join-Path $root "data\bot-pid.txt"

$logFile = Join-Path $root "data\watchdog.log"

function Log($m) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m
    Write-Output $line
    # The task runs us in a hidden window, so stdout goes nowhere. Keep a tail-able file;
    # without it "the watchdog was running but did nothing" is undebuggable.
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 2MB)) {
            $keep = Get-Content $logFile -Tail 2000
            Set-Content -Path $logFile -Value $keep -Encoding UTF8
        }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Get-Bots {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })
}

function Start-Bot {
    # recover.ps1 does the whole chain (check QQ -> rebind instance -> un-tray window -> start
    # bot -> health check). Calling start-bot.ps1 alone would leave a stale bot-pid.txt after a
    # QQ restart, and the bot would then paste into a window that no longer belongs to the account.
    $r = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "recover.ps1")
    Log ("recover: " + (($r | Select-Object -Last 3) -join " "))
}

function Check {
    # ---------- QQ itself ----------
    # No QQ.exe means: messages are not even delivered, nothing can be sent, and every
    # later check below is meaningless. Watchdog is the only long-lived process here, so
    # it is also the only place that can launch QQ without the child dying together with
    # whatever shell happened to trigger the check (observed). QQ must log in by itself,
    # otherwise this just reports and keeps waiting for a human.
    $qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
    if ($qq.Count -eq 0) {
        if ($NoStart) {
            Log "QQ NOT running (NoStart set, not starting it)"
        } else {
            $exe = ""
            foreach ($c in @(
                (Join-Path $env:ProgramFiles "Tencent\QQNT\QQ.exe"),
                (Join-Path ${env:ProgramFiles(x86)} "Tencent\QQNT\QQ.exe"),
                (Join-Path $env:LOCALAPPDATA "Programs\Tencent\QQNT\QQ.exe"),
                "C:\Tencent\QQNT\QQ.exe"
            )) {
                if ($c -and (Test-Path $c)) { $exe = $c; break }
            }
            if (-not $exe) {
                Log "QQ NOT running and QQ.exe not found -> install path unknown"
            } else {
                Log "QQ NOT running -> launching $exe"
                $shq = New-Object -ComObject WScript.Shell
                [void]$shq.Run(('"' + $exe + '"'), 1, $false)
                Start-Sleep -Seconds 12
                $qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
                Log ("  QQ processes now: " + $qq.Count + " (auto-login must be enabled in QQ)")
            }
        }
    }

    $bots = Get-Bots
    if ($bots.Count -eq 0) {
        Log "bot process NOT running"
        if ($NoStart) { Log "  (NoStart set, not starting)" }
        else { Start-Bot }
        return
    }
    if ($bots.Count -gt 1) {
        $ids = ($bots | ForEach-Object { $_.ProcessId }) -join ","
        Log "WARN duplicate bot instances: $ids (duplicate replies, UI fights)"
    }

    if (-not (Test-Path $hbFile)) {
        Log "no heartbeat file yet (just started?)"
    } else {
        try {
            $hb = [System.IO.File]::ReadAllText($hbFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        } catch {
            Log "heartbeat file unreadable"
            $hb = $null
        }
        if ($hb) {
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $ageSec = [int](($nowMs - [int64]$hb.at) / 1000)
            if ($ageSec -gt $StaleSec) {
                Log "heartbeat STALE ${ageSec}s -> event loop blocked, restarting pid $($hb.pid)"
                try { Stop-Process -Id ([int]$hb.pid) -Force -ErrorAction Stop } catch { Log "  kill failed: $($_.Exception.Message)" }
                Start-Sleep -Seconds 2
                if ($NoStart) { Log "  (NoStart set, not restarting)" } else { Start-Bot }
                return
            }
            if ([int64]$hb.gapMs -gt 180000) {
                Log ("WARN machine slept/hibernated: last beat gap " + [int]([int64]$hb.gapMs / 1000) + "s (messages may be lost)")
            }
            $c = $hb.counters
            $rh = $hb.receiver
            Log ("ok pid=$($hb.pid) up=$([int]($hb.uptimeMs/60000))min in=$($c.in) out=$($c.out) err=$($c.errors) " +
                 "snapFails=$($rh.snapshotFailStreak) hbAge=${ageSec}s")
            if ($rh.snapshotFailStreak -ge 5) { Log "  ALERT receiver cannot read notification DB: $($rh.lastSnapshotError)" }
            if ($hb.alerts -and $hb.alerts.Count -gt 0) {
                # heartbeat keeps the last few alerts forever, so printing them every
                # round made one old warning look like a permanent failure. Only show
                # alerts raised since the previous check.
                $alertsSeen = Get-Content (Join-Path $root "data\alerts-seen.txt") -Raw -ErrorAction SilentlyContinue
                $lastSeen = 0
                if ($alertsSeen -and $alertsSeen.Trim() -match '^[0-9]+$') { $lastSeen = [int64]$alertsSeen.Trim() }
                $newest = 0
                foreach ($a in $hb.alerts) {
                    $at = [int64]$a.at
                    if ($at -gt $newest) { $newest = $at }
                    if ($at -gt $lastSeen) { Log ("  ALERT [$($a.level)] $($a.code): $($a.message)") }
                }
                if ($newest -gt 0) { try { Set-Content -Path (Join-Path $root "data\alerts-seen.txt") -Value $newest -Encoding ASCII } catch { } }
            }
        }
    }

    # session lock: sending cannot work while locked
    $ss = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "session-state.ps1") 2>$null
    if ($ss -eq "LOCKED") { Log "WARN session is LOCKED -> UI sending will fail until you unlock" }

    # bot window
    if (Test-Path $pidFile) {
        $bp = [int]((Get-Content $pidFile -Raw).Trim())
        $alive = Get-Process -Id $bp -ErrorAction SilentlyContinue
        if (-not $alive) {
            Log "WARN bot-pid $bp is gone (QQ restarted?)"
            if ($RescanPid) {
                # recover.ps1 -NoStartBot is the deterministic rebind (instance tree + account
                # dir on disk). The memory scan needs data\dbcopy\nt_msg.db, which is not shipped,
                # so calling it here would just log a failure and leave the stale pid in place.
                Log "  rebinding instance (account-dir based)..."
                & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "recover.ps1") -NoStartBot *> (Join-Path $root "data\rebind.log")
                Log ("  new bot-pid = " + (Get-Content $pidFile -Raw).Trim())
            } else {
                Log "  run with -RescanPid to refresh it"
            }
        } else {
            $best = 0
            $rows = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "ui-windows.ps1") 2>$null
            foreach ($line in $rows) {
                if ($line -notmatch '^\d+\|') { continue }
                $f = $line -split '\|'
                if ([int]$f[0] -ne $bp) { continue }
                if ($f[3] -notmatch '^Chrome_WidgetWin') { continue }
                if ($f[2] -ne 'visible') { continue }
                $wh = ($f[4] -split 'x')
                if ([int]$wh[0] -ge 480 -and [int]$wh[1] -ge 360) { $best = 1 }
            }
            if ($best -eq 0) {
                # Minimized is the NORMAL state now: QQ raises a system notification only
                # while its window is minimized (hidden with SW_HIDE does NOT notify -
                # measured 2026-11-18), and the receive path depends on those notifications.
                # The send path restores the window on demand, so restoring it here would
                # re-break receiving.
                Log "bot window minimized/hidden (normal; restored on the next send)"
                if ($RestoreWindow) {
                    $r = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "ui-restore.ps1") -Yes
                    Log ("  manual restore: " + ($r -join " "))
                }
            } elseif ($ParkWindow) {
                # Someone (or QQ itself) opened the window again. A window sitting on the
                # desktop -- especially in the foreground -- stops QQ from raising
                # notifications, so receive silently dies. Minimize it again, but never in
                # the middle of a send: touching the window between the click and the paste
                # would make the send miss.
                $send = if ($hb) { $hb.send } else { $null }
                $busy = [bool]($send -and $send.sending)
                $lastSend = 0
                if ($send -and $send.lastSendAt) { $lastSend = [int64]$send.lastSendAt }
                $now2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $idleFor = if ($lastSend -gt 0) { $now2 - $lastSend } else { 999999 }
                if (-not $busy -and $idleFor -gt 90000) {
                    $r = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "ui-restore.ps1") -Minimize
                    Log ("window was open -> minimized again (" + (($r -join " ").Trim()) + ")")
                } else {
                    Log "window is open but a send is in flight; not parking now"
                }
            }
        }
    }
}

if ($Loop) {
    Log "watchdog loop started (every ${IntervalSec}s, stale=${StaleSec}s)"
    while ($true) {
        try { Check } catch { Log ("check error: " + $_.Exception.Message) }
        Start-Sleep -Seconds $IntervalSec
    }
} else {
    Check
}
