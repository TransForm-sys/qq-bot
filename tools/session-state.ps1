# Print the interactive desktop state for the current session. Read-only. ASCII-only.
# ACTIVE  = desktop unlocked, SetForegroundWindow should work
# LOCKED  = workstation locked / secure desktop (all UI sending will fail with ERR_FOCUS_FAILED)
# UNKNOWN = query failed
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskState {
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
}
"@
try {
    $h = [DeskState]::OpenInputDesktop(0, $false, 0x0100)
    if ($h -eq [IntPtr]::Zero) { Write-Output "LOCKED"; exit 0 }
    [void][DeskState]::CloseDesktop($h)
    Write-Output "ACTIVE"
    exit 0
} catch {
    Write-Output "UNKNOWN"
    exit 1
}
