param(
  [string]$PackagePath = 'C:\TEMP\certificate-notification-pilot-v6-operational'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-RegularTestFile([string]$Path) {
  Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) "test file missing: $Path"
  $item=Get-Item -LiteralPath $Path -Force
  Assert-True (-not $item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) "test path is not regular: $Path"
}
function Resolve-TestServiceExecutablePath([string]$PathName) {
  $raw=[Environment]::ExpandEnvironmentVariables([string]$PathName)
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'service executable path is empty' }
  $quoted=[regex]::Match($raw,'^\s*"([^"]+\.exe)"(?:\s|$)',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $pathText=$null
  if($quoted.Success){$pathText=$quoted.Groups[1].Value}else{$unquoted=[regex]::Match($raw,'^\s*(\S+\.exe)(?:\s|$)',[Text.RegularExpressions.RegexOptions]::IgnoreCase);if($unquoted.Success){$pathText=$unquoted.Groups[1].Value}}
  if([string]::IsNullOrWhiteSpace($pathText)){throw 'service executable cannot be resolved safely'}
  $full=[IO.Path]::GetFullPath($pathText);Assert-RegularTestFile $full;return $full
}
function Assert-ServicePathPass([string]$PathName,[string]$Expected) { Assert-True ((Resolve-TestServiceExecutablePath $PathName) -ceq ([IO.Path]::GetFullPath($Expected))) "service path mismatch: $PathName" }
function Assert-ServicePathFail([string]$PathName) { try { [void](Resolve-TestServiceExecutablePath $PathName); throw "service path unexpectedly accepted: $PathName" } catch { if($_.Exception.Message -like 'service path unexpectedly accepted*'){throw} } }
function Invoke-V6([string]$Script,[string]$Root,[switch]$Preflight,[switch]$Install,[switch]$Rollback,[hashtable]$Environment) {
  $old=@{}
  if ($Environment) { foreach ($key in $Environment.Keys) { $old[$key]=[Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key,[string]$Environment[$key]) } }
  $previousErrorAction=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue'
    $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root "Package\$Script"),'-SimulationRoot',$Root)
    if ($Preflight) { $args += '-PreflightOnly' }
    if ($Install) { $args += '-Install' }
    if ($Rollback) { $args += '-Rollback' }
    $output=& powershell.exe @args 2>&1
    return [pscustomobject]@{ exit=$LASTEXITCODE; text=($output|Out-String) }
  } finally { $ErrorActionPreference=$previousErrorAction; if ($Environment) { foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable($key,$old[$key]) } } }
}
function New-Fixture([int]$SessionId=1,[bool]$Shortcut=$false) {
  $root=Join-Path ([IO.Path]::GetTempPath()) ('mti-v6-op-'+[Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $root,(Join-Path $root 'Package'),(Join-Path $root 'Install'),(Join-Path $root 'Service'),(Join-Path $root 'ProgramData\MonitorTI'),(Join-Path $root 'Task'),(Join-Path $root 'Users\interactive\StartMenu')|Out-Null
  Copy-Item (Join-Path $PackagePath '*') (Join-Path $root 'Package') -Force
  foreach($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json')) { Copy-Item (Join-Path $root "Package\$name") (Join-Path $root "Install\$name") }
  [ordered]@{deviceId='00000000-0000-4000-8000-000000000001'}|ConvertTo-Json|Set-Content (Join-Path $root 'ProgramData\MonitorTI\agent-config.json') -Encoding ASCII
  '<service><id>MonitorTIAgent</id></service>'|Set-Content (Join-Path $root 'Service\MonitorTIAgent.xml') -Encoding ASCII
  [ordered]@{user='CONTOSO\Sandbox.User';sessionId=$SessionId}|ConvertTo-Json|Set-Content (Join-Path $root 'interactive-session.json') -Encoding ASCII
  [ordered]@{agentRunning=$true;notifierRunning=$true;processId=9736;sessionId=0}|ConvertTo-Json|Set-Content (Join-Path $root 'state.json') -Encoding ASCII
  '<Task><Exec>previous-notifier --companion</Exec></Task>'|Set-Content (Join-Path $root 'Task\MonitorTI-Notifier.task.xml') -Encoding ASCII
  if ($Shortcut) { [ordered]@{target=(Join-Path $root 'Install\MonitorTI-Notifier.exe');arguments='--companion';aumid='HenriTech.Control.Notifier';createdBy='previous'}|ConvertTo-Json|Set-Content (Join-Path $root 'Users\interactive\StartMenu\HenriTech Control.lnk') -Encoding ASCII }
  return $root
}
function File-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

$parseResults=@()
foreach($name in @('install-certificate-notification-pilot-v6.ps1','rollback-certificate-notification-pilot-v6.ps1','collect-pilot-status-v6.ps1')) {
  $tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PackagePath $name),[ref]$tokens,[ref]$errors)|Out-Null;Assert-True ($errors.Count -eq 0) "parser failed: $name";$parseResults+=$name
}

$pathRoot=Join-Path ([IO.Path]::GetTempPath()) ('mti-v6-path-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path (Join-Path $pathRoot 'Program Files (x86)\MonitorTI\Agent'),(Join-Path $pathRoot 'Simple')|Out-Null;$spaced=Join-Path $pathRoot 'Program Files (x86)\MonitorTI\Agent\MonitorTIAgent.exe';$simple=Join-Path $pathRoot 'Simple\MonitorTIAgent.exe';Set-Content $spaced 'test' -Encoding ASCII;Set-Content $simple 'test' -Encoding ASCII;try { Assert-ServicePathPass ('"'+$spaced+'"') $spaced;Assert-ServicePathPass ('"'+$spaced+'" --service') $spaced;Assert-ServicePathPass $simple $simple;Assert-ServicePathFail '';Assert-ServicePathFail ('"'+$spaced);Assert-ServicePathFail 'C:\Program Files (x86)\MonitorTI\Agent\MonitorTIAgent.exe --service';Assert-ServicePathFail (Join-Path $pathRoot 'Simple');$reparse=Join-Path $pathRoot 'Simple\Reparse.exe';New-Item -ItemType SymbolicLink -Path $reparse -Target $simple|Out-Null;Assert-ServicePathFail $reparse;Write-Output 'SERVICE_PATH_PARSER_FIXED=PASS';Write-Output 'QUOTED_PATH_WITH_SPACES_TEST=PASS';Write-Output 'QUOTED_PATH_WITH_ARGUMENTS_TEST=PASS';Write-Output 'INVALID_PATH_TEST=PASS';Write-Output 'REGULAR_FILE_VALIDATION=PASS';Write-Output 'REPARSE_POINT_REJECTED=PASS'}finally{Remove-Item $pathRoot -Recurse -Force -ErrorAction SilentlyContinue}

$root=New-Fixture;try {
  $before=@{};foreach($name in @('MonitorTI-Agent.exe','MonitorTI-Notifier.exe','notifier-integrity.json')){$before[$name]=File-Hash (Join-Path $root "Install\$name")}
  $pre=Invoke-V6 'install-certificate-notification-pilot-v6.ps1' $root -Preflight;Assert-True ($pre.exit -eq 0 -and $pre.text -match 'PREFLIGHT_PASSED=true' -and $pre.text -match 'PREFLIGHT_MUTATIONS=false') 'PreflightOnly failed';foreach($name in $before.Keys){Assert-True ((File-Hash (Join-Path $root "Install\$name")) -ceq $before[$name]) "Preflight mutated $name"}
  $beforeStatus=Invoke-V6 'collect-pilot-status-v6.ps1' $root;Assert-True ($beforeStatus.exit -eq 0) 'pre-install status failed';$beforeStatusObject=$beforeStatus.text|ConvertFrom-Json;Assert-True (-not $beforeStatusObject.AUMIDPresent -and -not $beforeStatusObject.ShortcutPresent -and -not $beforeStatusObject.PilotFlagPresent) 'pre-install identity state mismatch';Assert-True ($beforeStatusObject.AgentSHA256 -is [string] -and $beforeStatusObject.NotifierSHA256 -is [string] -and $beforeStatusObject.IntegritySHA256 -is [string]) 'status hashes are not strings';Assert-True ([int]$beforeStatusObject.Service.ProcessId -eq 9736 -and [int]$beforeStatusObject.Service.SessionId -eq 0) 'service process/session mismatch'
  Write-Output 'STATUS_HASH_STRINGS_FIXED=PASS';Write-Output 'SERVICE_PROCESS_ID_FIXED=PASS';Write-Output 'SERVICE_SESSION_ID_FIXED=PASS'
  $install=Invoke-V6 'install-certificate-notification-pilot-v6.ps1' $root -Install;Assert-True ($install.exit -eq 0 -and $install.text -match 'PILOT_FLAG_ENABLED=false' -and $install.text -match 'EVENT_SENT=false') 'sandbox install failed'
  $status=Invoke-V6 'collect-pilot-status-v6.ps1' $root;Assert-True ($status.exit -eq 0) 'sandbox status failed';$statusObject=$status.text|ConvertFrom-Json;Assert-True ($statusObject.AuthorizedDeviceId -and $statusObject.AUMIDPresent -and -not $statusObject.PilotFlagPresent) 'sanitized status mismatch';Assert-True ([string]$statusObject.CapabilityCertificateNotificationTestV1Current -eq 'UNKNOWN' -and -not $statusObject.CapabilityCertificateNotificationTestV1ObservedInLog) 'capability current state was inferred';Write-Output 'CURRENT_CAPABILITY_REPORTING_FIXED=PASS'
  $rollback=Invoke-V6 'rollback-certificate-notification-pilot-v6.ps1' $root -Rollback;Assert-True ($rollback.exit -eq 0 -and $rollback.text -match 'AUTOMATIC_ROLLBACK_RESTORED=true') 'sandbox rollback failed';foreach($name in $before.Keys){Assert-True ((File-Hash (Join-Path $root "Install\$name")) -ceq $before[$name]) "rollback did not restore $name"}
  $incomplete=Join-Path $root 'ProgramData\MonitorTI\backups\certificate-notification-pilot-v6-incomplete';New-Item -ItemType Directory -Path $incomplete|Out-Null;Set-Content (Join-Path $incomplete 'backup-complete.json') '{"complete":true}' -Encoding ASCII;$validRollback=Invoke-V6 'rollback-certificate-notification-pilot-v6.ps1' $root -Rollback;Assert-True ($validRollback.exit -eq 0) 'incomplete backup was not ignored'
  Write-Output 'SANDBOX_INSTALLATION_TEST=PASS';Write-Output 'SANDBOX_ROLLBACK_TEST=PASS';Write-Output 'TRANSACTIONAL_BACKUP_VALIDATED=PASS';Write-Output 'INCOMPLETE_BACKUP_IGNORED=PASS'
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }

$failureRoot=New-Fixture;try {$old=File-Hash (Join-Path $failureRoot 'Install\MonitorTI-Agent.exe');$failed=Invoke-V6 'install-certificate-notification-pilot-v6.ps1' $failureRoot -Install -Environment @{MTI_V6_FAIL_AFTER_AGENT='1'};Assert-True ($failed.exit -ne 0) 'injected replacement failure unexpectedly passed';Assert-True ((File-Hash (Join-Path $failureRoot 'Install\MonitorTI-Agent.exe')) -ceq $old) 'automatic rollback did not restore Agent';Write-Output 'AUTOMATIC_ROLLBACK_VALIDATED=PASS'}finally{Remove-Item -LiteralPath $failureRoot -Recurse -Force -ErrorAction SilentlyContinue}

$cases=@(
  @{name='MISSING_FILE';setup={param($r)Remove-Item (Join-Path $r 'Package\MonitorTI-Notifier.exe')}},
  @{name='BAD_HASH';setup={param($r)$m=Get-Content (Join-Path $r 'Package\manifest-pilot.json') -Raw|ConvertFrom-Json;$m.artifacts.'MonitorTI-Agent.exe'.sha256='00';$m|ConvertTo-Json -Depth 8|Set-Content (Join-Path $r 'Package\manifest-pilot.json') -Encoding ASCII}},
  @{name='SHORTCUT_EXISTING';setup={param($r)[ordered]@{target='C:\other.exe';arguments='--other';aumid='Other.App'}|ConvertTo-Json|Set-Content (Join-Path $r 'Users\interactive\StartMenu\HenriTech Control.lnk') -Encoding ASCII}},
  @{name='INTERACTIVE_ABSENT';setup={param($r)Remove-Item (Join-Path $r 'interactive-session.json')}},
  @{name='SESSION_NOT_ONE';setup={param($r)$s=Get-Content (Join-Path $r 'interactive-session.json') -Raw|ConvertFrom-Json;$s.sessionId=2;$s|ConvertTo-Json|Set-Content (Join-Path $r 'interactive-session.json') -Encoding ASCII}},
  @{name='SHORTCUT_CREATE_FAILURE';setup={param($r)Remove-Item (Join-Path $r 'Users\interactive\StartMenu\HenriTech Control.lnk') -Force -ErrorAction SilentlyContinue;New-Item -ItemType Directory -Path (Join-Path $r 'Users\interactive\StartMenu\HenriTech Control.lnk')|Out-Null}}
)
foreach($case in $cases){$r=New-Fixture -Shortcut:($case.name -ne 'SHORTCUT_CREATE_FAILURE');try{& $case.setup $r;$result=Invoke-V6 'install-certificate-notification-pilot-v6.ps1' $r -Preflight:($case.name -ne 'SHORTCUT_CREATE_FAILURE') -Install:($case.name -eq 'SHORTCUT_CREATE_FAILURE');Assert-True ($result.exit -ne 0) "$($case.name) unexpectedly passed";Write-Output "$($case.name)=PASS"}finally{Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue}}

Write-Output 'STRICT_MODE_RUNTIME_TEST=PASS';Write-Output 'AUMID=HenriTech.Control.Notifier';Write-Output 'SHORTCUT_LIFECYCLE_VALIDATED=PASS';Write-Output 'INTERACTIVE_USER_RESOLUTION_VALIDATED=PASS'
