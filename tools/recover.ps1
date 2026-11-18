# One-shot recovery for qq-bot. NEVER kills QQ, never touches login data.
# Order: check -> rebind pid -> (optional) restore window -> (optional) start QQ -> start bot -> re-check.
#
#   powershell -File tools\recover.ps1                     # safe: only rebind + start bot
#   powershell -File tools\recover.ps1 -RestoreWindow      # also try to un-tray the bot window
#   powershell -File tools\recover.ps1 -StartQQ            # also launch QQ if not running
#
# ASCII-only.
param([switch]$RestoreWindow, [switch]$StartQQ, [switch]$NoStartBot)

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
$botPidFile = Join-Path $root "data\bot-pid.txt"
# QQ.exe location is auto-detected: any live QQ process first, then the usual install roots.
function Find-QQExe {
    $live = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath } | Select-Object -First 1)
    if ($live.Count -ge 1) { return $live[0].ExecutablePath }
    $cand = @(
        (Join-Path $env:ProgramFiles "Tencent\QQNT\QQ.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Tencent\QQNT\QQ.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Tencent\QQNT\QQ.exe"),
        "D:\Program Files\Tencent\QQNT\QQ.exe",
        "D:\Tencent\QQNT\QQ.exe",
        "C:\Tencent\QQNT\QQ.exe"
    )
    foreach ($c in $cand) { if ($c -and (Test-Path $c)) { return $c } }
    return ""
}
$QQEXE = Find-QQExe

function Step($m) { Write-Host ""; Write-Host "=== $m" }
function Note($m) { Write-Host "    $m" }

# ---------- 0. preflight ----------
Step "0. preflight"
$qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
if ($qq.Count -eq 0) {
    if ($StartQQ) {
        if (-not $QQEXE -or -not (Test-Path $QQEXE)) { Note "QQ.exe not found - start QQ manually, then re-run this script"; exit 2 }
        Note "starting QQ..."
        # NOT Start-Process: a child of this script dies with the caller's console
        # (observed: QQ exited ~1 min after launch). WScript.Shell.Run detaches it
        # into Explorer's process tree, which is how start-bot.ps1 launches node.
        $shq = New-Object -ComObject WScript.Shell
        [void]$shq.Run(('"' + $QQEXE + '"'), 1, $false)
        Start-Sleep -Seconds 8
        $qq = @(Get-Process QQ -ErrorAction SilentlyContinue)
    }
    if ($qq.Count -eq 0) {
        Note "QQ is NOT running. Start QQ and log in the BOT account first."
        Note "  (auto-login only works if 'auto login' is enabled in QQ)"
        exit 2
    }
}
Note ("QQ.exe processes: {0}" -f $qq.Count)

# ---------- 1. bot-pid rebind ----------
Step "1. bot instance binding"
$needScan = $true
if (Test-Path $botPidFile) {
    $raw = (Get-Content $botPidFile -Raw).Trim()
    if ($raw -match '^\d+$') {
        $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq "QQ") { $needScan = $false; Note "pid $raw still valid" }
        else { Note "pid $raw is stale (QQ restarted?)" }
    }
}

# Identity is decided from on-disk facts, NOT from a memory scan:
#   - how many QQ instance trees are running (each tree = one logged-in account)
#   - which account actually has data on this machine (<data root>\<uin>)
# The salt-needle scan stays as a fallback only, because it needs data\dbcopy\nt_msg.db
# (never shipped with the package) and would otherwise grind through GBs of memory.
function Get-Cfg {
    try { return [System.IO.File]::ReadAllText((Join-Path $root "config.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { return $null }
}
$cfg = Get-Cfg
$botUin = ""
if ($cfg -and $cfg.botUin) { $botUin = "$($cfg.botUin)" }

function Get-QQAccounts {
    $roots = @()
    if ($cfg -and $cfg.storagePath) { $roots += $cfg.storagePath }
    $roots += (Join-Path $env:USERPROFILE "Documents\Tencent Files")
    if ($env:PUBLIC) { $roots += (Join-Path $env:PUBLIC "Documents\Tencent Files") }
    $items = @()
    foreach ($r in $roots) {
        if (-not $r -or -not (Test-Path $r)) { continue }
        $items += @(Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d{5,12}$' })
    }
    return @($items)
}

function Get-QQRoots {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue)
    $ids = @($all | ForEach-Object { $_.ProcessId })
    return @($all | Where-Object { $ids -notcontains $_.ParentProcessId })
}

if ($needScan) {
    # @() matters: a single CimInstance/FileInfo has no .Count in PS 5.1
    $rootsQQ = @(Get-QQRoots)
    $accts = @(Get-QQAccounts)
    $names = @($accts | ForEach-Object { $_.Name } | Select-Object -Unique)
    $newest = $accts | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Note ("QQ instance trees: {0}" -f $rootsQQ.Count)
    Note ("accounts with local data: {0}" -f $(if ($names.Count) { $names -join "," } else { "none" }))

    $fastOk = $false
    $reason = ""
    if ($rootsQQ.Count -ne 1) { $reason = "more than one QQ instance tree -> cannot tell which one is the bot" }
    elseif ($botUin -eq "") { $reason = "config.json has no botUin -> cannot verify the account" }
    elseif ($names.Count -eq 0) { $reason = "no account data found under the QQ data root -> cannot verify the account" }
    elseif ($newest -and $newest.Name -ne $botUin) { $reason = "the account in use looks like $($newest.Name), expected BOT $botUin" }
    else { $fastOk = $true }

    if ($fastOk) {
        # One instance tree + the bot account is the one with fresh data: unambiguous.
        Set-Content $botPidFile -Value $rootsQQ[0].ProcessId -Encoding ASCII
        Note ("bound pid {0} (single instance, account {1} verified from disk - no memory scan)" -f $rootsQQ[0].ProcessId, $botUin)
    } else {
        Note "fast binding not applicable: $reason"
        $scanScript = Join-Path $tools "mem-allsalt-scan.ps1"
        $dbCopy = Join-Path $root "data\dbcopy\nt_msg.db"
        if (-not (Test-Path $dbCopy)) {
            Note "FATAL: needs data\dbcopy\nt_msg.db (not shipped) to run the salt fallback."
            Note "  Fix: copy <QQ data root>\$botUin\nt_qq\nt_db\nt_msg.db to data\dbcopy\nt_msg.db,"
            Note "  then run this again. Do NOT start the bot on an unverified binding."
            exit 2
        }
        Note "falling back to salt needle scan (240s timeout)..."
        $log = Join-Path $root "data\salt-scan.log"
        $job = Start-Job -ScriptBlock {
            param($s, $l)
            & powershell -NoProfile -ExecutionPolicy Bypass -File $s *> $l 2>&1
        } -ArgumentList $scanScript, $log
        if (-not (Wait-Job $job -Timeout 240)) {
            Stop-Job $job -ErrorAction SilentlyContinue
            Note "salt scan timed out after 240s -> see data\salt-scan.log"
        }
        Receive-Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        if (Test-Path $botPidFile) { Note ("bot-pid.txt -> {0}" -f (Get-Content $botPidFile -Raw).Trim()) }
        else { Note "scan produced no binding (is the BOT account logged in?)" }
    }
}

# Hard gate: a dead/non-QQ binding means every reply is lost. Do NOT start the bot on it.
$boundRaw = ""
if (Test-Path $botPidFile) { $boundRaw = (Get-Content $botPidFile -Raw).Trim() }
$boundOk = $false
if ($boundRaw -match '^\d+$') {
    $bp = Get-Process -Id ([int]$boundRaw) -ErrorAction SilentlyContinue
    if ($bp -and $bp.ProcessName -eq "QQ") { $boundOk = $true }
}
if (-not $boundOk) {
    Note ("binding is NOT usable (bot-pid.txt = '{0}')" -f $boundRaw)
    Note "The bot account must be logged in on this machine."
    Note "  -> start QQ, switch to / log in the bot account, then run this again"
    Note "The bot process was NOT started (it could not send anything anyway)."
    exit 2
}

# ---------- 2. bot window ----------
Step "2. bot window (minimized is normal; sending restores it)"
$rectOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "ui-rect.ps1") 2>$null
if ($rectOut -match '^\d+ \d+ \d+ \d+$') {
    Note "ready: rect = $rectOut"
} else {
    Note "not usable: $rectOut"
    if ($RestoreWindow) {
        Note "trying to restore from tray..."
        $r2 = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "ui-restore.ps1") -Yes 2>$null
        Note ($r2 -join " | ")
        $rectOut = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "ui-rect.ps1") 2>$null
        if ($rectOut -match '^\d+ \d+ \d+ \d+$') { Note "restored: rect = $rectOut" } else { Note "still not usable -> click the bot QQ tray icon manually" }
    } else {
        Note "minimized/hidden (normal: QQ only notifies while minimized). Sending restores it."
    }
}

# ---------- 3. bot process ----------
Step "3. bot process"
$bots = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'src[\\/]index\.ts' })
if ($bots.Count -gt 1) {
    Note ("WARNING: {0} bot instances running -> duplicate replies. Kill extras: {1}" -f $bots.Count, (($bots | ForEach-Object { $_.ProcessId }) -join ","))
}
if ($bots.Count -ge 1) {
    Note ("already running: pid {0}" -f (($bots | ForEach-Object { $_.ProcessId }) -join ","))
} elseif ($NoStartBot) {
    Note "not running (-NoStartBot)"
} else {
    # Delegate the actual launch: a direct child would be reaped when this shell exits,
    # start-bot.ps1 detaches via WScript.Shell.
    $s = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "start-bot.ps1") 2>&1
    Note ($s -join " | ")
    if ($s -match 'FAILED') { exit 2 }
}

# ---------- 4. verify ----------
Step "4. health check"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools "doctor.ps1")
$code = $LASTEXITCODE
Write-Output ""
# Legend for the exit code, NOT a result summary. The old wording was
# "(0 healthy / 1 degraded / 2 fatal)", which reads like "0 healthy items /
# 1 degraded / 2 fatal" and contradicts "VERDICT: HEALTHY" right above it.
# Keep this file ASCII-only: PowerShell 5.1 parses BOM-less scripts as ANSI and
# CJK comments here swallowed the following statement (the line never printed).
Write-Output ("recover exit={0} (exit code: 0=healthy 1=degraded 2=fatal)" -f $code)
exit $code
