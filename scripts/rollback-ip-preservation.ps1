[CmdletBinding()]
param([Parameter(Mandatory)][string]$ContextPath, [switch]$Execute)

$ErrorActionPreference = "Stop"
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
if (-not $context.BackupDir -or -not $context.Preflight.ServiceName -or -not $context.Items) { throw "contexto de rollback invalido" }
foreach ($item in $context.Items) {
  if ($item.OriginalExists) {
    if (-not (Test-Path -LiteralPath $item.Backup -PathType Leaf)) { throw "backup ausente: $($item.RelativePath)" }
    if ((Hash $item.Backup) -ne $item.OriginalSha256) { throw "hash do backup divergiu: $($item.RelativePath)" }
  }
}
if (-not $Execute) { Write-Output $ContextPath; exit 0 }

$serviceName = [string]$context.Preflight.ServiceName
Stop-Service -Name $serviceName -Force
foreach ($item in $context.Items) {
  if ($item.OriginalExists) {
    Copy-Item $item.Backup $item.Destination -Force
    if ((Hash $item.Destination) -ne $item.OriginalSha256) { throw "hash pos-rollback divergiu: $($item.RelativePath)" }
  } elseif (Test-Path -LiteralPath $item.Destination) {
    Remove-Item -LiteralPath $item.Destination -Force
    if (Test-Path -LiteralPath $item.Destination) { throw "arquivo novo nao foi removido: $($item.RelativePath)" }
  }
}
Start-Service -Name $serviceName
$health = Invoke-WebRequest -UseBasicParsing -Uri ([string]$context.Preflight.HealthUrl) -TimeoutSec 60
if ($health.StatusCode -ne 200) { throw "health check do rollback falhou" }
Write-Output $ContextPath
