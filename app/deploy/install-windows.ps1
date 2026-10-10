# ForgeAI command-line installer for Windows (served by a ForgeAI hub, or run by hand).
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 [-Exe "Install ForgeAI (x64).exe"] [-Hub host:port -Key KEY]
#        [-Priority low|lowest|normal] [-NoYield] [-Lend idle|always|never] [-HideIcon] [-AutoStart] [-AllUsers] [-NoStart] [-Name NAME]
#
# Runs the normal ForgeAI installer silently (/S). With -AllUsers (needs admin) it installs for every user of the
# computer under Program Files — use that when pushing from a management tool that runs as SYSTEM.
param([string]$Exe = '', [string]$Hub = '__HUB__', [string]$Key = '__KEY__', [string]$Join = '__JOIN__', [string]$Priority = 'low', [switch]$NoYield, [string]$Lend = '',
      [switch]$HideIcon, [switch]$AutoStart, [switch]$AllUsers, [switch]$NoStart, [switch]$Service, [string]$Name = '')
$ErrorActionPreference = 'Stop'
if ($Hub -like '__*') { $Hub = '' }; if ($Key -like '__*') { $Key = '' }; if ($Join -like '__*') { $Join = '' }
if ($Hub -and -not $Lend) { $Lend = 'idle' }
if (@('low','lowest','normal') -notcontains $Priority) { throw '-Priority must be low, lowest or normal' }
$tmp = Join-Path $env:TEMP ('forgeai-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if (-not $Exe) {
    if (-not $Join -and -not ($Hub -and $Key)) { throw 'Give -Exe "Install ForgeAI (x64).exe", or -Join (or -Hub and -Key) to download from a ForgeAI hub' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }  # the hub uses its own certificate; files are checked against its checksum list
    $wc = New-Object Net.WebClient
    $zip = Join-Path $tmp 'ForgeAI-Windows.zip'
    Write-Host "Downloading ForgeAI from $Hub..."
    $dlKey = $Key
    if (-not $dlKey -and $Join -match '^FGJ1\.(.+)$') { try { $jj = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($Matches[1] -replace '-','+' -replace '_','/').PadRight([int]([math]::Ceiling($Matches[1].Length/4.0)*4),'='))) | ConvertFrom-Json; $dlKey = $jj.k; if (-not $Hub) { $Hub = $jj.a[0] } } catch {} }
    if (-not $Hub) { throw 'Could not read the hub address from the join string' }
    $wc.DownloadFile("https://$Hub/node/deploy/file/ForgeAI-Windows.zip?key=$dlKey", $zip)
    try { $sums = $wc.DownloadString("https://$Hub/node/deploy/file/SHA256SUMS.txt?key=$dlKey"); $want = ($sums -split "`n" | Where-Object { $_ -match 'ForgeAI-Windows.zip' } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
      if ($want) { $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower(); if ($got -ne $want.ToLower()) { throw 'Checksum mismatch - the download was damaged or changed' } ; Write-Host 'Checksum OK' } } catch [System.Net.WebException] { Write-Host '(no checksum list on the hub - skipping check)' }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $Exe = Get-ChildItem -Path $tmp -Recurse -Filter "Install ForgeAI*($arch).exe" | Select-Object -First 1 -ExpandProperty FullName
    if (-not $Exe) { throw "Installer for $arch not found in the download" }
  }
  $args = @('/S', "/PRIORITY=$Priority")
  if ($Join) { $args += "/JOIN=$Join" } else { if ($Hub) { $args += "/HUB=$Hub" }; if ($Key) { $args += "/KEY=$Key" } }
  if ($Lend) { $args += "/LEND=$Lend" }; if ($Name) { $args += "/NAME=$Name" }; if ($NoYield) { $args += '/NOYIELD' }
  if ($Service) {
    # Background service: runs as the computer (SYSTEM) at boot, one copy per PC, no window or icon. Needs admin.
    $args += '/SERVICE'
  } else {
    if ($HideIcon) { $args += '/HIDEICON' }; if ($AutoStart) { $args += '/AUTOSTART' }; if ($AllUsers) { $args += '/ALLUSERS' }; if (-not $NoStart) { $args += '/START' }
  }
  Write-Host 'Installing ForgeAI silently...'
  $p = Start-Process -FilePath $Exe -ArgumentList $args -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "The installer exited with code $($p.ExitCode)" }
  Write-Host 'ForgeAI installed.'; if ($Service) { Write-Host 'Running as the ForgeAI background service (one copy per computer, starts at boot).' }; if ($Hub -or $Join) { Write-Host 'It joins your hub by itself when it starts.' }
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
