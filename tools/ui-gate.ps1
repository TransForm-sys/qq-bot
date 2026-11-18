# Report desktop idle time and whether the bot QQ window is already in front.
# Output: "idle=<ms> fg=<0|1> follow=<0|1>"
#   idle   = ms since the user last touched keyboard/mouse (GetLastInputInfo)
#   fg     = 1 if the foreground window belongs to the bot QQ process
#   follow = 1 if the foreground window is a DIFFERENT window of the same
#            machine but the bot is not in front (kept for future policy)
# ASCII-only. Read-only: no clicks, no focus changes.
$root = Split-Path -Parent $PSScriptRoot
$botPidFile = Join-Path $root "data\bot-pid.txt"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleGate {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static uint IdleMs() {
        LASTINPUTINFO li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(li);
        if (!GetLastInputInfo(ref li)) return 0;
        uint now = GetTickCount();
        uint last = li.dwTime;
        // GetTickCount wraps every ~49.7 days; unsigned subtraction handles it
        return now - last;
    }
    public static uint FgPid() {
        uint pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
}
"@

$idle = [IdleGate]::IdleMs()
$fgPid = [IdleGate]::FgPid()

$botPid = 0
if (Test-Path $botPidFile) {
    $raw = (Get-Content $botPidFile -Raw).Trim()
    if ($raw -match '^[0-9]+$') { $botPid = [int]$raw }
}

$fg = 0
if ($botPid -gt 0 -and $fgPid -eq $botPid) { $fg = 1 }

Write-Output ("idle={0} fg={1}" -f $idle, $fg)
