# Restore the BOT QQ main window from tray/hidden state. ASCII-only.
# Dry-run by default: only lists candidates. Pass -Yes to actually show a window.
#
# Which window is the "main panel"? Not the largest by current rect: QQ's main panel
# collapses to a 160x28 strip when closed to tray, while an 800x600 side panel can be
# bigger. So we first try the hwnd recorded in data\ui-state.json (the one that last
# produced a valid ui-rect), then fall back to largest-area search.
#
#   -Hwnd <n>   target one specific window (debug)
#   -Hide       hide the given -Hwnd instead of showing it
#   -Minimize   minimize it instead of hiding (SW_MINIMIZE). Less drastic than -Hide:
#               the window keeps painting normally when restored, and some QQ versions
#               only raise toasts for a *minimized* window.
param([switch]$Yes, [int64]$Hwnd = 0, [switch]$Hide, [switch]$Minimize)

$root = Split-Path -Parent $PSScriptRoot
$botPidFile = Join-Path $root "data\bot-pid.txt"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class RestoreWin {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    public static List<string> WindowsOf(uint pid) {
        var rows = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (!cls.ToString().StartsWith("Chrome_WidgetWin_1")) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            rows.Add(string.Format("{0}|{1}|{2}|{3}",
                h.ToInt64(), IsWindowVisible(h) ? 1 : 0, r.R - r.L, r.B - r.T));
            return true;
        }, IntPtr.Zero);
        return rows;
    }
    public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
    public static string SizeOf(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return "0x0";
        return (r.R - r.L) + "x" + (r.B - r.T);
    }
}
"@

if (-not (Test-Path $botPidFile)) { Write-Output "ERR_NO_BOTPID"; exit 2 }
$bp = [int](Get-Content $botPidFile -Raw).Trim()
$p = Get-Process -Id $bp -ErrorAction SilentlyContinue
if (-not $p -or $p.ProcessName -ne "QQ") { Write-Output "ERR_BOT_PID_BAD pid=$bp"; exit 2 }

$cands = @()
foreach ($line in [RestoreWin]::WindowsOf([uint32]$bp)) {
    $f = $line -split '\|'
    $cands += [pscustomobject]@{ Hwnd = [IntPtr][int64]$f[0]; Visible = $f[1] -eq '1'; W = [int]$f[2]; H = [int]$f[3] }
}
$stateFile = Join-Path $root "data\ui-state.json"

# -Hide: put the bot main window away and exit.
# Used right after a send: QQ raises a system notification only while its chat
# window is NOT in the foreground, and the whole receive path (R3) depends on
# those notifications. Sending puts the window in the foreground, so without
# this the next incoming message is silently never delivered.
if ($Hide -or $Minimize) {
    $target = $null
    if ($Hwnd -ne 0) { $target = $cands | Where-Object { $_.Hwnd.ToInt64() -eq $Hwnd } | Select-Object -First 1 }
    if (-not $target -and (Test-Path $stateFile)) {
        try {
            $st = [System.IO.File]::ReadAllText($stateFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($st.hwnd) {
                $target = $cands | Where-Object { $_.Hwnd.ToInt64() -eq [int64]$st.hwnd } | Select-Object -First 1
            }
        } catch { }
    }
    if (-not $target) { $target = $cands | Where-Object { $_.Visible -and $_.W -ge 480 -and $_.H -ge 360 } | Select-Object -First 1 }
    if (-not $target) { $target = $cands | Select-Object -First 1 }
    if (-not $target) { Write-Output "ERR_NO_CANDIDATE pid=$bp"; exit 2 }
    if ($Minimize) {
        [RestoreWin]::ShowWindow($target.Hwnd, 9) | Out-Null    # SW_RESTORE first (hidden -> minimizable)
        Start-Sleep -Milliseconds 250
        [RestoreWin]::ShowWindow($target.Hwnd, 6) | Out-Null    # SW_MINIMIZE
        Start-Sleep -Milliseconds 250
        Write-Output ("MINIMIZED hwnd={0} was {1}x{2}" -f $target.Hwnd, $target.W, $target.H)
        exit 0
    }
    [RestoreWin]::ShowWindow($target.Hwnd, 0) | Out-Null
    Write-Output ("HIDDEN hwnd={0} was {1}x{2}" -f $target.Hwnd, $target.W, $target.H)
    exit 0
}

# order: explicit -Hwnd > hwnd recorded in ui-state.json > largest current area
$prefer = [int64]$Hwnd
if ($prefer -eq 0 -and (Test-Path $stateFile)) {
    try {
        $st = [System.IO.File]::ReadAllText($stateFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($st.hwnd) { $prefer = [int64]$st.hwnd }
    } catch { }
}
# The main panel collapses to a tiny strip (e.g. 160x28) when closed to tray,
# so "largest area" would miss it: try small-but-visible windows first (Order=0),
# then everything else by descending area (Order=1).
$cands = $cands | ForEach-Object {
    $o = 1
    if ($_.Visible -and ($_.W -le 300 -or $_.H -le 60)) { $o = 0 }
    $_ | Add-Member -NotePropertyName Order -NotePropertyValue $o -PassThru
}
$cands = $cands | Sort-Object Order, @{ Expression = { $_.W * $_.H }; Descending = $true }

if (-not $cands) { Write-Output "ERR_NO_CANDIDATE pid=$bp"; exit 2 }

if ($prefer -ne 0) {
    $hit = @($cands | Where-Object { $_.Hwnd.ToInt64() -eq $prefer })
    if ($hit.Count) {
        $cands = $hit + @($cands | Where-Object { $_.Hwnd.ToInt64() -ne $prefer })
        Write-Output ("preferring hwnd={0} (from {1})" -f $prefer, $(if ($Hwnd -ne 0) { "-Hwnd" } else { "ui-state.json" }))
    }
}

Write-Output "candidates for pid ${bp}:"
$i = 0
foreach ($c in $cands) {
    Write-Output ("  [{0}] hwnd={1} visible={2} {3}x{4}" -f $i, $c.Hwnd, $c.Visible, $c.W, $c.H)
    $i++
}

# already has a usable visible window -> nothing to do
$already = $cands | Where-Object { $_.Visible -and $_.W -ge 480 -and $_.H -ge 360 } | Select-Object -First 1
if ($already) { Write-Output ("ALREADY_OK hwnd={0} {1}x{2}" -f $already.Hwnd, $already.W, $already.H); exit 0 }

if (-not $Yes) {
    Write-Output "DRY-RUN: nothing changed. Re-run with -Yes to restore the largest candidate."
    exit 0
}

foreach ($c in $cands) {
    $wasVisible = $c.Visible
    [RestoreWin]::ShowWindow($c.Hwnd, 9) | Out-Null   # SW_RESTORE
    Start-Sleep -Milliseconds 600
    $vis = [RestoreWin]::Visible($c.Hwnd)
    $sz = [RestoreWin]::SizeOf($c.Hwnd)
    $wh = $sz -split 'x'
    if ($vis -and [int]$wh[0] -ge 480 -and [int]$wh[1] -ge 360) {
        [RestoreWin]::SetForegroundWindow($c.Hwnd) | Out-Null
        Write-Output ("RESTORED hwnd={0} {1}" -f $c.Hwnd, $sz)
        exit 0
    }
    if (-not $wasVisible) { [RestoreWin]::ShowWindow($c.Hwnd, 0) | Out-Null }   # SW_HIDE, revert
    Write-Output ("  skip hwnd={0} ({1})" -f $c.Hwnd, $sz)
}
Write-Output "ERR_RESTORE_FAILED: no candidate became a usable window; click the bot tray icon manually"
exit 2
