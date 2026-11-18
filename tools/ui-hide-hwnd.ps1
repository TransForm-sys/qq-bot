# Hide / minimise ONE window by hwnd, whatever its class is.
#
# Why this exists: QQ's host frame (class Chrome_WidgetWin_0, untitled, ~full
# screen) can be restored by accident and then covers everything and owns the
# foreground, so every send fails with FOCUS_LOST. ui-restore / ui-rect only
# consider Chrome_WidgetWin_1 (the real chat window), so they cannot put it back.
#
# ASCII-only on purpose: PS 5.1 reads BOM-less .ps1 as ANSI, and a CJK comment
# swallows the statement that follows it.
param(
    [Parameter(Mandatory = $true)][int64]$Hwnd,
    [ValidateSet("hide", "minimize")][string]$Mode = "hide"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HideOne {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@

$h = [IntPtr]$Hwnd
if (-not [HideOne]::IsWindow($h)) { Write-Output "ERR_NOT_A_WINDOW $Hwnd"; exit 2 }

if ($Mode -eq "minimize") {
    [HideOne]::ShowWindow($h, 6) | Out-Null      # SW_MINIMIZE
} else {
    [HideOne]::ShowWindow($h, 0) | Out-Null      # SW_HIDE
}
Start-Sleep -Milliseconds 300

$vis = [HideOne]::IsWindowVisible($h)
$ico = [HideOne]::IsIconic($h)
Write-Output ("DONE hwnd={0} mode={1} visible={2} iconic={3}" -f $Hwnd, $Mode, $vis, $ico)
exit 0
