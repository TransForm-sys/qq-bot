# Capture a screen rect to an uncompressed 24bpp BMP (used for send-receipt check).
# BMP so Node can read pixels without any image library. Read-only. ASCII-only.
param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Out)

if ($W -le 0 -or $H -le 0) { Write-Output "ERR_BAD_RECT ${W}x${H}"; exit 2 }
if (-not $Out) { Write-Output "ERR_NO_OUT"; exit 2 }

Add-Type -AssemblyName System.Drawing
try {
    $bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
    $g.Dispose()
    $dir = Split-Path $Out -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    Write-Output "ok ${W}x${H}"
} catch {
    Write-Output ("ERR_CAPTURE " + $_.Exception.Message)
    exit 3
}
