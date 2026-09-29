param(
  [string]$SimulationRoot,
  [switch]$Rollback,
  [string]$TargetHost = 'TEST-HOST',
  [string]$TargetDeviceId = '00000000-0000-4000-8000-000000000001'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'MonitorTI-Notifier'
$ServiceName = 'MonitorTIAgent'
$IsSimulation = -not [string]::IsNullOrWhiteSpace($SimulationRoot)

function Fail([string]$Message) { throw $Message }
function Assert-RegularFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "regular file missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Fail "regular file required: $Path" }
}
function Hash([string]$Path) { Assert-RegularFile $Path; return (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-Json([string]$Path) { Assert-RegularFile $Path; return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
function Resolve-ServiceExecutablePath([object]$Service) {
  $raw = [Environment]::ExpandEnvironmentVariables([string]$Service.PathName)
  if ([string]::IsNullOrWhiteSpace($raw)) { Fail 'service executable path is empty' }
  $quoted = [regex]::Match($raw, '^\s*"([^"]+\.exe)"(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $pathText = $null
  if ($quoted.Success) { $pathText = $quoted.Groups[1].Value }
  else {
    $unquoted = [regex]::Match($raw, '^\s*(\S+\.exe)(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($unquoted.Success) { $pathText = $unquoted.Groups[1].Value }
  }
  if ([string]::IsNullOrWhiteSpace($pathText)) { Fail 'service executable cannot be resolved safely' }
  try { $fullPath = [IO.Path]::GetFullPath($pathText) } catch { Fail 'service executable path is invalid' }
  Assert-RegularFile $fullPath
  return $fullPath
}
function Get-Plan {
  if (-not $IsSimulation -and $env:COMPUTERNAME -cne $TargetHost) { Fail "wrong computer: $env:COMPUTERNAME" }
  if ($IsSimulation) {
    $root = [IO.Path]::GetFullPath($SimulationRoot)
    $session = Read-Json (Join-Path $root 'interactive-session.json')
    if ([int]$session.sessionId -ne 1) { Fail 'interactive session is not 1' }
    $layout = [ordered]@{ install=(Join-Path $root 'Install'); config=(Join-Path $root 'ProgramData\MonitorTI\agent-config.json'); xml=(Join-Path $root 'Service\MonitorTIAgent.xml'); backup=(Join-Path $root 'ProgramData\MonitorTI\backups'); task=(Join-Path $root 'Task\MonitorTI-Notifier.task.xml'); shortcut=(Join-Path $root 'Users\interactive\StartMenu\HenriTech Control.lnk'); state=(Join-Path $root 'state.json') }
  } else {
    $explorer = @(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 1 })
    if ($explorer.Count -ne 1) { Fail 'exactly one interactive explorer session 1 is required' }
    $session = [ordered]@{ user=[string]$explorer[0].UserName; sessionId=1 }
    $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if (-not $service) { Fail 'service missing' }
    $serviceExe = Resolve-ServiceExecutablePath $service
    $dir = Split-Path $serviceExe -Parent
    $sid = ([Security.Principal.NTAccount]$session.user).Translate([Security.Principal.SecurityIdentifier]).Value
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
    if (-not $profile -or [string]::IsNullOrWhiteSpace([string]$profile.LocalPath)) { Fail 'interactive profile cannot be resolved' }
    $layout = [ordered]@{ install=$dir; config='C:\ProgramData\MonitorTI\agent-config.json'; xml=(Join-Path $dir 'MonitorTIAgent.xml'); backup='C:\ProgramData\MonitorTI\backups'; task=$null; shortcut=(Join-Path $profile.LocalPath 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\HenriTech Control.lnk'); state=$null }
  }
  $config = Read-Json $layout.config
  if ([string]$config.deviceId -cne $TargetDeviceId) { Fail 'unauthorized deviceId' }
  return [ordered]@{ layout=$layout; session=$session }
}
function Assert-Complete([string]$Path) {
  Assert-RegularFile (Join-Path $Path 'backup-complete.json')
  $marker = Read-Json (Join-Path $Path 'backup-complete.json')
  if ($marker.complete -ne $true -or [string]$marker.deviceId -cne $TargetDeviceId) { Fail 'backup marker invalid' }
  $names = @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json','MonitorTIAgent.xml','agent-config.json','task-state.json','shortcut-state.json','metadata.json','backup-hashes.json')
  foreach ($name in $names) { Assert-RegularFile (Join-Path $Path $name) }
  $hashes = @{}
  foreach ($entry in @(Read-Json (Join-Path $Path 'backup-hashes.json'))) { $hashes[[string]$entry.name] = [string]$entry.sha256 }
  foreach ($name in $names | Where-Object { $_ -ne 'backup-hashes.json' }) {
    if (-not $hashes.ContainsKey($name) -or $hashes[$name] -cne (Hash (Join-Path $Path $name))) { Fail "backup hash invalid: $name" }
  }
}
function Copy-Atomic([string]$Source,[string]$Destination) {
  Assert-RegularFile $Source
  $temporary = "$Destination.v6.rollback.tmp"
  Copy-Item -LiteralPath $Source -Destination $temporary -Force
  Move-Item -LiteralPath $temporary -Destination $Destination -Force
}
function Stop-Original([object]$Plan) {
  if ($IsSimulation) { $state=Read-Json $Plan.layout.state; $state.agentRunning=$false; $state.notifierRunning=$false; $state|ConvertTo-Json|Set-Content $Plan.layout.state -Encoding ASCII; return }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-Service -Name $ServiceName -Force
}
function Start-Original([object]$Plan) {
  if ($IsSimulation) { $state=Read-Json $Plan.layout.state; $state.agentRunning=$true; $state.notifierRunning=$true; $state|ConvertTo-Json|Set-Content $Plan.layout.state -Encoding ASCII; return }
  Start-Service -Name $ServiceName
  Start-ScheduledTask -TaskName $TaskName
}
function Restore-Shortcut([object]$Plan,[object]$Snapshot) {
  if ($IsSimulation) { $Snapshot|ConvertTo-Json|Set-Content $Plan.layout.shortcut -Encoding ASCII; return }
  $shell=New-Object -ComObject WScript.Shell
  $link=$shell.CreateShortcut($Plan.layout.shortcut)
  $link.TargetPath=[string]$Snapshot.target
  $link.Arguments=[string]$Snapshot.arguments
  $link.WorkingDirectory=Split-Path -Parent ([string]$Snapshot.target)
  $link.Save()
  Assert-RegularFile $Plan.layout.shortcut
}
function Restore([object]$Plan,[string]$Backup) {
  Assert-Complete $Backup
  Stop-Original $Plan
  foreach ($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json','MonitorTIAgent.xml','agent-config.json')) {
    $destination = if ($name -eq 'MonitorTIAgent.xml') { $Plan.layout.xml } elseif ($name -eq 'agent-config.json') { $Plan.layout.config } else { Join-Path $Plan.layout.install $name }
    Copy-Atomic (Join-Path $Backup $name) $destination
  }
  $task = Read-Json (Join-Path $Backup 'task-state.json')
  if ($IsSimulation) { if ($task.exists) { $task.content|Set-Content $Plan.layout.task -Encoding ASCII } else { Remove-Item $Plan.layout.task -Force -ErrorAction SilentlyContinue } }
  elseif ($task.exists) { Register-ScheduledTask -TaskName $TaskName -Xml $task.content -Force|Out-Null }
  else { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
  $shortcut = Read-Json (Join-Path $Backup 'shortcut-state.json')
  if ($shortcut.exists) { Restore-Shortcut $Plan $shortcut } else { Remove-Item $Plan.layout.shortcut -Recurse -Force -ErrorAction SilentlyContinue }
  Start-Original $Plan
}

try {
  if (-not $Rollback) { Write-Output 'ROLLBACK_REQUIRED=true'; exit 2 }
  $plan=Get-Plan
  $backup=$null
  foreach($candidate in (Get-ChildItem -LiteralPath $plan.layout.backup -Directory -Filter 'certificate-notification-pilot-v6-*'|Sort-Object Name -Descending)) { try { Assert-Complete $candidate.FullName; $backup=$candidate.FullName; break } catch { continue } }
  if (-not $backup) { Fail 'no complete valid v6 backup found' }
  Restore $plan $backup
  Write-Output "ROLLBACK_BACKUP=$backup"
  Write-Output 'AUTOMATIC_ROLLBACK_RESTORED=true'
} catch { Write-Error $_.Exception.Message; exit 1 }
