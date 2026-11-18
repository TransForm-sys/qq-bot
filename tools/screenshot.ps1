# Capture the QQ main window region to a PNG in the workspace. ASCII-only.
param([string]$Out = "")
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root "data\ui\shot.png" }
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
# Bot instance only (fail closed: never screenshot another QQ instance).
$botPidFile = Join-Path $root "data\bot-pid.txt"
if (-not (Test-Path $botPidFile)) { Write-Output "ERR_NO_BOTPID"; exit 2 }
$bp = [int](Get-Content $botPidFile -Raw).Trim()
$proc = Get-Process -Id $bp -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output "ERR_BOT_PID_GONE pid=$bp"; exit 2 }
if ($proc.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output "ERR_BOT_WINDOW_MISSING pid=$bp"; exit 2 }
$h = $proc.MainWindowHandle
[WinRect]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[WinRect]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600
$r = New-Object WinRect+RECT
[WinRect]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Output "bad rect"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $ht))
$g.Dispose()
$dir = Split-Path $Out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("saved {0} rect={1},{2} {3}x{4} hwnd={5}" -f $Out, $r.L, $r.T, $w, $ht, $h)