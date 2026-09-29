param(
  [ValidateSet("install","create","update","remove","run","query","queryxml","state")]
  [string]$Mode = "query",
  [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$TaskName = 'MonitorTI-Notifier'
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$Executable = [System.IO.Path]::Combine($InstallDir, "MonitorTI-Notifier.exe")
$WorkingDirectory = $InstallDir
$Arguments = '--companion'
$GroupId = 'S-1-5-11'
$ToastIdentityScript = [System.IO.Path]::Combine($PSScriptRoot, "notifier-toast-identity.ps1")

function Get-NotifierTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Resolve-TaskSchedulerSid {
  param([object]$Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  try {
    if ($text -match '^S-\d(-\d+)+$') {
      return ([System.Security.Principal.SecurityIdentifier]::new($text)).Value
    }
    return ([System.Security.Principal.NTAccount]::new($text)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $text.Trim()
  }
}

function Normalize-TaskLogonType {
  param([object]$Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  switch -Regex ($text.Trim()) {
    '^(?i)4$|^(?i)Group$' { return 'Group' }
    '^(?i)0$|^(?i)None$|^(?i)Null$' { return 'None' }
    '^(?i)1$|^(?i)Password$' { return 'Password' }
    '^(?i)2$|^(?i)S4U$' { return 'S4U' }
    '^(?i)3$|^(?i)InteractiveToken$' { return 'InteractiveToken' }
    '^(?i)5$|^(?i)ServiceAccount$' { return 'ServiceAccount' }
    '^(?i)6$|^(?i)InteractiveTokenOrPassword$' { return 'InteractiveTokenOrPassword' }
    default { return $text.Trim() }
  }
}

function Normalize-TaskRunLevel {
  param([object]$Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  switch -Regex ($text.Trim()) {
    '^(?i)0$|^(?i)LUA$|^(?i)Limited$|^(?i)LeastPrivilege$' { return 'Limited' }
    '^(?i)1$|^(?i)Highest$' { return 'Highest' }
    default { return $text.Trim() }
  }
}

function Get-NotifierTaskXml {
  try {
    [xml](Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop)
  } catch {
    $null
  }
}

function Get-NotifierTaskExecNode {
  param([xml]$Xml)
  if (-not $Xml -or -not $Xml.Task -or -not $Xml.Task.Actions) { return $null }
  $exec = @($Xml.Task.Actions.Exec)[0]
  if ($exec) { return $exec }
  $child = @($Xml.Task.Actions.ChildNodes | Where-Object { $_.LocalName -eq "Exec" })[0]
  if ($child) { return $child }
  return $null
}

function Test-NotifierTaskTrigger {
  param([object]$Task, [xml]$Xml)
  if ($Xml -and $Xml.Task -and $Xml.Task.Triggers) {
    foreach ($node in @($Xml.Task.Triggers.ChildNodes)) {
      if ($node -and [string]$node.LocalName -eq "LogonTrigger") { return $true }
    }
  }
  $trigger = @($Task.Triggers)[0]
  if (-not $trigger) { return $false }
  $className = $null
  if ($trigger.PSObject.Properties.Match("CimClass").Count -gt 0 -and $trigger.CimClass) {
    $className = [string]$trigger.CimClass.CimClassName
  } elseif ($trigger.PSObject.Properties.Match("CimSystemProperties").Count -gt 0 -and $trigger.CimSystemProperties) {
    $className = [string]$trigger.CimSystemProperties.ClassName
  }
  return ($className -eq "MSFT_TaskLogonTrigger" -or $className -match "LogonTrigger$")
}

function Get-NotifierTaskSnapshot {
  $current = Get-NotifierTask
  if (-not $current) { return $null }
  $principal = $current.Principal
  $xml = Get-NotifierTaskXml
  $exec = Get-NotifierTaskExecNode -Xml $xml
  $trigger = @($current.Triggers)[0]
  $className = $null
  if ($trigger -and $trigger.PSObject.Properties.Match("CimClass").Count -gt 0 -and $trigger.CimClass) {
    $className = [string]$trigger.CimClass.CimClassName
  } elseif ($trigger -and $trigger.PSObject.Properties.Match("CimSystemProperties").Count -gt 0 -and $trigger.CimSystemProperties) {
    $className = [string]$trigger.CimSystemProperties.ClassName
  }
  [pscustomobject]@{
    exists = $true
    taskName = $TaskName
    groupId = Resolve-TaskSchedulerSid $principal.GroupId
    groupIdRaw = [string]$principal.GroupId
    logonType = Normalize-TaskLogonType $principal.LogonType
    logonTypeRaw = [string]$principal.LogonType
    runLevel = Normalize-TaskRunLevel $principal.RunLevel
    runLevelRaw = [string]$principal.RunLevel
    triggerType = if (Test-NotifierTaskTrigger $current $xml) { "AtLogOn" } else { "Other" }
    triggerClassName = $className
    triggerUserId = [string]$trigger.UserId
    executable = [string]$exec.Command
    arguments = [string]$exec.Arguments
    workingDirectory = [string]$exec.WorkingDirectory
  }
}

function Test-NotifierTaskMatches {
  $snapshot = Get-NotifierTaskSnapshot
  if (-not $snapshot) { return $false }
  return (
    [string]$snapshot.taskName -eq $TaskName -and
    [string]$snapshot.groupId -eq $GroupId -and
    [string]$snapshot.logonType -eq "Group" -and
    [string]$snapshot.runLevel -eq "Limited" -and
    [string]$snapshot.triggerType -eq "AtLogOn" -and
    [string]$snapshot.triggerUserId -eq "" -and
    [string]$snapshot.executable -eq $Executable -and
    [string]$snapshot.arguments -eq $Arguments -and
    [string]$snapshot.workingDirectory -eq $WorkingDirectory
  )
}

function New-NotifierTaskAction {
  New-ScheduledTaskAction -Execute $Executable -Argument $Arguments -WorkingDirectory $WorkingDirectory
}

function New-NotifierTaskTrigger {
  New-ScheduledTaskTrigger -AtLogOn
}

function New-NotifierTaskPrincipal {
  New-ScheduledTaskPrincipal -GroupId $GroupId -RunLevel Limited
}

function New-NotifierTaskRegistrationArgs {
  @{
    TaskName = $TaskName
    Action = New-NotifierTaskAction
    Trigger = New-NotifierTaskTrigger
    Principal = New-NotifierTaskPrincipal
    Force = $true
  }
}

function Install-Or-UpdateTask {
  $current = Get-NotifierTask
  if (Test-NotifierTaskMatches $current) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ToastIdentityScript -Mode install -InstallDir $InstallDir | Out-Null
    Write-Output "unchanged"
    return
  }
  $created = -not $current
  $args = New-NotifierTaskRegistrationArgs
  Register-ScheduledTask @args | Out-Null
  $verified = Get-NotifierTask
  if (-not (Test-NotifierTaskMatches $verified)) {
    throw "tarefa registrada, mas nao validada com a definicao esperada"
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ToastIdentityScript -Mode install -InstallDir $InstallDir | Out-Null
  Write-Output ($(if ($created) { "created" } else { "updated" }))
}

function Remove-Task {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ToastIdentityScript -Mode remove -InstallDir $InstallDir | Out-Null
  $current = Get-NotifierTask
  if ($current) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}

function Run-Task {
  Start-ScheduledTask -TaskName $TaskName
}

function Query-TaskXml {
  $current = Get-NotifierTask
  if ($current) {
    Export-ScheduledTask -TaskName $TaskName
  }
}

function Query-TaskState {
  $snapshot = Get-NotifierTaskSnapshot
  if (-not $snapshot) {
    [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress
    return
  }
  $snapshot | ConvertTo-Json -Compress
}

switch ($Mode) {
  "install" { Install-Or-UpdateTask }
  "create" { Install-Or-UpdateTask }
  "update" { Install-Or-UpdateTask }
  "remove" { Remove-Task }
  "run" { Run-Task }
  "queryxml" { Query-TaskXml }
  "state" { Query-TaskState }
  "query" { Query-TaskState }
  default { throw "modo invalido: $Mode" }
}
