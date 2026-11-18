# Click at screen coordinates. ASCII-only.
param([int]$X, [int]$Y, [switch]$Double)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
[Mouse]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 120
[Mouse]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Mouse]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
if ($Double) {
    Start-Sleep -Milliseconds 80
    [Mouse]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Mouse]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)
}
Write-Output "clicked $X,$Y double=$Double"