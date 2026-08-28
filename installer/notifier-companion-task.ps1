param(
  [ValidateSet("install","create","update","remove","run","query","queryxml","state")]
  [string]$Mode = "install"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$TaskName = 'MonitorTI-Notifier'
$Executable = 'C:\Program Files (x86)\MonitorTI\Agent\MonitorTI-Notifier.exe'
$WorkingDirectory = 'C:\Program Files (x86)\MonitorTI\Agent'
$Arguments = '--companion'
$GroupId = 'S-1-5-11'

function Get-NotifierTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Test-NotifierTaskMatches {
  param([object]$Task)
  if (-not $Task) { return $false }
  $principal = $Task.Principal
  $action = @($Task.Actions)[0]
  $trigger = @($Task.Triggers)[0]
  if (-not $principal -or -not $action -or -not $trigger) { return $false }
  $triggerType = [string]$trigger.GetType().Name
  return (
    [string]$principal.GroupId -eq $GroupId -and
    [string]$principal.LogonType -eq "Group" -and
    [string]$principal.RunLevel -eq "Limited" -and
    $triggerType -match "LogonTrigger" -and
    [string]$trigger.UserId -eq "" -and
    [string]$action.Execute -eq $Executable -and
    [string]$action.Arguments -eq $Arguments -and
    [string]$action.WorkingDirectory -eq $WorkingDirectory
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
  Write-Output ($(if ($created) { "created" } else { "updated" }))
}

function Remove-Task {
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
  $current = Get-NotifierTask
  if (-not $current) {
    [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress
    return
  }
  $principal = $current.Principal
  $action = @($current.Actions)[0]
  $trigger = @($current.Triggers)[0]
  [pscustomobject]@{
    exists = $true
    groupId = [string]$principal.GroupId
    logonType = [string]$principal.LogonType
    runLevel = [string]$principal.RunLevel
    triggerType = [string]$trigger.GetType().Name
    triggerUserId = [string]$trigger.UserId
    executable = [string]$action.Execute
    arguments = [string]$action.Arguments
    workingDirectory = [string]$action.WorkingDirectory
  } | ConvertTo-Json -Compress
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
