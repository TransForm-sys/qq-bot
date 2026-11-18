# Clear the focused input box: Ctrl+A then Delete. Run with -STA. ASCII-only.
# Used by the send-receipt self-test, and safe to use manually after a failed send.
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait("{DELETE}")
Start-Sleep -Milliseconds 120
Write-Output "cleared"
