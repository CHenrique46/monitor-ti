[CmdletBinding()]
param(
  [string]$ServerUrl = "http://127.0.0.1:4000",
  [int]$ObservationSeconds = 60,
  [int]$OnlyId = 0,
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$targetVersion = "1.1.30"
$currentVersion = "1.1.29"
$activeStatuses = @("update_pending", "update_downloading", "update_validating", "update_installing", "update_restarting")
$targets = @(
  [ordered]@{ Id = 466; Hostname = "CONT-04"; Equipment = "04"; DeviceId = "6df57034-2768-48e7-a166-15f2bf89e001" }
  [ordered]@{ Id = 619; Hostname = "LEGAL-29"; Equipment = "29"; DeviceId = "fdec21eb-7ad2-41d4-bf09-179998ce10a2" }
)
if ($OnlyId -ne 0) {
  $targets = @($targets | Where-Object { $_.Id -eq $OnlyId })
  if ($targets.Count -ne 1) { throw "OnlyId $OnlyId nao pertence ao lote autorizado" }
}

function Get-Json([string]$Path) {
  return Invoke-RestMethod -WebSession $script:WebSession -Uri ($ServerUrl + $Path) -Method Get
}

function Read-Target($Expected) {
  $target = Get-Json ("/api/computadores/{0}" -f $Expected.Id)
  if ([int]$target.id -ne $Expected.Id -or [string]$target.hostname -ne $Expected.Hostname -or
      [string]$target.equipamentoNumero -ne $Expected.Equipment -or [string]$target.deviceId -ne $Expected.DeviceId) {
    throw "identidade divergente para id $($Expected.Id)"
  }
  if ([string]$target.agentVersion -ne $currentVersion) { throw "versao atual divergente para $($Expected.Hostname)" }
  if ([string]$target.status -ne "online") { throw "$($Expected.Hostname) esta offline" }
  if (-not $target.ultimaMetrica) { throw "ultimaMetrica ausente para $($Expected.Hostname)" }
  $age = ((Get-Date).ToUniversalTime() - ([datetime]$target.ultimaMetrica).ToUniversalTime()).TotalSeconds
  if ($age -lt 0 -or $age -gt 120) { throw "ultimaMetrica nao e recente para $($Expected.Hostname): $([int]$age)s" }
  return $target
}

function Read-Update($Expected) {
  return Get-Json ("/api/computadores/{0}/agent-update" -f $Expected.Id)
}

function Select-InactiveRelease($Response) {
  $items = if ($null -eq $Response) {
    @()
  } elseif ($Response.PSObject.Properties.Name -contains "items") {
    @($Response.items)
  } elseif ($Response.PSObject.Properties.Name -contains "data") {
    @($Response.data)
  } else {
    @($Response)
  }
  $matches = @($items | Where-Object { [string]$_.version -eq $targetVersion })
  if ($matches.Count -eq 0) { throw "release $targetVersion nao encontrada" }
  if ($matches.Count -gt 1) { throw "release $targetVersion retornou multiplos registros" }
  $activeValue = $matches[0].active
  $isActive = ($activeValue -is [bool] -and $activeValue) -or ([string]$activeValue -match "^(?i:true|1)$")
  if ($isActive) { throw "release $targetVersion esta ativa" }
  return $matches[0]
}

function Observe($Expected) {
  $samples = @()
  $deadline = (Get-Date).ToUniversalTime().AddSeconds($ObservationSeconds)
  do {
    Start-Sleep -Seconds 5
    $target = Read-Target $Expected
    $update = Read-Update $Expected
    $samples += [ordered]@{
      At = (Get-Date).ToUniversalTime().ToString("o")
      AgentVersion = $target.agentVersion
      Status = $target.status
      UltimaConexao = $target.ultimaConexao
      UltimaMetrica = $target.ultimaMetrica
      Ip = $target.ip
      Update = $update
    }
  } while ((Get-Date).ToUniversalTime() -lt $deadline)
  return $samples
}

if (-not $Execute) {
  [ordered]@{
    Mode = "DRY_RUN"
    Release = $targetVersion
    SequentialTargets = $targets
    ObservationSecondsPerTarget = $ObservationSeconds
    PostSent = $false
    Note = "Use -Execute somente apos revisao; nenhum login ou POST e feito neste modo."
  } | ConvertTo-Json -Depth 8
  exit 0
}

$username = Read-Host "ADMIN username"
$securePassword = Read-Host "ADMIN password" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $securePassword.Dispose() }
$script:WebSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
  $login = Invoke-WebRequest -UseBasicParsing -WebSession $script:WebSession -Uri ($ServerUrl + "/api/auth/login") -Method Post -ContentType "application/json" -Body (@{ username = $username; password = $password } | ConvertTo-Json)
} finally { $password = $null }
if ($login.StatusCode -ne 200) { throw "login ADMIN falhou" }

$release = Select-InactiveRelease (Get-Json "/api/agent/releases")

$results = @()
foreach ($expected in $targets) {
  $target = Read-Target $expected
  $existing = Read-Update $expected
  if ([string]$target.agentVersion -eq $targetVersion -or ($existing -and [string]$existing.version -eq $targetVersion -and $activeStatuses -contains [string]$existing.status)) {
    $results += [ordered]@{ Target = $expected; Action = "NOT_SENT"; Reason = "versao instalada ou update em andamento"; Update = $existing }
    continue
  }

  $response = Invoke-RestMethod -WebSession $script:WebSession -Uri ($ServerUrl + ("/api/computadores/{0}/agent-update" -f $expected.Id)) -Method Post -ContentType "application/json" -Body (@{ version = $targetVersion } | ConvertTo-Json)
  $samples = Observe $expected
  $finalUpdate = Read-Update $expected
  $results += [ordered]@{ Target = $expected; Action = "SENT_ONCE"; Response = $response; Update = $finalUpdate; Samples = $samples }
  if (-not $finalUpdate -or [string]$finalUpdate.persistentStatus -ne "SUCCESS") { throw "canario $($expected.Hostname) nao terminou SUCCESS; lote interrompido" }
}

$results | ConvertTo-Json -Depth 12
