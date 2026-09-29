param(
  [switch]$Enable,
  [switch]$Disable,
  [switch]$PreflightOnly,
  [string]$SimulationRoot,
  [string]$TargetHost = 'TEST-HOST',
  [string]$TargetDeviceId = '00000000-0000-4000-8000-000000000001'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$FlagName = 'MTI_CERTIFICATE_NOTIFICATION_TEST'
$FlagValue = '1'
$Capability = 'certificate_notification_test_v1'
$ServiceName = 'MonitorTIAgent'
$NotifierName = 'MonitorTI-Notifier'
$PipeName = 'MonitorTI-Notifier'
$IsSimulation = -not [string]::IsNullOrWhiteSpace($SimulationRoot)
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Message) { throw $Message }
function Assert-RegularFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "regular file missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Fail "regular file required: $Path" }
}
function Assert-RegularDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "directory missing: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "reparse directory rejected: $Path" }
}
function Read-Json([string]$Path) { Assert-RegularFile $Path; return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
function Get-Hash([string]$Path) { Assert-RegularFile $Path; return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-PropertyValue([object]$Object,[string]$Name,[object]$Default=$null) { $property=$Object.PSObject.Properties[$Name];if($null -eq $property){return $Default};return $property.Value }
function Get-Mode {
  $count = @([bool]$Enable,[bool]$Disable,[bool]$PreflightOnly | Where-Object { $_ }).Count
  if ($count -ne 1) { Fail 'exactly one of -Enable, -Disable or -PreflightOnly is required' }
  if ($PreflightOnly) { return 'preflight' }
  if ($Enable) { return 'enable' }
  return 'disable'
}
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
function Get-InteractiveSession {
  if ($IsSimulation) {
    $session = Read-Json (Join-Path $SimulationRoot 'interactive-session.json')
    if ([int]$session.sessionId -ne 1 -or [string]::IsNullOrWhiteSpace([string]$session.user)) { Fail 'interactive user/session invalid' }
    return $session
  }
  $explorer = @(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 1 })
  if ($explorer.Count -ne 1) { Fail 'exactly one interactive session 1 is required' }
  return [ordered]@{ user=[string]$explorer[0].UserName; sessionId=1 }
}
function Get-Layout([object]$Session) {
  if ($IsSimulation) {
    $root = [IO.Path]::GetFullPath($SimulationRoot)
    $service = Read-Json (Join-Path $root 'Service\service.json')
    $serviceExe = Resolve-ServiceExecutablePath $service
    $dir = Split-Path -Parent $serviceExe
    return [ordered]@{ service=$service; serviceExe=$serviceExe; serviceDir=$dir; xml=(Join-Path $dir 'MonitorTIAgent.xml'); config=(Join-Path $root 'ProgramData\MonitorTI\agent-config.json'); backup=(Join-Path $root 'ProgramData\MonitorTI\backups'); state=(Join-Path $root 'state.json') }
  }
  $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if (-not $service) { Fail "service missing: $ServiceName" }
  $serviceExe = Resolve-ServiceExecutablePath $service
  $dir = Split-Path -Parent $serviceExe
  return [ordered]@{ service=$service; serviceExe=$serviceExe; serviceDir=$dir; xml=(Join-Path $dir 'MonitorTIAgent.xml'); config='C:\ProgramData\MonitorTI\agent-config.json'; backup='C:\ProgramData\MonitorTI\backups' ; state=$null }
}
function Find-Bytes([byte[]]$Bytes,[byte[]]$Needle) {
  if($null-eq$Bytes -or $null-eq$Needle){return -1}
  for($i=0;$i -le $Bytes.Length-$Needle.Length;$i++){ $match=$true;for($j=0;$j -lt $Needle.Length;$j++){if($Bytes[$i+$j] -ne $Needle[$j]){$match=$false;break}};if($match){return $i} };return -1
}
function Count-Bytes([byte[]]$Bytes,[byte[]]$Needle) {
  if($null-eq$Bytes -or $null-eq$Needle){return 0}
  $count=0;$offset=0;while($offset -le $Bytes.Length-$Needle.Length){$found=Find-Bytes $Bytes[$offset..($Bytes.Length-1)] $Needle;if($found -lt 0){break};$count++;$offset+=$found+$Needle.Length};return $count
}
function Get-XmlEncoding([byte[]]$Bytes) {
  if($Bytes.Length -ge 3 -and $Bytes[0]-eq 0xEF -and $Bytes[1]-eq 0xBB -and $Bytes[2]-eq 0xBF){return [ordered]@{encoding=[Text.UTF8Encoding]::new($false);bomLength=3}}
  if($Bytes.Length -ge 2 -and $Bytes[0]-eq 0xFF -and $Bytes[1]-eq 0xFE){return [ordered]@{encoding=[Text.UnicodeEncoding]::new($false,$false);bomLength=2}}
  if($Bytes.Length -ge 2 -and $Bytes[0]-eq 0xFE -and $Bytes[1]-eq 0xFF){return [ordered]@{encoding=[Text.UnicodeEncoding]::new($true,$false);bomLength=2}}
  return [ordered]@{encoding=[Text.UTF8Encoding]::new($false);bomLength=0}
}
function Read-XmlDocument([byte[]]$Bytes) {
  $stream=[IO.MemoryStream]::new($Bytes,$false);$settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$reader=$null
  try{$reader=[Xml.XmlReader]::Create($stream,$settings);$doc=[Xml.XmlDocument]::new();$doc.PreserveWhitespace=$true;$doc.Load($reader);$root=$doc.SelectSingleNode('/service');if($null-eq$root){Fail 'service XML root is invalid'};return $doc}catch{Fail 'service XML is invalid'}finally{if($reader){$reader.Close()};$stream.Close()}
}
function Get-XmlState([string]$Path) {
  Assert-RegularFile $Path;$bytes=[IO.File]::ReadAllBytes([IO.Path]::GetFullPath($Path));$encodingInfo=Get-XmlEncoding $bytes;$doc=Read-XmlDocument $bytes;$nodes=@($doc.SelectNodes('/service/env')|Where-Object{[string]$_.GetAttribute('name')-ceq$FlagName});if($nodes.Count-gt1){Fail 'pilot flag node is duplicated'};$present=$nodes.Count-eq1;$value=if($present){[string]$nodes[0].GetAttribute('value')}else{$null};if($present-and$value-cne$FlagValue){Fail "pilot flag value conflicts: $value"};$closing=$encodingInfo.encoding.GetBytes('</service>');$closingOffset=Find-Bytes $bytes $closing;if($closingOffset-lt$encodingInfo.bomLength){Fail 'service closing tag not found'};$fragmentText='<env name="'+$FlagName+'" value="'+$FlagValue+'" />';$fragment=$encodingInfo.encoding.GetBytes($fragmentText);return [ordered]@{bytes=$bytes;encoding=$encodingInfo.encoding;bomLength=$encodingInfo.bomLength;document=$doc;nodes=$nodes;present=$present;value=$value;closingOffset=$closingOffset;fragmentBytes=$fragment;fragmentText=$fragmentText}
}
function Assert-Device([object]$Layout) {
  $config = Read-Json $Layout.config
  if ([string]$config.deviceId -cne $TargetDeviceId) { Fail "unauthorized deviceId: $($config.deviceId)" }
}
function Get-Plan([string]$Mode) {
  if (-not $IsSimulation -and $env:COMPUTERNAME -cne $TargetHost) { Fail "wrong computer: $env:COMPUTERNAME" }
  $session = Get-InteractiveSession
  $layout = Get-Layout $session
  Assert-Device $layout
  $xmlState = Get-XmlState $layout.xml
  Assert-RegularFile (Join-Path $layout.serviceDir 'MonitorTI-Agent.exe')
  Assert-RegularFile (Join-Path $layout.serviceDir 'MonitorTI-Notifier.exe')
  Assert-RegularFile (Join-Path $layout.serviceDir 'notifier-integrity.json')
  if (-not $IsSimulation -and -not (Test-Path "\\.\pipe\$PipeName")) { Fail "named pipe missing: $PipeName" }
  $plan=[ordered]@{ mode=$Mode; session=$session; layout=$layout; xmlState=$xmlState; originalHash=(Get-Hash $layout.xml); desired=if($Mode -eq 'enable'){$true}else{$false} }
  $plan.expectedBytes=Get-ExpectedBytes $plan
  $plan.expectedHash=Get-HashFromBytes $plan.expectedBytes
  return $plan
}
function Join-Bytes([byte[]]$Left,[byte[]]$Middle,[byte[]]$Right) {$stream=[IO.MemoryStream]::new();if($null-ne$Left){$stream.Write($Left,0,$Left.Length)};if($null-ne$Middle){$stream.Write($Middle,0,$Middle.Length)};if($null-ne$Right){$stream.Write($Right,0,$Right.Length)};$result=$stream.ToArray();$stream.Dispose();return $result}
function Get-PreviousOriginalBytes([object]$Plan) {
  $candidates=@(Get-ChildItem -LiteralPath $Plan.layout.backup -Directory -Filter 'certificate-notification-pilot-v6-flag-*' -ErrorAction SilentlyContinue|Sort-Object Name -Descending);foreach($candidate in $candidates){try{$marker=Read-Json (Join-Path $candidate.FullName 'backup-complete.json');if($marker.complete-eq$true -and $marker.originalPresent-eq$false -and [string]$marker.deviceId-eq$TargetDeviceId){$path=Join-Path $candidate.FullName 'MonitorTIAgent.xml';Assert-RegularFile $path;$bytes=[IO.File]::ReadAllBytes($path);if((Get-Hash $path)-ceq([string]$marker.originalSha256).ToLowerInvariant()){return $bytes}}}catch{continue}};return $null
}
function Get-ExpectedBytes([object]$Plan) {
  $state=$Plan.xmlState;$fragment=$state.fragmentBytes;$occurrences=Count-Bytes $state.bytes $fragment
  if($Plan.desired){if($state.present){if($occurrences-ne1){Fail 'existing pilot flag is not the exact controller fragment'};return $state.bytes};$prefix=$state.bytes[0..($state.closingOffset-1)];$suffix=$state.bytes[$state.closingOffset..($state.bytes.Length-1)];$candidate=Join-Bytes $prefix $fragment $suffix}
  else {if(-not$state.present){return $state.bytes};if($occurrences-ne1){Fail 'pilot flag structure is not the exact controller fragment'};$offset=Find-Bytes $state.bytes $fragment;if($offset-gt0){$left=[byte[]]$state.bytes[0..($offset-1)]}else{$left=[byte[]]::new(0)};$rightOffset=$offset+$fragment.Length;if($rightOffset-lt$state.bytes.Length){$right=[byte[]]$state.bytes[$rightOffset..($state.bytes.Length-1)]}else{$right=[byte[]]::new(0)};$candidate=Join-Bytes $left $right;$previous=Get-PreviousOriginalBytes $Plan;if($null-eq$previous -or (Get-HashFromBytes $candidate)-cne(Get-HashFromBytes $previous)){Fail 'disable result does not reproduce the previous original XML hash'}}
  Read-XmlDocument $candidate|Out-Null;return $candidate
}
function Get-HashFromBytes([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Replace-Atomic([string]$Path,[byte[]]$Content,[string]$ReplacementBackupPath,[string]$ExpectedOriginalHash) {
  $destination = [IO.Path]::GetFullPath($Path)
  $replacementBackup = [IO.Path]::GetFullPath($ReplacementBackupPath)
  $temporary = "$destination.v6-flag-$PID.tmp"
  $backupParent = Split-Path -Parent $replacementBackup
  if ($replacementBackup -eq $destination -or $replacementBackup -eq $temporary -or $replacementBackup -eq (Split-Path -Parent $destination)) { Fail 'invalid File.Replace backup path' }
  if (-not [IO.Path]::IsPathRooted($replacementBackup)) { Fail 'File.Replace backup path must be absolute' }
  Assert-RegularDirectory $backupParent
  if (Test-Path -LiteralPath $replacementBackup) { Fail "unexpected replacement backup already exists: $replacementBackup" }
  if ((Get-Hash $destination) -cne $ExpectedOriginalHash.ToLowerInvariant()) { Fail 'destination hash changed before atomic replacement' }
  if ($env:MTI_V6_FLAG_FAIL_ATOMIC -eq '1') { Fail 'injected atomic replacement failure' }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  [IO.File]::WriteAllBytes($temporary,$Content)
  Assert-RegularFile $temporary
  Read-XmlDocument ([IO.File]::ReadAllBytes($temporary))|Out-Null
  try {
    if ($IsSimulation) { Copy-Item -LiteralPath $destination -Destination $replacementBackup -Force;Move-Item -LiteralPath $temporary -Destination $destination -Force }
    else { [IO.File]::Replace($temporary,$destination,$replacementBackup,$true) }
    Assert-RegularFile $destination
    if ((Get-Hash $replacementBackup) -cne $ExpectedOriginalHash.ToLowerInvariant()) { Fail 'File.Replace backup hash mismatch' }
    return [ordered]@{ destinationHash=(Get-Hash $destination); replacementBackup=$replacementBackup; originalHash=$ExpectedOriginalHash.ToLowerInvariant() }
  } catch {
    $destinationChanged = $false
    try { $destinationChanged = (Get-Hash $destination) -cne $ExpectedOriginalHash.ToLowerInvariant() } catch { $destinationChanged = $true }
    $backupUsable = $false
    if (Test-Path -LiteralPath $replacementBackup -PathType Leaf) { try { $backupUsable = (Get-Hash $replacementBackup) -ceq $ExpectedOriginalHash.ToLowerInvariant() } catch { $backupUsable = $false } }
    if ($destinationChanged -and $backupUsable) { Copy-Item -LiteralPath $replacementBackup -Destination $destination -Force }
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    throw "atomic replacement failed; destinationRestored=$($destinationChanged -and $backupUsable)"
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Get-ProcessState([object]$Plan) {
  if ($IsSimulation) {
    $state=Read-Json $Plan.layout.state
    return [ordered]@{ serviceRunning=[bool]$state.serviceRunning; agentSession=[int]$state.agentSession; notifierSession=[int]$state.notifierSession; pipe=[bool]$state.pipe; capability=if($null -ne $state.currentCapabilities){@($state.currentCapabilities)}else{@()} }
  }
  $service=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  $agent=@(Get-Process -Name 'MonitorTI-Agent' -ErrorAction SilentlyContinue)[0]
  $notifier=@(Get-Process -Name $NotifierName -ErrorAction SilentlyContinue)[0]
  $caps=@()
  $logs=@((Join-Path $Plan.layout.serviceDir 'logs'),'C:\ProgramData\MonitorTI\logs')
  $startedAfter = if ($agent) { $agent.StartTime.ToUniversalTime() } else { [DateTime]::MinValue.ToUniversalTime() }
  foreach($logDir in $logs){if(Test-Path $logDir){foreach($file in @(Get-ChildItem $logDir -Filter '*.log' -File -ErrorAction SilentlyContinue | Where-Object {$_.LastWriteTimeUtc -ge $startedAfter})){if(Select-String -LiteralPath $file.FullName -Pattern $Capability -Quiet -ErrorAction SilentlyContinue){$caps+=$Capability}}}}
  return [ordered]@{ serviceRunning=([string]$service.State -ceq 'Running'); agentSession=if($agent){[int]$agent.SessionId}else{-1}; notifierSession=if($notifier){[int]$notifier.SessionId}else{-1}; pipe=(Test-Path "\\.\pipe\$PipeName"); capability=@($caps | Select-Object -Unique) }
}
function Restart-And-Validate([object]$Plan) {
  if ($IsSimulation) {
    $state=Read-Json $Plan.layout.state; $state.restartCount=[int]$state.restartCount+1
    if ($env:MTI_V6_FLAG_FAIL_RESTART -eq '1' -and $state.restartCount -eq 1) { $state.serviceRunning=$false; $state|ConvertTo-Json|Set-Content $Plan.layout.state -Encoding ASCII; Fail 'injected restart failure' }
    if ($env:MTI_V6_FLAG_SERVICE_NOT_RUNNING -eq '1' -and $state.restartCount -eq 1) { $state.serviceRunning=$false } else { $state.serviceRunning=$true }
    if ($env:MTI_V6_FLAG_NOTIFIER_SESSION -eq '1' -and $state.restartCount -eq 1) { $state.notifierSession=0 } else { $state.notifierSession=1 }
    if ($env:MTI_V6_FLAG_PIPE_ABSENT -eq '1' -and $state.restartCount -eq 1) { $state.pipe=$false } else { $state.pipe=$true }
    if ($Plan.desired -and $env:MTI_V6_FLAG_CAPABILITY_ABSENT -eq '1' -and $state.restartCount -eq 1) { $state.currentCapabilities=@() } elseif ($Plan.desired) { $state.currentCapabilities=@($Capability) } else { $state.currentCapabilities=@() }
    $state|ConvertTo-Json|Set-Content $Plan.layout.state -Encoding ASCII
  } else {
    Stop-Service -Name $ServiceName -Force
    Start-Service -Name $ServiceName
    $deadline=(Get-Date).AddSeconds(30)
    do { Start-Sleep -Milliseconds 500; $service=Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" } while ($service.State -ne 'Running' -and (Get-Date) -lt $deadline)
  }
  $state=Get-ProcessState $Plan
  if (-not $state.serviceRunning) { Fail 'service did not return to Running' }
  if ([int]$state.agentSession -ne 0) { Fail "Agent session is not 0: $($state.agentSession)" }
  if ([int]$state.notifierSession -ne 1) { Fail "Notifier session is not 1: $($state.notifierSession)" }
  if (-not $state.pipe) { Fail 'Named Pipe is not active' }
  $hasCapability=@($state.capability) -contains $Capability
  if ($Plan.desired -ne $hasCapability) { Fail 'current process capability does not match the requested flag' }
}
function Write-FlagBackup([object]$Plan) {
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff';$path=Join-Path $Plan.layout.backup "certificate-notification-pilot-v6-flag-$stamp";New-Item -ItemType Directory -Path $path -Force|Out-Null
  try { Copy-Item -LiteralPath $Plan.layout.xml -Destination (Join-Path $path 'MonitorTIAgent.xml') -Force;Assert-RegularFile (Join-Path $path 'MonitorTIAgent.xml');if((Get-Hash (Join-Path $path 'MonitorTIAgent.xml')) -cne $Plan.originalHash){Fail 'flag XML backup hash mismatch'};[ordered]@{deviceId=$TargetDeviceId;flag=$FlagName;originalSha256=$Plan.originalHash;originalPresent=$Plan.xmlState.present;complete=$true}|ConvertTo-Json|Set-Content (Join-Path $path 'backup-complete.json') -Encoding ASCII;return $path } catch { Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue;throw }
}
function Restore-FlagBackup([object]$Plan,[string]$Backup) { Assert-RegularFile (Join-Path $Backup 'backup-complete.json');$marker=Read-Json (Join-Path $Backup 'backup-complete.json');if($marker.complete-ne$true -or [string]$marker.deviceId -cne $TargetDeviceId){Fail 'flag backup invalid'};Assert-RegularFile (Join-Path $Backup 'MonitorTIAgent.xml');$currentHash=Get-Hash $Plan.layout.xml;$rollbackBackup=Join-Path ([IO.Path]::GetFullPath($Backup)) 'MonitorTIAgent.xml.rollback-replace-backup';$restoreBytes=[IO.File]::ReadAllBytes((Join-Path $Backup 'MonitorTIAgent.xml'));Replace-Atomic $Plan.layout.xml $restoreBytes $rollbackBackup $currentHash;Restart-And-Validate ([ordered]@{layout=$Plan.layout;desired=[bool]$marker.originalPresent}) }
function Invoke-Control([object]$Plan) {
  if ($PreflightOnly) { $service=$Plan.layout.service; $summary=[ordered]@{ mode=$Plan.mode; service=[ordered]@{Name=Get-PropertyValue $service 'Name';State=Get-PropertyValue $service 'State';ProcessId=Get-PropertyValue $service 'ProcessId';StartName=Get-PropertyValue $service 'StartName';PathName=Get-PropertyValue $service 'PathName'}; paths=[ordered]@{serviceExecutable=$Plan.layout.serviceExe;serviceDirectory=$Plan.layout.serviceDir;xml=$Plan.layout.xml;config=$Plan.layout.config;backupRoot=$Plan.layout.backup}; hashes=[ordered]@{xml=$Plan.originalHash;agent=(Get-Hash (Join-Path $Plan.layout.serviceDir 'MonitorTI-Agent.exe'));notifier=(Get-Hash (Join-Path $Plan.layout.serviceDir 'MonitorTI-Notifier.exe'));integrity=(Get-Hash (Join-Path $Plan.layout.serviceDir 'notifier-integrity.json'))}; flag=[ordered]@{name=$FlagName;currentPresent=$Plan.xmlState.present;currentValue=$Plan.xmlState.value;desired=$Plan.desired}; plan=[ordered]@{atomicReplace=$true;replacementBackupName='MonitorTIAgent.xml.replace-backup';restartRequired=$true;eventSent=$false} };$summary|ConvertTo-Json -Depth 8;Write-Output 'PREFLIGHT_PASSED=true';Write-Output 'PREFLIGHT_MUTATIONS=false';return }
  $backup=Write-FlagBackup $Plan;$changed=$false
  try { $replacementBackup=Join-Path ([IO.Path]::GetFullPath($backup)) 'MonitorTIAgent.xml.replace-backup';Replace-Atomic $Plan.layout.xml $Plan.expectedBytes $replacementBackup $Plan.originalHash;$changed=$true;$installed=Get-XmlState $Plan.layout.xml;if((Get-Hash $Plan.layout.xml)-cne$Plan.expectedHash -or $installed.present -ne $Plan.desired){Fail 'installed XML validation failed'};Restart-And-Validate $Plan;Write-Output "FLAG_BACKUP_PATH=$backup";Write-Output "FLAG_ENABLED=$($Plan.desired.ToString().ToLowerInvariant())" } catch { if($changed){try{Restore-FlagBackup $Plan $backup}catch{Write-Error "automatic flag rollback failed; rollback sanitizado=true"}};throw }
}

try { $mode=Get-Mode;$plan=Get-Plan $mode;Invoke-Control $plan } catch { if($PreflightOnly){Write-Output 'PREFLIGHT_PASSED=false';Write-Output 'PREFLIGHT_MUTATIONS=false'};Write-Error $_.Exception.Message;exit 1 }
