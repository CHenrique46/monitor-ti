[CmdletBinding()]
param([Parameter(Mandatory)][string]$ContextPath, [switch]$Execute)

$ErrorActionPreference = "Stop"
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
if (-not $context.BackupDir -or -not $context.Preflight.ServiceName -or -not $context.Items) { throw "contexto de rollback inválido" }
foreach ($item in $context.Items) {
  if (-not (Test-Path -LiteralPath $item.Backup -PathType Leaf)) { throw "backup ausente: $($item.Backup)" }
  if ((Hash $item.Backup) -ne $item.Sha256) { throw "hash do backup divergiu: $($item.Backup)" }
}
if (-not $Execute) { Write-Output $ContextPath; exit 0 }

$serviceName = [string]$context.Preflight.ServiceName
Stop-Service -Name $serviceName -Force
foreach ($item in $context.Items) { Copy-Item $item.Backup $item.Destination -Force }
Start-Service -Name $serviceName
$health = Invoke-WebRequest -UseBasicParsing -Uri ([string]$context.Preflight.HealthUrl) -TimeoutSec 60
if ($health.StatusCode -ne 200) { throw "health check do rollback falhou" }
Write-Output $ContextPath
