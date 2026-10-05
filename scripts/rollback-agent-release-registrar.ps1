[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ContextPath,
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
if (-not $context.BackupDir -or -not $context.Item) { throw "contexto de rollback invalido" }
if (-not (Test-Path -LiteralPath $context.Item.Backup -PathType Leaf)) { throw "backup ausente: $($context.Item.Backup)" }
if ((Hash $context.Item.Backup) -ne $context.Item.OriginalSha256) { throw "hash do backup divergiu" }

if (-not $Execute) { Write-Output $ContextPath; exit 0 }

Copy-Item $context.Item.Backup $context.Item.Destination -Force
if ((Hash $context.Item.Destination) -ne $context.Item.OriginalSha256) { throw "hash pos-rollback divergiu" }
Write-Output $ContextPath
