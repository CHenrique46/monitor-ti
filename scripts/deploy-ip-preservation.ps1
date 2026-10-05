[CmdletBinding()]
param(
  [string]$SourceRoot,
  [string]$ProductionRoot = "C:\Projetos\monitor-ti",
  [string]$ServiceName = "HenriTechServer",
  [string]$HealthUrl = "http://127.0.0.1:4000/health",
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = Split-Path -Parent $PSScriptRoot }

$files = @(
  [ordered]@{
    RelativePath = "server/src/networkIp.js"
    ExpectedSourceSha256 = "3d9de63175ffe9e0f4bb2230b5b99338317c271d766903fe1c810681539f9dbe"
    ExpectedCurrentSha256 = $null
    ExpectedCurrentExists = $false
  },
  [ordered]@{
    RelativePath = "server/src/ws/agentServer.js"
    ExpectedSourceSha256 = "3a1d32ab6ec35d27bda0dbcb9e4e1dc5f47cce26fd52dd4c1c15826bdb55d4c9"
    ExpectedCurrentSha256 = "91926d6fc6f5c02b968999e5922daff9b0580cf69716f2194ab639e70fd61e5f"
    ExpectedCurrentExists = $true
  }
)

function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function RequireFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label ausente: $Path" }
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if (-not $service) { throw "servico $ServiceName nao encontrado" }
$wrapperXml = "C:\ProgramData\HenriTech\service\HenriTechServer.xml"
RequireFile $wrapperXml "configuracao do wrapper"
[xml]$wrapper = Get-Content -Raw -LiteralPath $wrapperXml
if ([string]$service.PathName -notmatch '(?i)HenriTechServer\.exe') { throw "servico nao aponta para HenriTechServer.exe" }
if ([string]$wrapper.service.executable -notmatch '(?i)node\.exe' -or [string]$wrapper.service.arguments -ne "src/app.js") { throw "wrapper nao inicia node.exe src/app.js" }
if ([IO.Path]::GetFullPath([string]$wrapper.service.workingdirectory) -ne [IO.Path]::GetFullPath((Join-Path $ProductionRoot "server"))) { throw "workingdirectory do wrapper diverge" }

$records = @()
foreach ($file in $files) {
  $source = Join-Path $SourceRoot $file.RelativePath
  $destination = Join-Path $ProductionRoot $file.RelativePath
  RequireFile $source "fonte"
  $sourceHash = Hash $source
  if ($sourceHash -ne $file.ExpectedSourceSha256) { throw "hash da fonte divergiu: $($file.RelativePath)" }
  $exists = Test-Path -LiteralPath $destination -PathType Leaf
  $currentHash = if ($exists) { Hash $destination } else { $null }
  if ([bool]$exists -ne [bool]$file.ExpectedCurrentExists) { throw "presenca operacional divergiu: $($file.RelativePath)" }
  if ($exists -and $currentHash -ne $file.ExpectedCurrentSha256) { throw "hash operacional divergiu: $($file.RelativePath)" }
  $records += [ordered]@{
    RelativePath = $file.RelativePath
    Source = $source
    Destination = $destination
    ExpectedSourceSha256 = $file.ExpectedSourceSha256
    SourceSha256 = $sourceHash
    ExpectedCurrentSha256 = $file.ExpectedCurrentSha256
    CurrentSha256 = $currentHash
    CurrentExists = $exists
  }
}

$preflight = [ordered]@{
  ServiceName = $ServiceName
  ServiceState = [string]$service.State
  ServiceProcessId = [int]$service.ProcessId
  WrapperXml = $wrapperXml
  WrapperXmlSha256 = Hash $wrapperXml
  WrapperExecutable = [string]$wrapper.service.executable
  WrapperArguments = [string]$wrapper.service.arguments
  WrapperWorkingDirectory = [string]$wrapper.service.workingdirectory
  ProductionRoot = $ProductionRoot
  HealthUrl = $HealthUrl
  Files = $records
  AgentFilesIncluded = $false
  PortalTtlIncluded = $false
}
if (-not $Execute) { $preflight | ConvertTo-Json -Depth 8; exit 0 }

$backupRoot = "C:\ProgramData\HenriTech\backups"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$backupDir = Join-Path $backupRoot ("ip-preservation-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
$items = @()
foreach ($record in $records) {
  $backup = $null
  if ($record.CurrentExists) {
    $backup = Join-Path $backupDir $record.RelativePath
    New-Item -ItemType Directory -Path (Split-Path $backup) -Force | Out-Null
    Copy-Item $record.Destination $backup -Force
    if ((Hash $backup) -ne $record.ExpectedCurrentSha256) { throw "hash do backup divergiu: $($record.RelativePath)" }
  }
  $items += [ordered]@{ RelativePath = $record.RelativePath; Destination = $record.Destination; Backup = $backup; OriginalExists = $record.CurrentExists; OriginalSha256 = $record.ExpectedCurrentSha256; NewSha256 = $record.ExpectedSourceSha256 }
}
$contextPath = Join-Path $backupDir "deployment-context.json"
$context = [ordered]@{ CreatedAt = (Get-Date).ToUniversalTime().ToString("o"); BackupDir = $backupDir; Preflight = $preflight; Items = $items }
$context | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $contextPath -Encoding UTF8

try {
  Stop-Service -Name $ServiceName -Force
  $deadline = (Get-Date).AddSeconds(30)
  do { Start-Sleep -Milliseconds 500; $state = (Get-Service -Name $ServiceName).Status } while ($state -ne "Stopped" -and (Get-Date) -lt $deadline)
  if ($state -ne "Stopped") { throw "servico nao parou" }
  foreach ($record in $records) {
    New-Item -ItemType Directory -Path (Split-Path $record.Destination) -Force | Out-Null
    Copy-Item $record.Source $record.Destination -Force
    if ((Hash $record.Destination) -ne $record.ExpectedSourceSha256) { throw "hash pos-copia divergiu: $($record.RelativePath)" }
  }
  Start-Service -Name $ServiceName
  $deadline = (Get-Date).AddSeconds(60)
  do { Start-Sleep -Seconds 2; try { $health = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5 } catch { $health = $null } } while ((-not $health -or $health.StatusCode -ne 200) -and (Get-Date) -lt $deadline)
  if (-not $health -or $health.StatusCode -ne 200) { throw "health check falhou" }
  Write-Output $contextPath
} catch {
  try { if ((Get-Service -Name $ServiceName).Status -ne "Stopped") { Stop-Service -Name $ServiceName -Force } } catch {}
  foreach ($item in $items) {
    if ($item.OriginalExists) {
      if ((Hash $item.Backup) -ne $item.OriginalSha256) { throw "hash do backup divergiu: $($item.RelativePath)" }
      Copy-Item $item.Backup $item.Destination -Force
      if ((Hash $item.Destination) -ne $item.OriginalSha256) { throw "hash pos-rollback divergiu: $($item.RelativePath)" }
    } elseif (Test-Path -LiteralPath $item.Destination) {
      Remove-Item -LiteralPath $item.Destination -Force
      if (Test-Path -LiteralPath $item.Destination) { throw "arquivo novo nao foi removido: $($item.RelativePath)" }
    }
  }
  try { Start-Service -Name $ServiceName } catch {}
  throw
}
