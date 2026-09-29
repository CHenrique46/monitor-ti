param(
  [switch]$PreflightOnly,
  [switch]$Install,
  [string]$SimulationRoot,
  [string]$TargetHost = 'TEST-HOST',
  [string]$TargetDeviceId = '00000000-0000-4000-8000-000000000001'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Aumid = 'HenriTech.Control.Notifier'
$TaskName = 'MonitorTI-Notifier'
$ServiceName = 'MonitorTIAgent'
$PipeName = 'MonitorTI-Notifier'
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $PackageRoot 'manifest-pilot.json'
$IsSimulation = -not [string]::IsNullOrWhiteSpace($SimulationRoot)

function Fail([string]$Message) { throw $Message }
function Assert-RegularFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "regular file missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Fail "regular file required: $Path" }
  return $item
}
function Hash([string]$Path) { Assert-RegularFile $Path | Out-Null; return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Copy-Atomic([string]$Source,[string]$Destination) {
  Assert-RegularFile $Source | Out-Null
  $temp = "$Destination.v6.tmp"
  Copy-Item -LiteralPath $Source -Destination $temp -Force
  Move-Item -LiteralPath $temp -Destination $Destination -Force
}
function Read-Json([string]$Path) { Assert-RegularFile $Path | Out-Null; return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
function Resolve-ServiceExecutablePath([object]$Service) {
  $raw = [Environment]::ExpandEnvironmentVariables([string]$Service.PathName)
  if ([string]::IsNullOrWhiteSpace($raw)) { Fail 'service executable path is empty' }
  $quoted = [regex]::Match($raw, '^\s*"([^"]+\.exe)"(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $pathText = $null
  if ($quoted.Success) {
    $pathText = $quoted.Groups[1].Value
  } else {
    $unquoted = [regex]::Match($raw, '^\s*(\S+\.exe)(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($unquoted.Success) { $pathText = $unquoted.Groups[1].Value }
  }
  if ([string]::IsNullOrWhiteSpace($pathText)) { Fail 'service executable cannot be resolved safely' }
  try { $fullPath = [IO.Path]::GetFullPath($pathText) } catch { Fail 'service executable path is invalid' }
  Assert-RegularFile $fullPath | Out-Null
  return $fullPath
}
function Get-Manifest {
  $manifest = Read-Json $ManifestPath
  if ([string]$manifest.purpose -cne 'LOCAL_REVIEW_ONLY' -or [string]$manifest.packageRevision -cne '6.1') { Fail 'manifest purpose or revision mismatch' }
  return $manifest
}
function Assert-ManifestHash([object]$Manifest,[string]$Name,[string]$Path) {
  $entry = $Manifest.artifacts.PSObject.Properties[$Name]
  if (-not $entry) { Fail "manifest hash missing: $Name" }
  if ((Hash $Path) -cne ([string]$entry.Value.sha256).ToLowerInvariant()) { Fail "manifest hash mismatch: $Name" }
}
function Get-SandboxSession {
  $path = Join-Path $SimulationRoot 'interactive-session.json'
  $session = Read-Json $path
  if ([int]$session.sessionId -ne 1) { Fail "interactive session is not 1: $($session.sessionId)" }
  if ([string]::IsNullOrWhiteSpace([string]$session.user)) { Fail 'interactive user missing' }
  return $session
}
function Get-InteractiveSession {
  if ($IsSimulation) { return Get-SandboxSession }
  $explorer = @(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 1 })
  if ($explorer.Count -ne 1) { Fail 'exactly one interactive explorer session 1 is required' }
  return [ordered]@{ user = [string]$explorer[0].UserName; sessionId = 1 }
}
function Get-Layout([object]$Session) {
  if ($IsSimulation) {
    $root = [IO.Path]::GetFullPath($SimulationRoot)
    return [ordered]@{ root=$root; install=(Join-Path $root 'Install'); service=(Join-Path $root 'Service'); config=(Join-Path $root 'ProgramData\MonitorTI\agent-config.json'); xml=(Join-Path $root 'Service\MonitorTIAgent.xml'); backup=(Join-Path $root 'ProgramData\MonitorTI\backups'); task=(Join-Path $root 'Task\MonitorTI-Notifier.task.xml'); shortcut=(Join-Path $root 'Users\interactive\StartMenu\HenriTech Control.lnk'); state=(Join-Path $root 'state.json') }
  }
  $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if (-not $service) { Fail "service missing: $ServiceName" }
  $serviceExe = Resolve-ServiceExecutablePath $service
  $serviceDir = Split-Path -Parent $serviceExe
  $sid = ([Security.Principal.NTAccount]$Session.user).Translate([Security.Principal.SecurityIdentifier]).Value
  $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
  if (-not $profile -or [string]::IsNullOrWhiteSpace([string]$profile.LocalPath)) { Fail 'interactive user profile cannot be resolved' }
  $startMenu = Join-Path $profile.LocalPath 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs'
  return [ordered]@{ service=$service; root=$serviceDir; install=$serviceDir; serviceDir=$serviceDir; config='C:\ProgramData\MonitorTI\agent-config.json'; xml=(Join-Path $serviceDir 'MonitorTIAgent.xml'); backup='C:\ProgramData\MonitorTI\backups'; task=$null; shortcut=(Join-Path $startMenu 'HenriTech Control.lnk'); state=$null }
}
function Assert-Device([object]$Layout) {
  $config = Read-Json $Layout.config
  if ([string]$config.deviceId -cne $TargetDeviceId) { Fail "unauthorized deviceId: $($config.deviceId)" }
  return $config
}
function Get-TaskSnapshot([object]$Layout) {
  if ($IsSimulation) { if (Test-Path -LiteralPath $Layout.task -PathType Leaf) { return [ordered]@{ exists=$true; path=$Layout.task; target=(Get-Content $Layout.task -Raw) } }; return [ordered]@{ exists=$false; path=$Layout.task; target=$null } }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return [ordered]@{ exists=$false; path=$null; target=$null } }
  return [ordered]@{ exists=$true; path=$null; target=(Export-ScheduledTask -TaskName $TaskName) }
}
function Get-ShortcutSnapshot([object]$Layout) {
  if (-not (Test-Path -LiteralPath $Layout.shortcut -PathType Leaf)) { return [ordered]@{ exists=$false; path=$Layout.shortcut; target=$null; arguments=$null; aumid=$Aumid } }
  Assert-RegularFile $Layout.shortcut | Out-Null
  if ($IsSimulation) { $s=Read-Json $Layout.shortcut; return [ordered]@{ exists=$true; path=$Layout.shortcut; target=[string]$s.target; arguments=[string]$s.arguments; aumid=[string]$s.aumid } }
  $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($Layout.shortcut)
  return [ordered]@{ exists=$true; path=$Layout.shortcut; target=[string]$shortcut.TargetPath; arguments=[string]$shortcut.Arguments; aumid=$Aumid }
}
function Assert-Candidate([object]$Manifest) {
  foreach ($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','config.json','notifier-companion-task.ps1','notifier-toast-identity.ps1','LEIA-ME.txt','notifier-integrity.json','install-certificate-notification-pilot-v6.ps1','rollback-certificate-notification-pilot-v6.ps1','collect-pilot-status-v6.ps1')) { Assert-ManifestHash $Manifest $name (Join-Path $PackageRoot $name) }
  $integrity=Read-Json (Join-Path $PackageRoot 'notifier-integrity.json')
  if ([string]$integrity.notifierSha256.ToLowerInvariant() -cne (Hash (Join-Path $PackageRoot 'MonitorTI-Notifier.exe')).ToLowerInvariant()) { Fail 'notifier integrity metadata mismatch' }
}
function Get-Plan {
  if (-not $IsSimulation -and $env:COMPUTERNAME -cne $TargetHost) { Fail "wrong computer: $env:COMPUTERNAME" }
  $session=Get-InteractiveSession
  $layout=Get-Layout $session
  $config=Assert-Device $layout
  foreach ($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json')) { Assert-RegularFile (Join-Path $layout.install $name) | Out-Null }
  if ($IsSimulation) { Assert-RegularFile $layout.state | Out-Null }
  if ($IsSimulation) { Assert-RegularFile $layout.xml | Out-Null } else { Assert-RegularFile $layout.xml | Out-Null; if (-not (Test-Path -LiteralPath "\\.\pipe\$PipeName")) { Fail "named pipe missing: $PipeName" } }
  $manifest=Get-Manifest; Assert-Candidate $manifest
  $task=Get-TaskSnapshot $layout; $shortcut=Get-ShortcutSnapshot $layout
  if ($shortcut.exists -and ([string]$shortcut.target -ne (Join-Path $layout.install 'MonitorTI-Notifier.exe') -or [string]$shortcut.arguments -ne '--companion' -or [string]$shortcut.aumid -ne $Aumid)) { Fail 'existing shortcut is not owned by the v6 notifier' }
  return [ordered]@{ session=$session; layout=$layout; config=$config; manifest=$manifest; task=$task; shortcut=$shortcut }
}
function Write-Backup([object]$Plan) {
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'; $path=Join-Path $Plan.layout.backup "certificate-notification-pilot-v6-$stamp"; New-Item -ItemType Directory -Path $path -Force | Out-Null
  try {
    foreach($item in @(@{name='MonitorTI-Agent.exe';path=(Join-Path $Plan.layout.install 'MonitorTI-Agent.exe')},@{name='MonitorTI-Notifier.exe';path=(Join-Path $Plan.layout.install 'MonitorTI-Notifier.exe')},@{name='notifier-integrity.json';path=(Join-Path $Plan.layout.install 'notifier-integrity.json')},@{name='MonitorTIAgent.xml';path=$Plan.layout.xml},@{name='agent-config.json';path=$Plan.layout.config})) { Assert-RegularFile $item.path | Out-Null; Copy-Item -LiteralPath $item.path -Destination (Join-Path $path $item.name) -Force }
    [ordered]@{ exists=$Plan.task.exists; content=$Plan.task.target } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $path 'task-state.json') -Encoding ASCII
    [ordered]@{ exists=$Plan.shortcut.exists; target=$Plan.shortcut.target; arguments=$Plan.shortcut.arguments; aumid=$Plan.shortcut.aumid } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $path 'shortcut-state.json') -Encoding ASCII
    [ordered]@{ user=$Plan.session.user; sessionId=$Plan.session.sessionId; aumid=$Aumid; deviceId=$TargetDeviceId } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $path 'metadata.json') -Encoding ASCII
    $hashes=@(); Get-ChildItem -LiteralPath $path -File | ForEach-Object { $hashes += [ordered]@{ name=$_.Name; sha256=(Hash $_.FullName) } }; $hashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $path 'backup-hashes.json') -Encoding ASCII
    $required=@('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json','MonitorTIAgent.xml','agent-config.json','task-state.json','shortcut-state.json','metadata.json','backup-hashes.json'); foreach($name in $required){Assert-RegularFile (Join-Path $path $name)|Out-Null}
    [ordered]@{ complete=$true; completedAt=(Get-Date).ToUniversalTime().ToString('o'); deviceId=$TargetDeviceId; files=$required } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $path 'backup-complete.json') -Encoding ASCII
    Assert-CompleteBackup $path
    return $path
  } catch { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue; throw }
}
function Assert-CompleteBackup([string]$Path) {
  Assert-RegularFile (Join-Path $Path 'backup-complete.json')|Out-Null; $marker=Read-Json (Join-Path $Path 'backup-complete.json'); if ($marker.complete -ne $true -or [string]$marker.deviceId -cne $TargetDeviceId){Fail 'backup marker invalid'}
  foreach($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json','MonitorTIAgent.xml','agent-config.json','task-state.json','shortcut-state.json','metadata.json','backup-hashes.json')){Assert-RegularFile (Join-Path $Path $name)|Out-Null}
  $known=@{}; foreach($entry in @(Read-Json (Join-Path $Path 'backup-hashes.json'))){$known[[string]$entry.name]=[string]$entry.sha256}; foreach($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json','MonitorTIAgent.xml','agent-config.json','task-state.json','shortcut-state.json','metadata.json')){if(-not $known.ContainsKey($name) -or $known[$name] -cne (Hash (Join-Path $Path $name))){Fail "backup hash invalid: $name"}}
}
function Stop-Original([object]$Plan) { if ($IsSimulation) { if (Test-Path $Plan.layout.state) { $s=Read-Json $Plan.layout.state; $s.agentRunning=$false; $s.notifierRunning=$false; $s | ConvertTo-Json | Set-Content $Plan.layout.state -Encoding ASCII }; return }; Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Stop-Service -Name $ServiceName -Force }
function Start-Original([object]$Plan) { if ($IsSimulation) { $s=Read-Json $Plan.layout.state; $s.agentRunning=$true; $s.notifierRunning=$true; $s | ConvertTo-Json | Set-Content $Plan.layout.state -Encoding ASCII; return }; Start-Service -Name $ServiceName; Start-ScheduledTask -TaskName $TaskName }
function Set-Task([object]$Plan) { if ($IsSimulation) { New-Item -ItemType Directory -Path (Split-Path $Plan.layout.task) -Force|Out-Null; '<Task><Exec>MonitorTI-Notifier.exe --companion</Exec></Task>' | Set-Content $Plan.layout.task -Encoding ASCII; return }; $action=New-ScheduledTaskAction -Execute (Join-Path $Plan.layout.install 'MonitorTI-Notifier.exe') -Argument '--companion' -WorkingDirectory $Plan.layout.install; $trigger=New-ScheduledTaskTrigger -AtLogOn; $principal=New-ScheduledTaskPrincipal -GroupId 'S-1-5-11' -RunLevel Limited; Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force|Out-Null }
function Set-Shortcut([object]$Plan) { if ((Test-Path -LiteralPath $Plan.layout.shortcut) -and -not (Test-Path -LiteralPath $Plan.layout.shortcut -PathType Leaf)) { Fail 'shortcut path is not a regular file' }; New-Item -ItemType Directory -Path (Split-Path $Plan.layout.shortcut) -Force|Out-Null; if ($IsSimulation) { [ordered]@{target=(Join-Path $Plan.layout.install 'MonitorTI-Notifier.exe');arguments='--companion';aumid=$Aumid;createdBy='certificate-notification-pilot-v6'}|ConvertTo-Json|Set-Content $Plan.layout.shortcut -Encoding ASCII; return }; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut($Plan.layout.shortcut); $link.TargetPath=(Join-Path $Plan.layout.install 'MonitorTI-Notifier.exe');$link.Arguments='--companion';$link.WorkingDirectory=$Plan.layout.install;$link.Description="HenriTech Control ($Aumid)";$link.Save(); Assert-RegularFile $Plan.layout.shortcut|Out-Null }
function Invoke-RollbackInternal([object]$Plan,[string]$Backup) { Assert-CompleteBackup $Backup; Stop-Original $Plan; foreach($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json','MonitorTIAgent.xml','agent-config.json')) { $destination=if($name -eq 'MonitorTIAgent.xml'){$Plan.layout.xml}elseif($name -eq 'agent-config.json'){$Plan.layout.config}else{Join-Path $Plan.layout.install $name}; Copy-Atomic (Join-Path $Backup $name) $destination }; $task=Read-Json (Join-Path $Backup 'task-state.json'); if($IsSimulation){if($task.exists){$task.content|Set-Content $Plan.layout.task -Encoding ASCII}else{Remove-Item $Plan.layout.task -Force -ErrorAction SilentlyContinue}}else{if($task.exists){Register-ScheduledTask -TaskName $TaskName -Xml $task.content -Force|Out-Null}else{Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue}}; $shortcut=Read-Json (Join-Path $Backup 'shortcut-state.json'); if($shortcut.exists){if($IsSimulation){$shortcut|ConvertTo-Json|Set-Content $Plan.layout.shortcut -Encoding ASCII}else{Set-Shortcut $Plan}}else{Remove-Item $Plan.layout.shortcut -Force -ErrorAction SilentlyContinue}; Start-Original $Plan }
function Invoke-Install([object]$Plan) { $backup=Write-Backup $Plan; $success=$false; try { Stop-Original $Plan; Copy-Atomic (Join-Path $PackageRoot 'MonitorTI-Agent.exe') (Join-Path $Plan.layout.install 'MonitorTI-Agent.exe'); if($env:MTI_V6_FAIL_AFTER_AGENT -eq '1'){Fail 'injected failure after Agent replacement'}; Copy-Atomic (Join-Path $PackageRoot 'MonitorTI-Notifier.exe') (Join-Path $Plan.layout.install 'MonitorTI-Notifier.exe'); Copy-Atomic (Join-Path $PackageRoot 'notifier-integrity.json') (Join-Path $Plan.layout.install 'notifier-integrity.json'); Set-Task $Plan; Set-Shortcut $Plan; Start-Original $Plan; $success=$true; Write-Output "BACKUP_PATH=$backup"; Write-Output 'PILOT_FLAG_ENABLED=false'; Write-Output 'EVENT_SENT=false' } catch { if(-not $success){Invoke-RollbackInternal $Plan $backup}; throw } }

try {
  if (-not $PreflightOnly -and -not $Install) { Write-Output 'INSTALL_REQUIRED=true'; exit 2 }
  $plan=Get-Plan
  if($PreflightOnly){Write-Output 'PREFLIGHT_PASSED=true';Write-Output 'PREFLIGHT_MUTATIONS=false';exit 0}
  Invoke-Install $plan
} catch { if($PreflightOnly){Write-Output 'PREFLIGHT_PASSED=false';Write-Output 'PREFLIGHT_MUTATIONS=false'}; Write-Error $_.Exception.Message; exit 1 }
