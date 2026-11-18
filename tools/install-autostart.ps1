# Install / remove the two Scheduled Tasks that keep the bot alive on this VM.
# ASCII-only.
#
#   powershell -File tools\install-autostart.ps1            # install (at logon + start now)
#   powershell -File tools\install-autostart.ps1 -Remove    # uninstall both tasks
#   powershell -File tools\install-autostart.ps1 -Status    # show current state
#
# Why tasks and not a shortcut:
#   The bot has to survive (a) the launcher window being closed, (b) a reboot with
#   auto-login, (c) the bot process dying silently. A logon trigger covers a+b, the
#   watchdog loop covers c. Both run in the interactive session, which the UI
#   automation needs (session 0 has no desktop and cannot paste into QQ).
param([switch]$Remove, [switch]$Status)

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

$TASK_START = "QQBot-Start"
$TASK_WATCH = "QQBot-Watchdog"

function Say($m) { Write-Output $m }

if ($Status) {
    foreach ($n in @($TASK_START, $TASK_WATCH)) {
        $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        if (-not $t) { Say ("[MISS] {0}" -f $n); continue }
        $i = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue
        Say ("[OK]   {0}  state={1}  lastRun={2}  lastResult={3}" -f $n, $t.State, $i.LastRunTime, $i.LastTaskResult)
    }
    return
}

if ($Remove) {
    foreach ($n in @($TASK_START, $TASK_WATCH)) {
        $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        if ($t) {
            try {
                Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -TaskName $n -Confirm:$false
                Say ("removed {0}" -f $n)
            } catch { Say ("FAILED to remove {0}: {1}" -f $n, $_.Exception.Message) }
        } else {
            Say ("not present: {0}" -f $n)
        }
    }
    return
}

# ---------- shared settings ----------
# TimeSpan.Zero = no execution time limit (default is 3 days and would kill the watchdog loop).
# ExecutionTimeLimit Zero matters: the default is 3 days, and when it expires the
# scheduler kills the task - which for the watchdog loop means it silently stops guarding.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# The watchdog is a long-lived loop, and a long-lived loop is exactly the thing that dies
# quietly: while debugging 2026-11-18 the loop process was found dead twice with the task
# still reporting state=Ready, so nothing restarted the bot afterwards. A repetition trigger
# + IgnoreNew turns that into a self-healing pattern: if the loop is alive, new starts are
# ignored; if it died, a fresh one comes up within the interval.
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

# ---------- task 1: bring everything up at logon ----------
# -StartQQ so an unattended reboot recovers even if QQ is not already logged in.
$a1 = New-ScheduledTaskAction -Execute $ps `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -StartQQ' -f (Join-Path $tools "recover.ps1")) `
    -WorkingDirectory $root

# ---------- task 2: watchdog loop (restarts the bot when it dies) ----------
# -RescanPid matters: after a QQ restart the pid in data\bot-pid.txt is stale, and without the
# flag the watchdog only warns for the rest of the VM's uptime.
$a2 = New-ScheduledTaskAction -Execute $ps `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Loop -IntervalSec 60 -RescanPid -ParkWindow' -f (Join-Path $tools "watchdog.ps1")) `
    -WorkingDirectory $root

$ok = $true
try {
    Register-ScheduledTask -TaskName $TASK_START -Action $a1 -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Say ("registered {0}" -f $TASK_START)
} catch { Say ("FAILED {0}: {1}" -f $TASK_START, $_.Exception.Message); $ok = $false }

try {
    Register-ScheduledTask -TaskName $TASK_WATCH -Action $a2 -Trigger @($trigger, $watchTrigger) -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Say ("registered {0}" -f $TASK_WATCH)
} catch { Say ("FAILED {0}: {1}" -f $TASK_WATCH, $_.Exception.Message); $ok = $false }

if (-not $ok) { exit 2 }

# ---------- start both now, so this run fixes the "webui refused" state ----------
foreach ($n in @($TASK_START, $TASK_WATCH)) {
    try { Start-ScheduledTask -TaskName $n; Say ("started {0}" -f $n) }
    catch { Say ("could not start {0}: {1}" -f $n, $_.Exception.Message) }
}

# ---------- verify the console answers ----------
$ok8087 = $false
foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    $code = & curl.exe -s -o NUL -w "%{http_code}" --noproxy "*" --max-time 3 "http://127.0.0.1:8787/" 2>$null
    if ($code -eq "200") { $ok8087 = $true; Say ("webui UP after {0}s (http {1})" -f ($i*2), $code); break }
}
if (-not $ok8087) { Say "webui still not answering on 8787 - see data\bot-stdout.log" }
Say ("done. tasks: {0} {1}" -f $TASK_START, $TASK_WATCH)
