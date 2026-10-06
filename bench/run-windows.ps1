# run-windows.ps1 [-NoBuild] [-Runs N] [-Port P] [-Work DIR] [-Out DIR]
# The Windows counterpart of run-macos.sh, for a physical Windows 11 x64
# machine nobody is using (.ai/22-app-plan.md § Definition of done). Written
# for WP-16; not yet run on Windows.
#
# Differences from macOS:
#   - the stand is set up here (stand.sh is POSIX sh); the fake claude runs
#     through a claude.cmd wrapper and reads keys with msvcrt under ConPTY,
#   - the app is the release executable; it opens on screen,
#   - procs-windows.ps1 measures the app's process tree (WebView2's
#     msedgewebview2.exe are its children); disk is WriteTransferCount,
#   - the hidden-window CPU row is not scripted; the window-state file lives in
#     the real %APPDATA% (Tauri asks Windows for it, not HOME).
# Needs: Go, Node 22, Rust, Python 3, Chrome for the phone harness.
param([switch]$NoBuild, [int]$Runs = 2, [int]$Port = 4393, [string]$Work = "$env:TEMP\caprock-bench", [string]$Out = "")
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path $here -Parent
if (-not $Out) { $Out = Join-Path $here ("results-" + (Get-Date -Format 'yyyy-MM-dd') + "-windows") }
New-Item -ItemType Directory -Force -Path $Work, $Out | Out-Null
$env:TMP = $Work; $env:TEMP = $Work

if (-not $NoBuild) {
  Push-Location $repo
  make ui; go build -o "$Work\caprock.exe" ./cmd/caprock; make app-sidecar
  Push-Location app; if (-not (Test-Path node_modules)) { npm ci }; npx tauri build --bundles nsis --features snapshot; Pop-Location
  Pop-Location
}
$exe = Join-Path $repo 'app\src-tauri\target\release\caprock-app.exe'
$installer = Get-ChildItem (Join-Path $repo 'app\src-tauri\target\release\bundle\nsis\*.exe') -ErrorAction SilentlyContinue | Select-Object -First 1
@{ dmg_mb = if ($installer) { [math]::Round($installer.Length / 1MB, 1) } else { $null }; note = 'the NSIS installer (download size row)' } | ConvertTo-Json | Set-Content (Join-Path $Out 'size.json')
node -e "import('file:///$($here -replace '\\','/')/lib.mjs').then((m) => console.log(JSON.stringify(m.machineInfo(), null, 2)))" | Set-Content (Join-Path $Out 'machine.json')

function Start-Stand([string]$D) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "port $Port is in use" }
  if ($Port -in 4173, 22776) { throw "refusing port $Port: a live daemon's port" }
  New-Item -ItemType Directory -Force -Path "$D\home", "$D\data", "$D\bin", "$D\snap" | Out-Null
  Copy-Item "$here\fake-claude" "$D\bin\fake-claude.py"
  Set-Content "$D\bin\claude.cmd" "@python `"$D\bin\fake-claude.py`" %*"
  Set-Content "$D\data\config.json" "{`"port`": $Port, `"update_checks`": false, `"open_browser`": false, `"notify_approval`": false, `"notify_finished`": false}"
  Set-Content "$D\data\app-hotkey.json" '{"accelerator": null}'
  Set-Content "$D\port" $Port
  Set-Content "$D\daemon.bin" "$Work\caprock.exe"
  python "$here\chat-transcript.py" "$D\home" | Set-Content "$D\chat-sid"
  1..10 | ForEach-Object { $w = "$D\work\s{0:D2}" -f $_; New-Item -ItemType Directory -Force -Path $w | Out-Null; Set-Content "$w\.fake_lps" 0 }
  $env:HOME = "$D\home"; $env:USERPROFILE = "$D\home"; $env:CAPROCK_DATA_DIR = "$D\data"; $env:CAPROCK_SERVICE_LABEL = 'dev.caprock.bench'
  $env:PATH = "$D\bin;$env:PATH"
  $p = Start-Process "$Work\caprock.exe" -ArgumentList 'up', '--foreground', '--no-hooks', '--no-open', '--port', $Port, '--data-dir', "$D\data" -PassThru -WindowStyle Hidden -RedirectStandardError "$D\daemon.log"
  Set-Content "$D\daemon.pid" $p.Id
  for ($i = 0; $i -lt 80; $i++) { try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }
  $sids = 1..10 | ForEach-Object {
    $w = ("$D\work\s{0:D2}" -f $_) -replace '\\', '/'
    (Invoke-RestMethod -Method Post "http://127.0.0.1:$Port/v1/agents" -ContentType 'application/json' -Body "{`"cwd`":`"$w`"}").session_id
  }
  Set-Content "$D\sids" ($sids -join "`n")
}

for ($r = 1; $r -le $Runs; $r++) {
  $D = "$Work\stand-r$r"
  if (Test-Path $D) { Remove-Item -Recurse -Force $D }
  Start-Stand $D
  node "$here\app.mjs" --stand $D --app $exe --out "$Out\app-r$r.json"
  node "$here\phone.mjs" --stand $D --out "$Out\phone-r$r.json"
  Stop-Process -Id (Get-Content "$D\daemon.pid") -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$D*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}
python "$here\report.py" $Out | Set-Content "$Out\summary.md"
python "$here\..\scripts\align-tables.py" "$Out\summary.md" | Out-Null
Get-Content "$Out\summary.md"
