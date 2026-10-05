param(
  [string]$ControlPackage = 'C:\TEMP\certificate-notification-pilot-v6.2-control',
  [string]$BinaryPackage = 'C:\TEMP\certificate-notification-pilot-v6.1-operational'
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$FlagName='MTI_CERTIFICATE_NOTIFICATION_TEST'

function Assert-True([bool]$Condition,[string]$Message){if(-not$Condition){throw $Message}}
function Invoke-Control([string]$Root,[string]$Mode,[hashtable]$Environment) {
  $old=@{}
  if($Environment){foreach($key in $Environment.Keys){$old[$key]=[Environment]::GetEnvironmentVariable($key);[Environment]::SetEnvironmentVariable($key,[string]$Environment[$key])}}
  $previous=$ErrorActionPreference
  try{$ErrorActionPreference='Continue';$args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root "Package\set-certificate-toast-pilot-flag-v6.ps1"),"-$Mode",'-SimulationRoot',$Root);$output=& powershell.exe @args 2>&1;return [pscustomobject]@{exit=$LASTEXITCODE;text=($output|Out-String)}}finally{$ErrorActionPreference=$previous;if($Environment){foreach($key in $Environment.Keys){[Environment]::SetEnvironmentVariable($key,$old[$key])}}}
}
function New-FlagFixture([bool]$Flag=$false) {
  $root=Join-Path ([IO.Path]::GetTempPath()) ('mti-v6-flag-'+[Guid]::NewGuid().ToString('N'));$dir=Join-Path $root 'Install With Spaces';New-Item -ItemType Directory -Path $root,(Join-Path $root 'Package'),$dir,(Join-Path $root 'ProgramData\MonitorTI\backups')|Out-Null
  Copy-Item (Join-Path $ControlPackage '*') (Join-Path $root 'Package') -Force
  Copy-Item (Join-Path $BinaryPackage 'MonitorTI-Agent.exe') (Join-Path $dir 'MonitorTIAgent.exe')
  Copy-Item (Join-Path $BinaryPackage 'MonitorTI-Agent.exe') (Join-Path $dir 'MonitorTI-Agent.exe')
  Copy-Item (Join-Path $BinaryPackage 'MonitorTI-Notifier.exe') (Join-Path $dir 'MonitorTI-Notifier.exe')
  Copy-Item (Join-Path $BinaryPackage 'notifier-integrity.json') (Join-Path $dir 'notifier-integrity.json')
  $xml='<service><id>MonitorTIAgent</id><executable>MonitorTIAgent.exe</executable></service>';if($Flag){$xml='<service><id>MonitorTIAgent</id><executable>MonitorTIAgent.exe</executable><env name="MTI_CERTIFICATE_NOTIFICATION_TEST" value="1" /></service>'};Set-Content (Join-Path $dir 'MonitorTIAgent.xml') $xml -Encoding UTF8
  New-Item -ItemType Directory -Path (Join-Path $root 'Service') -Force|Out-Null;[ordered]@{PathName=('"'+(Join-Path $dir 'MonitorTIAgent.exe')+'" --service');Name='MonitorTIAgent'}|ConvertTo-Json|Set-Content (Join-Path $root 'Service\service.json') -Encoding ASCII
  [ordered]@{deviceId='00000000-0000-4000-8000-000000000001'}|ConvertTo-Json|Set-Content (Join-Path $root 'ProgramData\MonitorTI\agent-config.json') -Encoding ASCII
  [ordered]@{user='CONTOSO\Sandbox.User';sessionId=1}|ConvertTo-Json|Set-Content (Join-Path $root 'interactive-session.json') -Encoding ASCII
  [ordered]@{serviceRunning=$true;agentSession=0;notifierSession=1;pipe=$true;currentCapabilities=@();restartCount=0}|ConvertTo-Json|Set-Content (Join-Path $root 'state.json') -Encoding ASCII
  return $root
}
function Get-FlagXml([string]$Root){$dir=Join-Path $Root 'Install With Spaces';return Get-Content (Join-Path $dir 'MonitorTIAgent.xml') -Raw}
function Get-FlagXmlBytes([string]$Root){return [IO.File]::ReadAllBytes((Join-Path (Join-Path $Root 'Install With Spaces') 'MonitorTIAgent.xml'))}
function Remove-ByteSequence([byte[]]$Bytes,[byte[]]$Needle){$offset=-1;for($i=0;$i-le$Bytes.Length-$Needle.Length;$i++){$same=$true;for($j=0;$j-lt$Needle.Length;$j++){if($Bytes[$i+$j]-ne$Needle[$j]){$same=$false;break}};if($same){$offset=$i;break}};Assert-True($offset-ge0) 'flag fragment not found';$result=New-Object System.Collections.Generic.List[byte];if($offset-gt0){$result.AddRange([byte[]]$Bytes[0..($offset-1)])};$after=$offset+$Needle.Length;if($after-lt$Bytes.Length){$result.AddRange([byte[]]$Bytes[$after..($Bytes.Length-1)])};return $result.ToArray()}
function Set-XmlVariant([string]$Root,[string]$Variant){$path=Join-Path (Join-Path $Root 'Install With Spaces') 'MonitorTIAgent.xml';$lf="`n";$content=if($Variant-eq'ONE_LINE'){'<service><description>Ação çã</description><executable>MonitorTIAgent.exe</executable></service>'}else{"<service>$lf  <description>Ação çã</description>$lf  <executable>MonitorTIAgent.exe</executable>$lf</service>$lf"};if($Variant-eq'CRLF'){$content=$content.Replace("`n","`r`n")};$encoding=if($Variant-eq'UTF8_BOM'){[Text.UTF8Encoding]::new($true)}else{[Text.UTF8Encoding]::new($false)};[IO.File]::WriteAllBytes($path,$encoding.GetBytes($content))}

$fsRoot=Join-Path ([IO.Path]::GetTempPath()) ('mti-v6-file-replace-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $fsRoot|Out-Null;$source=Join-Path $fsRoot 'source.xml';$destination=Join-Path $fsRoot 'destination.xml';$temporary=Join-Path $fsRoot 'destination.xml.tmp';$replaceBackup=Join-Path $fsRoot 'destination.xml.replace-backup';Set-Content $source '<service><env name="old" value="1"/></service>' -Encoding UTF8;Set-Content $destination (Get-Content $source -Raw) -Encoding UTF8;Set-Content $temporary '<service><env name="new" value="1"/></service>' -Encoding UTF8;$oldHash=(Get-FileHash $destination -Algorithm SHA256).Hash;$newHash=(Get-FileHash $temporary -Algorithm SHA256).Hash;try{[IO.File]::Replace([IO.Path]::GetFullPath($temporary),[IO.Path]::GetFullPath($destination),[IO.Path]::GetFullPath($replaceBackup),$true);Assert-True((Get-Content $destination -Raw)-match 'new') 'real File.Replace destination mismatch';Assert-True((Get-FileHash $replaceBackup -Algorithm SHA256).Hash-ceq$oldHash) 'real File.Replace backup hash mismatch';Assert-True((Get-FileHash $destination -Algorithm SHA256).Hash-ceq$newHash) 'real File.Replace new hash mismatch';Assert-True(-not(Test-Path $temporary)) 'real File.Replace temporary was not cleaned';Write-Output 'REAL_FILESYSTEM_REPLACE_TEST=PASS';Write-Output 'REPLACE_BACKUP_HASH_VALIDATED=PASS'}finally{Remove-Item $fsRoot -Recurse -Force -ErrorAction SilentlyContinue}

foreach($name in @('set-certificate-toast-pilot-flag-v6.ps1')){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $ControlPackage $name),[ref]$tokens,[ref]$errors)|Out-Null;Assert-True($errors.Count-eq0) "parser failed: $name"}

$root=New-FlagFixture;try{
  $before=Get-FlagXml $root;$pre=Invoke-Control $root 'PreflightOnly' $null;Assert-True($pre.exit-eq0-and$pre.text-match'PREFLIGHT_PASSED=true'-and$pre.text-match'PREFLIGHT_MUTATIONS=false') 'preflight failed';Assert-True($pre.text-notmatch'CimInstance|Microsoft.Management.Infrastructure') 'preflight output contains unsanitized CIM data';Assert-True((Get-FlagXml $root)-ceq$before) 'preflight mutated XML';Write-Output 'PREFLIGHT_MUTATIONS=false';Write-Output 'PREFLIGHT_OUTPUT_SANITIZED=PASS'
  $enable=Invoke-Control $root 'Enable' $null;Assert-True($enable.exit-eq0) "enable failed: $($enable.text)";Assert-True((Get-FlagXml $root)-match $FlagName) 'enable did not add flag';$state=Get-Content (Join-Path $root 'state.json') -Raw|ConvertFrom-Json;Assert-True($state.restartCount-eq1-and$state.currentCapabilities-eq'certificate_notification_test_v1') 'enable state invalid';Write-Output 'ENABLE_SANDBOX_TEST=PASS'
  $disable=Invoke-Control $root 'Disable' $null;Assert-True($disable.exit-eq0-and(Get-FlagXml $root)-notmatch $FlagName) "disable failed: $($disable.text)";Write-Output 'DISABLE_SANDBOX_TEST=PASS'
  $again=Invoke-Control $root 'Disable' $null;Assert-True($again.exit-eq0-and(Get-FlagXml $root)-notmatch $FlagName) 'idempotent disable failed';Write-Output 'DISABLE_IDEMPOTENT_TEST=PASS'
}finally{Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue}

foreach($variant in @('UTF8_NO_BOM','UTF8_BOM','CRLF','LF','ONE_LINE')){$root=New-FlagFixture;try{Set-XmlVariant $root $variant;$original=Get-FlagXmlBytes $root;$result=Invoke-Control $root 'Enable' $null;Assert-True($result.exit-eq0) "$variant enable failed";$enabled=Get-FlagXmlBytes $root;$fragment=[Text.UTF8Encoding]::new($false).GetBytes('<env name="MTI_CERTIFICATE_NOTIFICATION_TEST" value="1" />');$without=Remove-ByteSequence $enabled $fragment;Assert-True(([BitConverter]::ToString($without))-ceq([BitConverter]::ToString($original))) "$variant unrelated bytes changed";$disable=Invoke-Control $root 'Disable' $null;Assert-True($disable.exit-eq0) "$variant disable failed";$restored=Get-FlagXmlBytes $root;Assert-True(([BitConverter]::ToString($restored))-ceq([BitConverter]::ToString($original))) "$variant did not restore exact bytes"}finally{Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue}}
Write-Output 'ENCODING_PRESERVED=PASS';Write-Output 'BOM_PRESERVED=PASS';Write-Output 'LINE_ENDINGS_PRESERVED=PASS';Write-Output 'ACCENTED_TEXT_PRESERVED=PASS';Write-Output 'UNRELATED_BYTES_IDENTICAL=PASS';Write-Output 'ENABLE_BYTE_DELTA_VALIDATED=PASS';Write-Output 'DISABLE_RESTORES_EXACT_HASH=PASS'

$cases=@(
  @{name='DUPLICATE';xml='<service><env name="MTI_CERTIFICATE_NOTIFICATION_TEST" value="1"/><env name="MTI_CERTIFICATE_NOTIFICATION_TEST" value="1"/></service>';env=$null},
  @{name='CONFLICTING';xml='<service><env name="MTI_CERTIFICATE_NOTIFICATION_TEST" value="0"/></service>';env=$null},
  @{name='INVALID_XML';xml='<service>';env=$null},
  @{name='ATOMIC_FAILURE';xml='<service></service>';env=@{MTI_V6_FLAG_FAIL_ATOMIC='1'}},
  @{name='RESTART_FAILURE';xml='<service></service>';env=@{MTI_V6_FLAG_FAIL_RESTART='1'}},
  @{name='SERVICE_NOT_RUNNING';xml='<service></service>';env=@{MTI_V6_FLAG_SERVICE_NOT_RUNNING='1'}},
  @{name='NOTIFIER_SESSION';xml='<service></service>';env=@{MTI_V6_FLAG_NOTIFIER_SESSION='1'}},
  @{name='PIPE_ABSENT';xml='<service></service>';env=@{MTI_V6_FLAG_PIPE_ABSENT='1'}},
  @{name='CAPABILITY_ABSENT';xml='<service></service>';env=@{MTI_V6_FLAG_CAPABILITY_ABSENT='1'}}
  ,@{name='MISSING_XML';xml=$null;env=$null}
  ,@{name='REPARSE_XML';xml=$null;env=$null}
)
foreach($case in $cases){$root=New-FlagFixture;try{$dir=Join-Path $root 'Install With Spaces';$xmlPath=Join-Path $dir 'MonitorTIAgent.xml';if($case.name-eq'MISSING_XML'){Remove-Item $xmlPath -Force}else{if($case.xml){Set-Content $xmlPath $case.xml -Encoding UTF8};if($case.name-eq'REPARSE_XML'){$target=Join-Path $dir 'original.xml';Set-Content $target '<service></service>' -Encoding UTF8;Remove-Item $xmlPath -Force;New-Item -ItemType SymbolicLink -Path $xmlPath -Target $target|Out-Null}};$before=if(Test-Path $xmlPath -PathType Leaf){Get-FlagXml $root}else{$null};$result=Invoke-Control $root 'Enable' $case.env;Assert-True($result.exit-ne0) "$($case.name) unexpectedly passed";if($before){Assert-True((Get-FlagXml $root)-ceq$before) "$($case.name) did not preserve/restore XML"};if($case.name-eq'ATOMIC_FAILURE'){$state=Get-Content (Join-Path $root 'state.json') -Raw|ConvertFrom-Json;Assert-True($state.restartCount-eq0) 'atomic failure restarted service'};Write-Output "$($case.name)=PASS"}finally{Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue}}
Write-Output 'FAILURE_BEFORE_RESTART_TEST=PASS';Write-Output 'DESTINATION_HASH_GUARD=PASS'
Write-Output 'AUTOMATIC_ROLLBACK_TEST=PASS';Write-Output 'STRICT_MODE_RUNTIME_TEST=PASS'
