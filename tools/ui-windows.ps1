# List top-level windows of every QQ.exe process (including hidden ones). Read-only. ASCII-only.
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    public static List<string> Run(HashSet<uint> pids) {
        var rows = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid)) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return true;
            int len = GetWindowTextLength(h);
            var t = new StringBuilder(len + 2);
            GetWindowText(h, t, len + 2);
            RECT r; GetWindowRect(h, out r);
            // minimized is its own state: QQ DOES raise a system notification for a
            // minimized window, but NOT for one hidden with SW_HIDE. The receive path
            // depends on that difference, so the state must be distinguishable.
            string st = !IsWindowVisible(h) ? "hidden" : (IsIconic(h) ? "minimized" : "visible");
            rows.Add(string.Format("{0}|{1}|{2}|{3}|{4}x{5}|{6}",
                pid, h.ToInt64(), st, cls.ToString(),
                r.R - r.L, r.B - r.T, t.ToString().Replace("|", "/")));
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
"@
$pids = New-Object System.Collections.Generic.HashSet[uint32]
Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
Write-Output "pid|hwnd|state|class|size|title"
[WinEnum]::Run($pids) | ForEach-Object { Write-Output $_ }
