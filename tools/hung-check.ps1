# Read-only hung check: does each top-level window of a pid still pump messages?
# Uses SendMessageTimeout(WM_NULL) with SMTO_ABORTIFHUNG | SMTO_BLOCK(3000ms).
# A window that does not answer within the timeout is genuinely hung (not just idle).
# ASCII-only.
param([int]$ProcId = 0, [int]$TimeoutMs = 3000)

if ($ProcId -le 0) { Write-Output "usage: hung-check.ps1 -ProcId <qq pid>"; exit 2 }

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HungChk {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    public static List<IntPtr> ByPid(uint target) {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == target) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

$procs = @(Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output ("ERR no such pid " + $ProcId); exit 1 }

$windows = [HungChk]::ByPid([uint32]$ProcId)
if ($windows.Count -eq 0) { Write-Output "ERR no top-level window for pid"; exit 1 }

$hung = 0
Write-Output ("pid {0}: {1} top-level window(s)" -f $ProcId, $windows.Count)
foreach ($h in $windows) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][HungChk]::GetClassName($h, $sb, 256)
    $cls = $sb.ToString()
    $vis = if ([HungChk]::IsWindowVisible($h)) { "visible" } else { "hidden" }
    $res = [IntPtr]::Zero
    # SMTO_ABORTIFHUNG(0x2) | SMTO_BLOCK(0x1)
    $ok = [HungChk]::SendMessageTimeout($h, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero, 0x3, [uint32]$TimeoutMs, [ref]$res)
    $state = if ($ok -eq [IntPtr]::Zero) { "HUNG"; $script:hung++ } else { "alive" }
    Write-Output ("  hwnd={0,-10} {1,-8} {2,-22} {3}" -f $h.ToInt64(), $vis, $cls, $state)
}
if ($hung -gt 0) { Write-Output ("VERDICT: {0} window(s) not responding within {1}ms" -f $hung, $TimeoutMs); exit 3 }
Write-Output "VERDICT: all windows responding"
exit 0
