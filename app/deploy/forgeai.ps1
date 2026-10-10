# ForgeAI command-line tool (Windows). Installed on PATH by the ForgeAI installer (via forgeai.cmd).
#   forgeai status | start | stop | restart | open [--web] | device status | version | help
# Talks only to the ForgeAI service on this computer (loopback). Manage other computers from your hub.
param([Parameter(ValueFromRemainingArguments=$true)]$Args)
$ErrorActionPreference = 'SilentlyContinue'
[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
$cmd = if ($Args.Count -ge 1) { $Args[0] } else { 'help' }
$sub = if ($Args.Count -ge 2) { $Args[1] } else { '' }

function Get-Url {
  $dirs = @("$env:ProgramData\ForgeAI\data", "$env:APPDATA\ForgeAI\data", "$env:LOCALAPPDATA\ForgeAI\data")
  foreach ($d in $dirs) {
    $f = Join-Path $d 'runtime.json'
    if (Test-Path $f) { try { $u = (Get-Content $f -Raw | ConvertFrom-Json).url } catch { $u = $null }
      if ($u) { try { Invoke-RestMethod "$u/api/ping" -TimeoutSec 2 | Out-Null; return $u } catch {} } }
  }
  foreach ($p in 4545,4600,39280,8777) { foreach ($s in 'http','https') {
    try { Invoke-RestMethod "${s}://127.0.0.1:${p}/api/ping" -TimeoutSec 1 | Out-Null; return "${s}://127.0.0.1:${p}" } catch {} } }
  return $null
}
function Ping($u) { try { Invoke-RestMethod "$u/api/ping" -TimeoutSec 3 } catch { $null } }
$svc = 'ForgeAI'

switch ($cmd) {
  'status' {
    $u = Get-Url
    if ($u) { $j = Ping $u
      Write-Host "ForgeAI is running  ($u)"
      Write-Host ("  version:  " + $j.version)
      Write-Host ("  mode:     " + $(if ($j.managed) { 'background service' } else { 'application' }))
      Write-Host ("  account:  " + $(if ($j.claimed) { 'set up' } else { 'not set up - available to claim' }))
    } else { Write-Host 'ForgeAI is not running on this computer.'; exit 1 } }
  'start'   { if (Get-Service $svc) { Start-Service $svc; Write-Host 'ForgeAI starting.' } else { Start-Process 'ForgeAI.exe' -ArgumentList '--hidden'; Write-Host 'ForgeAI starting.' } }
  'stop'    { if (Get-Service $svc) { Stop-Service $svc; Write-Host 'ForgeAI stopped.' } else { Stop-Process -Name ForgeAI -Force; Write-Host 'ForgeAI stopped.' } }
  'restart' { if (Get-Service $svc) { Restart-Service $svc; Write-Host 'ForgeAI restarting.' } else { Stop-Process -Name ForgeAI -Force; Start-Sleep 1; Start-Process 'ForgeAI.exe' -ArgumentList '--hidden'; Write-Host 'ForgeAI restarting.' } }
  'open' {
    if ($sub -eq '--web') { $u = Get-Url; if ($u) { Start-Process $u } else { Write-Host 'ForgeAI is not running. Start it with: forgeai start' } }
    else { $exe = Get-Command ForgeAI.exe -ErrorAction SilentlyContinue; if ($exe) { Start-Process $exe.Source } else { $u = Get-Url; if ($u) { Start-Process $u } else { Write-Host 'ForgeAI app not found and service not running.' } } } }
  'device' {
    if ($sub -eq 'status') { $u = Get-Url
      if ($u) { $j = Ping $u
        Write-Host 'This computer:'
        Write-Host ("  " + $(if ($j.claimed) { 'Set up with an owner account.' } else { 'Not set up yet - available to claim from another ForgeAI.' }))
        Write-Host ("  " + $(if ($j.joined) { 'Joined to a hub.' } else { 'Not joined to a hub.' }))
      } else { Write-Host 'ForgeAI is not running on this computer.'; exit 1 } }
    else { Write-Host 'Usage: forgeai device status' } }
  'version' { $u = Get-Url; if ($u) { Write-Host ("ForgeAI " + (Ping $u).version) } else { Write-Host 'ForgeAI (not running)' } }
  default {
@"
ForgeAI - control the ForgeAI service on this computer.

  forgeai status            is it running, which version, is it set up
  forgeai start             start the background service / app
  forgeai stop              stop it
  forgeai restart           restart it
  forgeai open              open the ForgeAI app window
  forgeai open --web        open the ForgeAI dashboard in a browser
  forgeai device status     show whether this computer is set up and joined to a hub
  forgeai version           show the version

ForgeAI only ever controls this computer. Manage other computers from your hub.
"@ | Write-Host }
}
