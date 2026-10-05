[CmdletBinding()]
param(
  [string]$SourceRoot,
  [string]$ProductionRoot = "C:\Projetos\monitor-ti",
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = Split-Path -Parent $PSScriptRoot }

$relativePath = "scripts/register-agent-release.js"
$expectedSourceSha256 = "932f1efd02548c3d5bc6a8b1a01384e5dc0209018a89df74a7a290d828e3128e"
$expectedCurrentSha256 = "2edca1393cf130b080b011c2dec5ca47dfecc466e8b262d7601a6e21da553519"

function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function RequireFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label ausente: $Path" }
}

$source = Join-Path $SourceRoot $relativePath
$destination = Join-Path $ProductionRoot $relativePath
RequireFile $source "fonte"
RequireFile $destination "destino operacional"

$sourceSha256 = Hash $source
$currentSha256 = Hash $destination
if ($sourceSha256 -ne $expectedSourceSha256) { throw "hash da fonte divergiu: esperado $expectedSourceSha256, obtido $sourceSha256" }
if ($currentSha256 -ne $expectedCurrentSha256) { throw "hash operacional divergiu: esperado $expectedCurrentSha256, obtido $currentSha256" }

$preflight = [ordered]@{
  RelativePath = $relativePath
  Source = $source
  Destination = $destination
  ExpectedSourceSha256 = $expectedSourceSha256
  SourceSha256 = $sourceSha256
  ExpectedCurrentSha256 = $expectedCurrentSha256
  CurrentSha256 = $currentSha256
  RestartRequired = $false
}
if (-not $Execute) {
  $preflight | ConvertTo-Json -Depth 5
  exit 0
}

$backupRoot = "C:\ProgramData\HenriTech\backups"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$backupDir = Join-Path $backupRoot ("agent-release-registrar-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $backupDir -ErrorAction Stop | Out-Null
$backup = Join-Path $backupDir $relativePath
New-Item -ItemType Directory -Path (Split-Path $backup) -Force | Out-Null
Copy-Item $destination $backup -Force
$backupSha256 = Hash $backup
if ($backupSha256 -ne $expectedCurrentSha256) { throw "hash do backup divergiu: esperado $expectedCurrentSha256, obtido $backupSha256" }

$contextPath = Join-Path $backupDir "deployment-context.json"
$context = [ordered]@{
  CreatedAt = (Get-Date).ToUniversalTime().ToString("o")
  BackupDir = $backupDir
  Preflight = $preflight
  Item = [ordered]@{
    RelativePath = $relativePath
    Destination = $destination
    Backup = $backup
    OriginalSha256 = $expectedCurrentSha256
    NewSha256 = $expectedSourceSha256
  }
}
$context | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $contextPath -Encoding UTF8

try {
  Copy-Item $source $destination -Force
  $postSha256 = Hash $destination
  if ($postSha256 -ne $expectedSourceSha256) { throw "hash pos-copia divergiu: esperado $expectedSourceSha256, obtido $postSha256" }
  Write-Output $contextPath
} catch {
  if ((Hash $backup) -ne $expectedCurrentSha256) { throw "hash do backup divergiu durante rollback: $backup" }
  Copy-Item $backup $destination -Force
  if ((Hash $destination) -ne $expectedCurrentSha256) { throw "hash pos-rollback divergiu: esperado $expectedCurrentSha256" }
  throw
}
