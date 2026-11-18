# Verify the FOREGROUND window still belongs to the bot QQ instance.
# Exit 0 = OK (safe to click/paste), 2 = focus lost (do NOT click), 3 = binding problem.
# Read-only: never changes focus. ASCII-only.
$root = Split-Path -Parent $PSScriptRoot
$botPidFile = Join-Path $root "data\bot-pid.txt"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FocusQ {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    public static List<long> TopWindows(uint pid) {
        var rows = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid != pid) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
            if (!IsWindowVisible(h)) return true;
            rows.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
"@

if (-not (Test-Path $botPidFile)) { Write-Output "ERR_NO_BOTPID"; exit 3 }
$raw = (Get-Content $botPidFile -Raw).Trim()
if ($raw -notmatch '^[0-9]+$') { Write-Output "ERR_BAD_BOTPID $raw"; exit 3 }
$bp = [uint32]$raw
$p = Get-Process -Id $bp -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "ERR_BOT_PID_GONE pid=$bp"; exit 3 }
if ($p.ProcessName -ne "QQ") { Write-Output "ERR_BOT_PID_NOT_QQ pid=$bp name=$($p.ProcessName)"; exit 3 }

$fg = [FocusQ]::GetForegroundWindow()
if ($fg -eq [IntPtr]::Zero) { Write-Output "ERR_NO_FOREGROUND"; exit 2 }

# foreground may be a child popup of the bot window -> compare owning pid first
$fgPid = [uint32]0
[void][FocusQ]::GetWindowThreadProcessId($fg, [ref]$fgPid)
if ($fgPid -ne $bp) { Write-Output "ERR_FOCUS_LOST fgPid=$fgPid botPid=$bp"; exit 2 }

$wins = [FocusQ]::TopWindows($bp)
if ($wins.Count -eq 0) { Write-Output "ERR_NO_BOT_WINDOW pid=$bp"; exit 3 }
Write-Output "OK pid=$bp fg=$($fg.ToInt64())"
exit 0
