param(
  [string]$SimulationRoot,
  [string]$TargetDeviceId = '00000000-0000-4000-8000-000000000001'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Aumid = 'HenriTech.Control.Notifier'
$TaskName = 'MonitorTI-Notifier'
$ServiceName = 'MonitorTIAgent'
$PipeName = 'MonitorTI-Notifier'
$IsSimulation = -not [string]::IsNullOrWhiteSpace($SimulationRoot)

function Read-JsonOrNull([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}
function Get-Sha256OrNull([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $null }
  $result = Get-FileHash -LiteralPath $Path -Algorithm SHA256
  if ($null -eq $result -or [string]::IsNullOrWhiteSpace([string]$result.Hash)) { return $null }
  return [string]$result.Hash
}
function Resolve-ServiceExecutablePath([object]$Service) {
  $raw = [Environment]::ExpandEnvironmentVariables([string]$Service.PathName)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $quoted = [regex]::Match($raw, '^\s*"([^"]+\.exe)"(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $pathText = $null
  if ($quoted.Success) { $pathText = $quoted.Groups[1].Value }
  else {
    $unquoted = [regex]::Match($raw, '^\s*(\S+\.exe)(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($unquoted.Success) { $pathText = $unquoted.Groups[1].Value }
  }
  if ([string]::IsNullOrWhiteSpace($pathText)) { return $null }
  try { $fullPath = [IO.Path]::GetFullPath($pathText) } catch { return $null }
  if ($null -eq (Get-Sha256OrNull $fullPath)) { return $null }
  return $fullPath
}

if ($IsSimulation) {
  $root = [IO.Path]::GetFullPath($SimulationRoot)
  $session = Read-JsonOrNull (Join-Path $root 'interactive-session.json')
  $config = Read-JsonOrNull (Join-Path $root 'ProgramData\MonitorTI\agent-config.json')
  $state = Read-JsonOrNull (Join-Path $root 'state.json')
  $dir = Join-Path $root 'Install'
  $shortcut = Join-Path $root 'Users\interactive\StartMenu\HenriTech Control.lnk'
  $taskPresent = Test-Path (Join-Path $root 'Task\MonitorTI-Notifier.task.xml')
  $pipePresent = Test-Path (Join-Path $root 'pipe\MonitorTI-Notifier')
  $xml = Join-Path $root 'Service\MonitorTIAgent.xml'
  $flag = (Test-Path $xml -PathType Leaf) -and [bool](Select-String -LiteralPath $xml -Pattern 'MTI_CERTIFICATE_NOTIFICATION_TEST' -Quiet)
  $shortcutData = Read-JsonOrNull $shortcut
  $shortcutPresent = $null -ne $shortcutData
  $aumidPresent = $shortcutPresent -and ([string]$shortcutData.aumid -ceq $Aumid)
  [pscustomobject]@{
     Hostname = 'TEST-HOST'
    InteractiveUser = if ($session) { [string]$session.user } else { $null }
    InteractiveSessionId = if ($session) { [int]$session.sessionId } else { $null }
    Service = [ordered]@{ Name=$ServiceName; State=if ($state -and $state.agentRunning) { 'Running' } else { 'Stopped' }; ProcessId=if ($state) { $state.processId } else { $null }; SessionId=if ($state -and $null -ne $state.sessionId) { $state.sessionId } else { 0 } }
    Processes = [ordered]@{ AgentRunning=if ($state) { [bool]$state.agentRunning } else { $false }; NotifierRunning=if ($state) { [bool]$state.notifierRunning } else { $false } }
    TaskPresent = $taskPresent
    NamedPipePresent = $pipePresent
    AuthorizedDeviceId = $null -ne $config -and ([string]$config.deviceId -ceq $TargetDeviceId)
    AgentSHA256 = Get-Sha256OrNull (Join-Path $dir 'MonitorTI-Agent.exe')
    NotifierSHA256 = Get-Sha256OrNull (Join-Path $dir 'MonitorTI-Notifier.exe')
    IntegritySHA256 = Get-Sha256OrNull (Join-Path $dir 'notifier-integrity.json')
    AUMID = $Aumid
    AUMIDPresent = $aumidPresent
    ShortcutPresent = $shortcutPresent
    ShortcutTarget = if ($aumidPresent) { [string]$shortcutData.target } else { $null }
    PilotFlagPresent = $flag
    CapabilityNoticesCurrent = 'UNKNOWN'
    CapabilityNoticesObservedInLog = $false
    CapabilityCertificateNotificationTestV1Current = 'UNKNOWN'
    CapabilityCertificateNotificationTestV1ObservedInLog = $false
  } | ConvertTo-Json -Depth 6
  exit 0
}

$explorer = @(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 1 })
$user = if ($explorer.Count -eq 1) { [string]$explorer[0].UserName } else { $null }
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
$servicePath = if ($service) { Resolve-ServiceExecutablePath $service } else { $null }
$dir = if ($servicePath) { Split-Path -Parent $servicePath } else { $null }
$xml = if ($servicePath) { [IO.Path]::ChangeExtension($servicePath, '.xml') } else { $null }
$config = Read-JsonOrNull 'C:\ProgramData\MonitorTI\agent-config.json'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$processes = @(Get-Process -Name @('MonitorTIAgent','MonitorTI-Agent','MonitorTI-Notifier') -ErrorAction SilentlyContinue | Select-Object Name,Id,SessionId)
$serviceProcessId = if ($service) { [int]$service.ProcessId } else { 0 }
$serviceProcess = @($processes | Where-Object { [int]$_.Id -eq $serviceProcessId })[0]
$serviceSessionId = if ($serviceProcess) { [int]$serviceProcess.SessionId } else { 0 }
$logs = @(); if ($dir) { $logs += Join-Path $dir 'logs' }; $logs += 'C:\ProgramData\MonitorTI\logs'
$observedNotices = $false; $observedCertificate = $false
foreach ($logDir in $logs) {
  if (Test-Path $logDir) {
    foreach ($file in @(Get-ChildItem $logDir -Filter '*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
      if (Select-String -LiteralPath $file.FullName -Pattern 'capabilities.*notices|notices.*capabilities' -Quiet -ErrorAction SilentlyContinue) { $observedNotices = $true }
      if (Select-String -LiteralPath $file.FullName -Pattern 'certificate_notification_test_v1' -Quiet -ErrorAction SilentlyContinue) { $observedCertificate = $true }
    }
  }
}
$pilotFlag = $false; if ($xml -and (Test-Path $xml -PathType Leaf)) { $pilotFlag = [bool](Select-String -LiteralPath $xml -Pattern 'MTI_CERTIFICATE_NOTIFICATION_TEST' -Quiet -ErrorAction SilentlyContinue) }
$shortcut = $null
if ($user) { try { $sid=([Security.Principal.NTAccount]$user).Translate([Security.Principal.SecurityIdentifier]).Value; $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"; if ($profile) { $shortcut=Join-Path $profile.LocalPath 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\HenriTech Control.lnk' } } catch { $shortcut=$null } }
$shortcutTarget = $null; $shortcutPresent = $false
if ($shortcut -and (Test-Path $shortcut -PathType Leaf)) { try { $shortcutPresent=$true; $shortcutTarget=[string](New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath } catch { $shortcutTarget=$null } }
[pscustomobject]@{
  Hostname=$env:COMPUTERNAME; InteractiveUser=$user; InteractiveSessionId=if($explorer.Count -eq 1){1}else{$null}
  Service=[ordered]@{ Name=$ServiceName; State=if($service){[string]$service.State}else{'Absent'}; ProcessId=$serviceProcessId; SessionId=$serviceSessionId }
  Processes=$processes; TaskPresent=[bool]$task; NamedPipePresent=(Test-Path "\\.\pipe\$PipeName")
  AuthorizedDeviceId=($null -ne $config -and [string]$config.deviceId -ceq $TargetDeviceId)
  AgentSHA256=if($dir){Get-Sha256OrNull (Join-Path $dir 'MonitorTI-Agent.exe')}else{$null}
  NotifierSHA256=if($dir){Get-Sha256OrNull (Join-Path $dir 'MonitorTI-Notifier.exe')}else{$null}
  IntegritySHA256=if($dir){Get-Sha256OrNull (Join-Path $dir 'notifier-integrity.json')}else{$null}
  AUMID=$Aumid; AUMIDPresent=$shortcutPresent; ShortcutPresent=$shortcutPresent; ShortcutTarget=$shortcutTarget; PilotFlagPresent=$pilotFlag
  CapabilityNoticesCurrent='UNKNOWN'; CapabilityNoticesObservedInLog=$observedNotices
  CapabilityCertificateNotificationTestV1Current='UNKNOWN'; CapabilityCertificateNotificationTestV1ObservedInLog=$observedCertificate
} | ConvertTo-Json -Depth 6
