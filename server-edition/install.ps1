# ForgeAI Server / Worker installer for Windows (x64 and ARM64).
# Right-click -> Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Port 4545] [-Main]
param([int]$Port = 4545, [switch]$Main)
$ErrorActionPreference = 'Stop'
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'ForgeAI-Server'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$plat = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$node = $null
try { $v = [version](& node -p "process.versions.node"); if ($v -ge [version]'22.5.0') { $node = (Get-Command node).Source } } catch {}
if (-not $node) {
  Write-Host 'Installing Node.js 22 (official build from nodejs.org)...'
  $base = 'https://nodejs.org/dist/latest-v22.x'
  try { $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content } catch { Write-Host 'Could not reach nodejs.org. Check the internet connection (or install Node.js 22.5+ yourself) and run this again.'; exit 1 }
  $line = ($sums -split "`n") | Where-Object { $_ -match "node-v22\.[0-9.]+-$plat\.zip$" } | Select-Object -First 1
  if (-not $line) { Write-Host "No Node.js 22 build for $plat."; exit 1 }
  $want, $file = ($line.Trim() -split '\s+')
  $zip = Join-Path $Dest $file
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { Remove-Item $zip; Write-Host 'Node.js download is damaged (checksum mismatch) - nothing installed. Try again.'; exit 1 }
  $nd = Join-Path $Dest 'node'; if (Test-Path $nd) { Remove-Item -Recurse -Force $nd }
  Expand-Archive $zip -DestinationPath $Dest; Remove-Item $zip
  Rename-Item (Join-Path $Dest ($file -replace '\.zip$', '')) 'node'
  $node = Join-Path $nd 'node.exe'
}
Write-Host "Copying ForgeAI to $Dest\app..."
$app = Join-Path $Dest 'app'; if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Copy-Item -Recurse (Join-Path $Src 'app') $app
$data = Join-Path $Dest 'data'; New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:AICORE_DATA = $data
$nodeArgs = @("`"$app\headless.js`"", '--port', $Port)
if (-not $Main) { $nodeArgs = @("`"$app\headless.js`"", '--worker', '--port', $Port) }
$info = $null
if (-not $Main) { $info = (& $node "$app\headless.js" --worker --port $Port --print-token 2>$null | Select-Object -Last 1) | ConvertFrom-Json }
# Start at sign-in, hidden, with the data folder set.
$cmd = "/c set AICORE_DATA=$data&& `"$node`" " + ($nodeArgs -join ' ')
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
Register-ScheduledTask -TaskName 'ForgeAI Server' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'ForgeAI Server'
try { New-NetFirewallRule -DisplayName "ForgeAI ($Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow -ErrorAction Stop | Out-Null } catch { Write-Host 'Note: run this once as administrator to allow ForgeAI through Windows Firewall on private networks.' }
Write-Host ''
if ($info) {
  Write-Host 'Done. On your main ForgeAI: Computers -> Add Computer -> Another computer running ForgeAI'
  Write-Host ('  Address: ' + (($info.addresses | ForEach-Object { "https://$($_):$($info.port)" }) -join '  or  '))
  Write-Host ('  Computer token: ' + $info.token)
  Write-Host 'Only use this on a private network or VPN (e.g. Tailscale).'
} else { Write-Host "Done. Open https://<this computer's address>:$Port from another computer to finish setup." }
