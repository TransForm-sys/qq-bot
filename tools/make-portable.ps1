# Build a portable zip of qq-bot for another machine (a VM, or a second PC).
# Excludes runtime junk: memory dumps, DB copies, logs, screenshots, pid bindings.
# Keeps: source, tools, config (with API keys), persona, memory sessions, plugin data.
# ASCII-only.
#
#   powershell -File tools\make-portable.ps1
#   powershell -File tools\make-portable.ps1 -Out D:\qq-bot-portable.zip
#
param([string]$Out = "")

$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root "qq-bot-portable.zip" }

$stage = Join-Path $env:TEMP ("qqbot-pack-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
if (Test-Path $stage) { Remove-Item -Path $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Copy-Dir($rel) {
    $src = Join-Path $root $rel
    if (-not (Test-Path $src)) { return }
    $dst = Join-Path $stage $rel
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
}

# ---- code ----
foreach ($d in @("src", "webui", "tools", "plugins", "patch")) { Copy-Dir $d }

# ---- root files ----
foreach ($f in @("package.json", "config.json", "persona.md", "HANDOFF.md", "WEBUI.md", "RECOVERY.md", "OFFLINE-RISKS.md", "VM-SETUP.md")) {
    $src = Join-Path $root $f
    if (Test-Path $src) { Copy-Item -Path $src -Destination (Join-Path $stage $f) -Force }
}
# launchers have non-ASCII names (Chinese); enumerate them instead of hardcoding,
# because PS 5.1 reads this script as ANSI and would mangle the literals.
Get-ChildItem -Path $root -Filter "*.bat" -File -ErrorAction SilentlyContinue |
    ForEach-Object { Copy-Item -Path $_.FullName -Destination (Join-Path $stage $_.Name) -Force }

# ---- keep state that is expensive to recreate (memory + plugin data only) ----
foreach ($d in @("data\sessions", "data\plugins")) {
    $src = Join-Path $root $d
    $dst = Join-Path $stage $d
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    if (Test-Path $src) { Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue }
}
# make sure the runtime dir exists even if both were empty
New-Item -ItemType Directory -Path (Join-Path $stage "data") -Force | Out-Null

# ---- strip things that must be regenerated on the new machine ----
$drop = @(
    "data\bot-pid.txt",      # pid binding is per-machine
    "data\ui-state.json",    # window handle is per-machine
    "data\heartbeat.json",   # stale beat would trigger watchdog immediately
    "data\alerts.jsonl"      # old alerts would show up as red banners
)
foreach ($f in $drop) {
    $p = Join-Path $stage $f
    if (Test-Path $p) { Remove-Item -Path $p -Force }
}
Get-ChildItem -Path $stage -Recurse -Include "*.log", "*.bmp", "*.bin" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

# ---- zip ----
if (Test-Path $Out) { Remove-Item -Path $Out -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $Out -CompressionLevel Optimal -Force
Remove-Item -Path $stage -Recurse -Force

$zip = Get-Item $Out
$count = (Get-ChildItem -Path $Out | Out-Null); # noop keeps PS happy
Write-Output ("PACKED {0}" -f $zip.FullName)
Write-Output ("SIZE   {0:N1} MB" -f ($zip.Length / 1MB))
Write-Output ("HINT   copy this zip into the VM, then: Expand-Archive -Path <zip> -DestinationPath C:\qq-bot -Force")
