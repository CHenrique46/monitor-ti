[CmdletBinding()]
param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$ProductionRoot = "C:\Projetos\monitor-ti",
  [string]$ServiceName = "HenriTechServer",
  [string]$HealthUrl = "http://127.0.0.1:4000/health",
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$files = @(
  "server/src/controllers/agentUpdate.controller.js",
  "server/src/services/releases.service.js",
  "server/src/services/updateCommand.js",
  "server/src/ws/agentServer.js",
  "scripts/register-agent-release.js"
)

function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function RequireFile([string]$Path, [string]$Label) { if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label ausente: $Path" } }

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if (-not $service) { throw "serviço $ServiceName não encontrado; nenhuma alteração executada" }

$servicePath = [string]$service.PathName
$wrapperXml = "C:\ProgramData\HenriTech\service\HenriTechServer.xml"
RequireFile $wrapperXml "configuração do wrapper"
[xml]$wrapper = Get-Content -Raw -LiteralPath $wrapperXml
$wrapperExecutable = [string]$wrapper.service.executable
$wrapperArguments = [string]$wrapper.service.arguments
$wrapperWorkingDirectory = [string]$wrapper.service.workingdirectory
if ($servicePath -notmatch '(?i)HenriTechServer\.exe') { throw "PathName do serviço não aponta para o wrapper HenriTechServer" }
if ($wrapperExecutable -notmatch '(?i)node\.exe' -or $wrapperArguments -ne "src/app.js") { throw "configuração do wrapper não inicia node.exe src/app.js" }
if ([IO.Path]::GetFullPath($wrapperWorkingDirectory) -ne [IO.Path]::GetFullPath((Join-Path $ProductionRoot "server"))) { throw "workingdirectory do wrapper diverge do diretório efetivo" }
$serviceProcess = $null
if ([int]$service.ProcessId -gt 0) {
  $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)" -ErrorAction SilentlyContinue
}
$nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match '(?i)(^|[\\/])src[\\/]app\.js([\s"]|$)'
})
$associated = if ($serviceProcess -and $serviceProcess.Name -eq "node.exe") {
  @($serviceProcess)
} else {
  @($nodeProcesses | Where-Object { $_.ParentProcessId -eq $service.ProcessId })
}
if ($associated.Count -ne 1) { throw "processo node.exe associado ao serviço não foi resolvido unicamente; nenhuma alteração executada" }
if ($associated[0].CommandLine -notmatch '(?i)(^|[\\/])src[\\/]app\.js([\s"]|$)') { throw "processo associado não executa src/app.js" }

$sourceRecords = @()
foreach ($relative in $files) {
  $source = Join-Path $SourceRoot $relative
  $destination = Join-Path $ProductionRoot $relative
  RequireFile $source "fonte"
  RequireFile $destination "destino em produção"
  $sourceRecords += [ordered]@{ RelativePath = $relative; Source = $source; Destination = $destination; SourceSha256 = Hash $source; CurrentSha256 = Hash $destination }
}
$envPath = Join-Path $ProductionRoot "server\.env"
$envRecord = $null
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
  $envRecord = [ordered]@{ RelativePath = "server/.env"; Destination = $envPath; CurrentSha256 = Hash $envPath }
}

$preflight = [ordered]@{
  ServiceName = $ServiceName; ServicePathName = $servicePath; ServiceState = [string]$service.State
  WrapperXml = $wrapperXml; WrapperXmlSha256 = Hash $wrapperXml; WrapperExecutable = $wrapperExecutable
  WrapperArguments = $wrapperArguments; WrapperWorkingDirectory = $wrapperWorkingDirectory
  ServiceProcessId = [int]$service.ProcessId; AssociatedProcessId = [int]$associated[0].ProcessId
  AssociatedExecutable = [string]$associated[0].ExecutablePath; AssociatedCommandLine = [string]$associated[0].CommandLine
  ProductionRoot = $ProductionRoot; SourceRoot = $SourceRoot; HealthUrl = $HealthUrl
  Files = $sourceRecords; ExistingConfig = $envRecord
}
if (-not $Execute) {
  $preflight | ConvertTo-Json -Depth 6
  exit 0
}

$backupRoot = "C:\ProgramData\HenriTech\backups"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$backupDir = Join-Path $backupRoot ("agent-only-v129-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
$items = @()
foreach ($record in $sourceRecords) {
  $backup = Join-Path $backupDir $record.RelativePath
  New-Item -ItemType Directory -Path (Split-Path $backup) -Force | Out-Null
  Copy-Item $record.Destination $backup -Force
  $items += [ordered]@{ RelativePath = $record.RelativePath; Destination = $record.Destination; Backup = $backup; Sha256 = Hash $backup }
}
if ($envRecord) {
  $backup = Join-Path $backupDir "server/.env"
  New-Item -ItemType Directory -Path (Split-Path $backup) -Force | Out-Null
  Copy-Item $envRecord.Destination $backup -Force
  $items += [ordered]@{ RelativePath = "server/.env"; Destination = $envRecord.Destination; Backup = $backup; Sha256 = Hash $backup }
}
$contextPath = Join-Path $backupDir "deployment-context.json"
$context = [ordered]@{ CreatedAt = (Get-Date).ToUniversalTime().ToString("o"); BackupDir = $backupDir; Preflight = $preflight; Items = $items }
$context | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $contextPath -Encoding UTF8

try {
  Stop-Service -Name $ServiceName -Force
  $deadline = (Get-Date).AddSeconds(30)
  do { Start-Sleep -Milliseconds 500; $state = (Get-Service -Name $ServiceName).Status } while ($state -ne "Stopped" -and (Get-Date) -lt $deadline)
  if ($state -ne "Stopped") { throw "serviço não parou" }
  foreach ($record in $sourceRecords) { Copy-Item $record.Source $record.Destination -Force }
  Start-Service -Name $ServiceName
  $deadline = (Get-Date).AddSeconds(60)
  do { Start-Sleep -Seconds 2; try { $health = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5 } catch { $health = $null } } while ((-not $health -or $health.StatusCode -ne 200) -and (Get-Date) -lt $deadline)
  if (-not $health -or $health.StatusCode -ne 200) { throw "health check falhou" }
  Write-Output $contextPath
} catch {
  try { if ((Get-Service -Name $ServiceName).Status -ne "Stopped") { Stop-Service -Name $ServiceName -Force } } catch {}
  foreach ($item in $items) { if ((Hash $item.Backup) -ne $item.Sha256) { throw "hash do backup divergiu: $($item.Backup)" }; Copy-Item $item.Backup $item.Destination -Force }
  try { Start-Service -Name $ServiceName } catch {}
  throw
}
