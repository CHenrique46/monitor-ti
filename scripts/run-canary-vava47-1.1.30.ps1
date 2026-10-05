[CmdletBinding()]
param(
  [string]$ServerUrl = "http://127.0.0.1:4000",
  [int]$ComputerId = 165,
  [string]$ExpectedDeviceId = "b855baf0-9c34-47f9-87a9-f241868fd713",
  [string]$TargetVersion = "1.1.30",
  [int]$ObservationSeconds = 60
)

$ErrorActionPreference = "Stop"
$expectedHost = "VAVA47"
$expectedEquipment = "47"
$expectedCurrentVersion = "1.1.29"
$activeStatuses = @("update_pending", "update_downloading", "update_validating", "update_installing", "update_restarting")

function Get-Json([string]$Path) {
  return Invoke-RestMethod -WebSession $script:WebSession -Uri ($ServerUrl + $Path) -Method Get
}

function Read-Target {
  return Get-Json ("/api/computadores/{0}" -f $ComputerId)
}

function Read-Update {
  return Get-Json ("/api/computadores/{0}/agent-update" -f $ComputerId)
}

function Assert-Target($Target) {
  if ([int]$Target.id -ne $ComputerId) { throw "id do alvo divergiu" }
  if ([string]$Target.hostname -ne $expectedHost) { throw "hostname do alvo divergiu" }
  if ([string]$Target.equipamentoNumero -ne $expectedEquipment) { throw "equipamento do alvo divergiu" }
  if ([string]$Target.deviceId -ne $ExpectedDeviceId) { throw "deviceId do alvo divergiu" }
  if ([string]$Target.agentVersion -ne $expectedCurrentVersion) { throw "versao atual do alvo divergiu" }
  if ([string]$Target.status -ne "online") { throw "alvo offline" }
  if (-not $Target.ultimaMetrica) { throw "ultimaMetrica ausente" }
  $age = ((Get-Date).ToUniversalTime() - ([datetime]$Target.ultimaMetrica).ToUniversalTime()).TotalSeconds
  if ($age -lt 0 -or $age -gt 120) { throw "ultimaMetrica nao e recente: $([int]$age)s" }
}

$username = Read-Host "ADMIN username"
$securePassword = Read-Host "ADMIN password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $securePassword.Dispose()
}

$script:WebSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
  $login = Invoke-WebRequest -UseBasicParsing -WebSession $script:WebSession -Uri ($ServerUrl + "/api/auth/login") -Method Post -ContentType "application/json" -Body (@{ username = $username; password = $password } | ConvertTo-Json)
} finally {
  $password = $null
}
if ($login.StatusCode -ne 200) { throw "login ADMIN falhou" }

$target = Read-Target
Assert-Target $target
$release = Get-Json ("/api/agent/releases/{0}" -f $TargetVersion)
if ([string]$release.version -ne $TargetVersion -or [string]$release.packageMode -ne "agent-only") { throw "release agent-only nao confirmada" }

$existing = Read-Update
if ([string]$target.agentVersion -eq $TargetVersion -or ($existing -and [string]$existing.version -eq $TargetVersion -and ($activeStatuses -contains [string]$existing.status))) {
  Write-Output (@{ Action = "NOT_SENT"; Reason = "update ja existente ou versao ja instalada"; Target = $target; ExistingUpdate = $existing } | ConvertTo-Json -Depth 8)
  exit 0
}

$response = Invoke-RestMethod -WebSession $script:WebSession -Uri ($ServerUrl + ("/api/computadores/{0}/agent-update" -f $ComputerId)) -Method Post -ContentType "application/json" -Body (@{ version = $TargetVersion } | ConvertTo-Json)
$samples = @()
$deadline = (Get-Date).ToUniversalTime().AddSeconds($ObservationSeconds)
do {
  Start-Sleep -Seconds 5
  $current = Read-Target
  $update = Read-Update
  $samples += [ordered]@{
    At = (Get-Date).ToUniversalTime().ToString("o")
    AgentVersion = $current.agentVersion
    Status = $current.status
    UltimaConexao = $current.ultimaConexao
    UltimaMetrica = $current.ultimaMetrica
    Ip = $current.ip
    Update = $update
  }
} while ((Get-Date).ToUniversalTime() -lt $deadline)

$final = Read-Target
$finalUpdate = Read-Update
[ordered]@{
  Action = "SENT_ONCE"
  Response = $response
  Target = $final
  Update = $finalUpdate
  Samples = $samples
} | ConvertTo-Json -Depth 12
