# Paste text into the focused input via clipboard + Ctrl+V. Run with -STA. ASCII-only.
param([string]$Text, [switch]$Enter)
Add-Type -AssemblyName System.Windows.Forms
# Empty text must NOT paste: Clipboard::SetText("") throws, and Ctrl+V would then paste
# whatever stale content is still on the clipboard -> wrong message sent.
if ([string]::IsNullOrEmpty($Text)) {
    if ($Enter) { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
    Write-Output "pasted len=0 enter=$Enter (skipped)"
    exit 0
}
$old = $null
try { $old = [System.Windows.Forms.Clipboard]::GetText() } catch {}
[System.Windows.Forms.Clipboard]::SetText($Text)
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 250
if ($Enter) {
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 250
}
if ($old) { Start-Sleep -Milliseconds 600; try { [System.Windows.Forms.Clipboard]::SetText($old) } catch {} }
Write-Output "pasted len=$($Text.Length) enter=$Enter"