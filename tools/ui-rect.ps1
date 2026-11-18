# Foreground the BOT QQ main window (bound via data\bot-pid.txt) and print "L T W H".
# FAIL CLOSED: never fall back to another QQ instance. ASCII-only.
#
# Window selection: MainWindowHandle is unreliable here (it can return QQ's 160x28
# floating window instead of the chat panel), so we enumerate the process's
# top-level Chrome_WidgetWin_* windows and take the LARGEST VISIBLE one.
$root = Split-Path -Parent $PSScriptRoot
$botPidFile = Join-Path $root "data\bot-pid.txt"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BotWin {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr h, bool fAlt);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint act, uint p1, ref uint p2, uint ini);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);

    // returns "hwnd|visible|x|y|w|h|class" for every Chrome_WidgetWin_* top-level window of pid
    public static List<string> WindowsOf(uint pid) {
        var rows = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            var cn = cls.ToString();
            if (!cn.StartsWith("Chrome_WidgetWin")) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            rows.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}|{6}",
                h.ToInt64(), IsWindowVisible(h) ? 1 : 0, r.L, r.T, r.R - r.L, r.B - r.T, cn));
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
"@

# --- bind to bot instance (no fallback) ---
if (-not (Test-Path $botPidFile)) { Write-Output "ERR_NO_BOTPID"; exit 2 }
$raw = (Get-Content $botPidFile -Raw).Trim()
if ($raw -notmatch '^[0-9]+$') { Write-Output "ERR_BAD_BOTPID $raw"; exit 2 }
$bp = [int]$raw
$p = Get-Process -Id $bp -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "ERR_BOT_PID_GONE pid=$bp"; exit 2 }
if ($p.ProcessName -ne "QQ") { Write-Output "ERR_BOT_PID_NOT_QQ pid=$bp name=$($p.ProcessName)"; exit 2 }

# --- pick the largest VISIBLE window >= threshold ---
$best = $null
$bestArea = 0
$hiddenBig = @()
$allLines = [BotWin]::WindowsOf([uint32]$bp)
foreach ($line in $allLines) {
    $f = $line -split '\|'
    # Chrome_WidgetWin_0 is QQ's invisible host frame (a 1440x753 untitled window).
    # It can pass every size check and would be clicked instead of the chat panel.
    if ($f[6] -ne 'Chrome_WidgetWin_1') { continue }
    $vis = $f[1] -eq '1'
    $w = [int]$f[4]; $h = [int]$f[5]
    if ($vis -and $w -ge 480 -and $h -ge 360) {
        if (($w * $h) -gt $bestArea) { $bestArea = $w * $h; $best = $f }
    } elseif ($w -ge 100) {
        # Two cases land here and both must be revived, not skipped:
        #   * hidden to tray  -> IsWindowVisible = 0
        #   * minimised       -> still WS_VISIBLE, but the rect is a bogus 160x28
        # Gating on the size of a parked window hides the real chat window from
        # the candidate list (that is exactly how sends started failing). The
        # 32x39 / 48x39 tray blobs are excluded by the 100px floor.
        $hiddenBig += ,$f
    }
}

# Parked in the tray: QQ hides / minimises the chat window, so a "largest VISIBLE
# window" search finds nothing and the send dies before it even starts. Revive the
# candidates here instead of pushing that job to the caller (send-ui only restores
# once per send).
#
# A minimised window reports a bogus 160x28 rect, which the size gate above throws
# away -- so the real chat window looks "too small" while some 800x600 side panel
# passes. Never trust the pre-restore size: restore every candidate, then pick the
# largest window that actually came back, and re-minimise the losers so they can
# not cover the chat window we are about to click.
if (-not $best) {
    $cand = @()
    $stateFile = Join-Path $root "data\ui-state.json"
    if (Test-Path $stateFile) {
        try {
            $st = Get-Content $stateFile -Raw | ConvertFrom-Json
            if ($st.hwnd) { $cand += [int64]$st.hwnd }
        } catch { }
    }
    foreach ($f in $hiddenBig) {
        $id = [int64]$f[0]
        if ($cand -notcontains $id) { $cand += $id }
    }
    $chosen = 0
    $chosenArea = 0
    $raised = @()
    foreach ($id in $cand) {
        [BotWin]::ShowWindow([IntPtr]$id, 9) | Out-Null
        Start-Sleep -Milliseconds 450
        $raised += $id
        $isVis = $false
        $isChat = $false
        $cw = 0; $ch = 0
        foreach ($line in [BotWin]::WindowsOf([uint32]$bp)) {
            $g = $line -split '\|'
            if ([int64]$g[0] -ne $id) { continue }
            $isVis = $g[1] -eq '1'
            $isChat = $g[6] -eq 'Chrome_WidgetWin_1'
            $cw = [int]$g[4]; $chh = [int]$g[5]
        }
        if ($isVis -and $isChat -and $cw -ge 480 -and $chh -ge 360 -and ($cw * $chh) -gt $chosenArea) {
            $chosenArea = $cw * $chh
            $chosen = $id
        }
    }
    if ($chosen -ne 0) {
        foreach ($id in $raised) {
            if ($id -ne $chosen) { [BotWin]::ShowWindow([IntPtr]$id, 6) | Out-Null }   # SW_MINIMIZE
        }
        foreach ($line in [BotWin]::WindowsOf([uint32]$bp)) {
            $g = $line -split '\|'
            if ([int64]$g[0] -eq $chosen -and $g[1] -eq '1' -and $g[6] -eq 'Chrome_WidgetWin_1') { $best = $g; $bestArea = $chosenArea }
        }
    }
}
if (-not $best) {
    if ($hiddenBig.Count -gt 0) { Write-Output "ERR_BOT_WINDOW_MISSING pid=$bp (window exists but hidden/tray)"; exit 2 }
    Write-Output "ERR_BOT_WINDOW_MISSING pid=$bp"; exit 2
}
$h = [IntPtr][int64]$best[0]

# --- force foreground, then verify it actually landed on the bot window ---
function Test-Fg([IntPtr]$win) {
    $cur = [BotWin]::GetForegroundWindow()
    if ($cur -eq $win) { return $true }
    if ($cur -eq [IntPtr]::Zero) { return $false }
    $pp = [uint32]0
    [void][BotWin]::GetWindowThreadProcessId($cur, [ref]$pp)
    return ($pp -eq [uint32]$bp)
}
function Grab([IntPtr]$win) {
    # SW_SHOW first, then SW_RESTORE: QQ parked in the tray is SW_HIDE'd, and
    # SW_RESTORE alone does not always bring a hidden window back on screen.
    [BotWin]::ShowWindow($win, 5) | Out-Null
    [BotWin]::ShowWindow($win, 9) | Out-Null
    $cur = [BotWin]::GetForegroundWindow()
    $cp = [uint32]0
    $tid = [BotWin]::GetWindowThreadProcessId($cur, [ref]$cp)
    $my = [BotWin]::GetCurrentThreadId()
    $att = $false
    if ($tid -ne 0 -and $tid -ne $my) { $att = [BotWin]::AttachThreadInput($tid, $my, $true) }
    [BotWin]::BringWindowToTop($win) | Out-Null
    [BotWin]::SetForegroundWindow($win) | Out-Null
    if ($att) { [BotWin]::AttachThreadInput($tid, $my, $false) | Out-Null }
    Start-Sleep -Milliseconds 260
}

Grab $h
if (-not (Test-Fg $h)) {
    # ALT tap grants foreground rights in most cases, then retry once
    [BotWin]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
    [BotWin]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    Grab $h
}
if (-not (Test-Fg $h)) {
    # Last resort: drop the foreground-lock timeout for a moment. Without this a
    # desktop app owning the foreground (browser / chat client / IDE) blocks
    # SetForegroundWindow indefinitely and every single send dies with FOCUS_LOST.
    $old = [uint32]0
    $got = [BotWin]::SystemParametersInfo(0x2000, 0, [ref]$old, 0)
    $zero = [uint32]0
    [void][BotWin]::SystemParametersInfo(0x2001, 0, [ref]$zero, 0x2)
    Start-Sleep -Milliseconds 80
    Grab $h
    if (-not (Test-Fg $h)) { [BotWin]::SwitchToThisWindow($h, $true) | Out-Null }
    Start-Sleep -Milliseconds 300
    if ($got) { [void][BotWin]::SystemParametersInfo(0x2001, $old, [ref]$zero, 0x2) }
}
if (-not (Test-Fg $h)) { Write-Output "ERR_FOCUS_FAILED pid=$bp"; exit 3 }

# QQ sometimes falls back to its tray mode a few hundred ms after SW_RESTORE, so
# the caller gets a valid-looking rect for a window that is no longer on screen --
# every screenshot then returns the bare desktop and the send "succeeds" into
# nothing. Confirm it stays really visible before handing out the geometry.
for ($k = 0; $k -lt 3; $k++) {
    if ([BotWin]::IsWindowVisible($h) -and -not [BotWin]::IsIconic($h)) { break }
    Start-Sleep -Milliseconds 220
    Grab $h
}
if (-not [BotWin]::IsWindowVisible($h) -or [BotWin]::IsIconic($h)) {
    Write-Output "ERR_WINDOW_VANISHED pid=$bp (window collapses right after restore)"
    exit 3
}

# --- geometry ---
$r = New-Object BotWin+RECT
[BotWin]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L
$ht = $r.B - $r.T
if ($w -lt 480 -or $ht -lt 360) { Write-Output "ERR_WINDOW_TOO_SMALL ${w}x${ht}"; exit 4 }

# Remember which hwnd worked; ui-restore will prefer it next time.
$state = @{
    hwnd = $h.ToInt64()
    l    = $r.L
    t    = $r.T
    w    = $w
    h    = $ht
    at   = (Get-Date).ToString("s")
}
try {
    $state | ConvertTo-Json | Out-File (Join-Path $root "data\ui-state.json") -Encoding ASCII
} catch { }

Write-Output ("{0} {1} {2} {3}" -f $r.L, $r.T, $w, $ht)
