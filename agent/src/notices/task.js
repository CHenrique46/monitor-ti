const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync: defaultExecFileSync } = require("child_process");

const TASK_NAME = process.env.MTI_NOTIFIER_TASK_NAME || "MonitorTI-Notifier";
const EXECUTABLE = "C:\\Program Files (x86)\\MonitorTI\\Agent\\MonitorTI-Notifier.exe";
const WORKING_DIRECTORY = "C:\\Program Files (x86)\\MonitorTI\\Agent";
const ARGUMENTS = ["--companion"];
const TASK_GROUP_ID = "S-1-5-11";
const TASK_LOGON_TYPE = "Group";
const TASK_RUN_LEVEL = "Limited";

function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function buildTaskSpec() {
  return {
    taskName: TASK_NAME,
    trigger: {
      type: "AtLogOn",
      user: null
    },
    principal: {
      groupId: TASK_GROUP_ID,
      logonType: TASK_LOGON_TYPE,
      runLevel: TASK_RUN_LEVEL
    },
    executable: EXECUTABLE,
    workingDirectory: WORKING_DIRECTORY,
    arguments: ARGUMENTS.slice(),
    elevation: "none"
  };
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") return false;
  return (
    spec.taskName === TASK_NAME &&
    spec.executable === EXECUTABLE &&
    spec.workingDirectory === WORKING_DIRECTORY &&
    Array.isArray(spec.arguments) &&
    spec.arguments.length === 1 &&
    spec.arguments[0] === "--companion" &&
    spec.elevation === "none" &&
    spec.trigger &&
    spec.trigger.type === "AtLogOn" &&
    spec.trigger.user === null &&
    spec.principal &&
    spec.principal.groupId === TASK_GROUP_ID &&
    spec.principal.logonType === TASK_LOGON_TYPE &&
    spec.principal.runLevel === TASK_RUN_LEVEL
  );
}

function buildPowerShellScript() {
  const lines = [
    'param(',
    '  [ValidateSet("install","create","update","remove","run","query","queryxml","state")]',
    '  [string]$Mode = "install"',
    ')',
    '',
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '',
    '$TaskName = ' + psSingleQuote(TASK_NAME),
    '$Executable = ' + psSingleQuote(EXECUTABLE),
    '$WorkingDirectory = ' + psSingleQuote(WORKING_DIRECTORY),
    '$Arguments = ' + psSingleQuote(ARGUMENTS[0]),
    '$GroupId = ' + psSingleQuote(TASK_GROUP_ID),
    '',
    'function Get-NotifierTask {',
    '  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Resolve-TaskSchedulerSid {',
    '  param([object]$Value)',
    '  if ($null -eq $Value) { return $null }',
    '  $text = [string]$Value',
    '  if ([string]::IsNullOrWhiteSpace($text)) { return $null }',
    '  try {',
    "    if ($text -match '^S-\\d(-\\d+)+$') {",
    '      return ([System.Security.Principal.SecurityIdentifier]::new($text)).Value',
    '    }',
    '    return ([System.Security.Principal.NTAccount]::new($text)).Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '  } catch {',
    '    return $text.Trim()',
    '  }',
    '}',
    '',
    'function Normalize-TaskLogonType {',
    '  param([object]$Value)',
    '  if ($null -eq $Value) { return $null }',
    '  $text = [string]$Value',
    '  switch -Regex ($text.Trim()) {',
    "    '^(?i)4$|^(?i)Group$' { return 'Group' }",
    "    '^(?i)0$|^(?i)None$|^(?i)Null$' { return 'None' }",
    "    '^(?i)1$|^(?i)Password$' { return 'Password' }",
    "    '^(?i)2$|^(?i)S4U$' { return 'S4U' }",
    "    '^(?i)3$|^(?i)InteractiveToken$' { return 'InteractiveToken' }",
    "    '^(?i)5$|^(?i)ServiceAccount$' { return 'ServiceAccount' }",
    "    '^(?i)6$|^(?i)InteractiveTokenOrPassword$' { return 'InteractiveTokenOrPassword' }",
    '    default { return $text.Trim() }',
    '  }',
    '}',
    '',
    'function Normalize-TaskRunLevel {',
    '  param([object]$Value)',
    '  if ($null -eq $Value) { return $null }',
    '  $text = [string]$Value',
    '  switch -Regex ($text.Trim()) {',
    "    '^(?i)0$|^(?i)LUA$|^(?i)Limited$|^(?i)LeastPrivilege$' { return 'Limited' }",
    "    '^(?i)1$|^(?i)Highest$' { return 'Highest' }",
    '    default { return $text.Trim() }',
    '  }',
    '}',
    '',
    'function Get-NotifierTaskXml {',
    '  try {',
    '    [xml](Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop)',
    '  } catch {',
    '    $null',
    '  }',
    '}',
    '',
    'function Get-NotifierTaskExecNode {',
    '  param([xml]$Xml)',
    '  if (-not $Xml -or -not $Xml.Task -or -not $Xml.Task.Actions) { return $null }',
    '  $exec = @($Xml.Task.Actions.Exec)[0]',
    '  if ($exec) { return $exec }',
    '  $child = @($Xml.Task.Actions.ChildNodes | Where-Object { $_.LocalName -eq "Exec" })[0]',
    '  if ($child) { return $child }',
    '  return $null',
    '}',
    '',
    'function Test-NotifierTaskTrigger {',
    '  param([object]$Task, [xml]$Xml)',
    '  if ($Xml -and $Xml.Task -and $Xml.Task.Triggers) {',
    '    foreach ($node in @($Xml.Task.Triggers.ChildNodes)) {',
    '      if ($node -and [string]$node.LocalName -eq "LogonTrigger") { return $true }',
    '    }',
    '  }',
    '  $trigger = @($Task.Triggers)[0]',
    '  if (-not $trigger) { return $false }',
    '  $className = $null',
    '  if ($trigger.PSObject.Properties.Match("CimClass").Count -gt 0 -and $trigger.CimClass) {',
    '    $className = [string]$trigger.CimClass.CimClassName',
    '  } elseif ($trigger.PSObject.Properties.Match("CimSystemProperties").Count -gt 0 -and $trigger.CimSystemProperties) {',
    '    $className = [string]$trigger.CimSystemProperties.ClassName',
    '  }',
    '  return ($className -eq "MSFT_TaskLogonTrigger" -or $className -match "LogonTrigger$")',
    '}',
    '',
    'function Get-NotifierTaskSnapshot {',
    '  $current = Get-NotifierTask',
    '  if (-not $current) { return $null }',
    '  $principal = $current.Principal',
    '  $xml = Get-NotifierTaskXml',
    '  $exec = Get-NotifierTaskExecNode -Xml $xml',
    '  $trigger = @($current.Triggers)[0]',
    '  $className = $null',
    '  if ($trigger -and $trigger.PSObject.Properties.Match("CimClass").Count -gt 0 -and $trigger.CimClass) {',
    '    $className = [string]$trigger.CimClass.CimClassName',
    '  } elseif ($trigger -and $trigger.PSObject.Properties.Match("CimSystemProperties").Count -gt 0 -and $trigger.CimSystemProperties) {',
    '    $className = [string]$trigger.CimSystemProperties.ClassName',
    '  }',
    '  [pscustomobject]@{',
    '    exists = $true',
    '    taskName = $TaskName',
    '    groupId = Resolve-TaskSchedulerSid $principal.GroupId',
    '    groupIdRaw = [string]$principal.GroupId',
    '    logonType = Normalize-TaskLogonType $principal.LogonType',
    '    logonTypeRaw = [string]$principal.LogonType',
    '    runLevel = Normalize-TaskRunLevel $principal.RunLevel',
    '    runLevelRaw = [string]$principal.RunLevel',
    '    triggerType = if (Test-NotifierTaskTrigger $current $xml) { "AtLogOn" } else { "Other" }',
    '    triggerClassName = $className',
    '    triggerUserId = [string]$trigger.UserId',
    '    executable = [string]$exec.Command',
    '    arguments = [string]$exec.Arguments',
    '    workingDirectory = [string]$exec.WorkingDirectory',
    '  }',
    '}',
    '',
    'function Test-NotifierTaskMatches {',
    '  $snapshot = Get-NotifierTaskSnapshot',
    '  if (-not $snapshot) { return $false }',
    '  return (',
    '    [string]$snapshot.taskName -eq $TaskName -and',
    '    [string]$snapshot.groupId -eq $GroupId -and',
    '    [string]$snapshot.logonType -eq "Group" -and',
    '    [string]$snapshot.runLevel -eq "Limited" -and',
    '    [string]$snapshot.triggerType -eq "AtLogOn" -and',
    '    [string]$snapshot.triggerUserId -eq "" -and',
    '    [string]$snapshot.executable -eq $Executable -and',
    '    [string]$snapshot.arguments -eq $Arguments -and',
    '    [string]$snapshot.workingDirectory -eq $WorkingDirectory',
    '  )',
    '}',
    '',
    'function New-NotifierTaskAction {',
    '  New-ScheduledTaskAction -Execute $Executable -Argument $Arguments -WorkingDirectory $WorkingDirectory',
    '}',
    '',
    'function New-NotifierTaskTrigger {',
    '  New-ScheduledTaskTrigger -AtLogOn',
    '}',
    '',
    'function New-NotifierTaskPrincipal {',
    '  New-ScheduledTaskPrincipal -GroupId $GroupId -RunLevel Limited',
    '}',
    '',
    'function New-NotifierTaskRegistrationArgs {',
    '  @{',
    '    TaskName = $TaskName',
    '    Action = New-NotifierTaskAction',
    '    Trigger = New-NotifierTaskTrigger',
    '    Principal = New-NotifierTaskPrincipal',
    '    Force = $true',
    '  }',
    '}',
    '',
    'function Install-Or-UpdateTask {',
    '  $current = Get-NotifierTask',
    '  if (Test-NotifierTaskMatches $current) {',
    '    Write-Output "unchanged"',
    '    return',
    '  }',
    '  $created = -not $current',
    '  $args = New-NotifierTaskRegistrationArgs',
    '  Register-ScheduledTask @args | Out-Null',
    '  $verified = Get-NotifierTask',
    '  if (-not (Test-NotifierTaskMatches $verified)) {',
    '    throw "tarefa registrada, mas nao validada com a definicao esperada"',
    '  }',
    '  Write-Output ($(if ($created) { "created" } else { "updated" }))',
    '}',
    '',
    'function Remove-Task {',
    '  $current = Get-NotifierTask',
    '  if ($current) {',
    '    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false',
    '  }',
    '}',
    '',
    'function Run-Task {',
    '  Start-ScheduledTask -TaskName $TaskName',
    '}',
    '',
    'function Query-TaskXml {',
    '  $current = Get-NotifierTask',
    '  if ($current) {',
    '    Export-ScheduledTask -TaskName $TaskName',
    '  }',
    '}',
    '',
    'function Query-TaskState {',
    '  $snapshot = Get-NotifierTaskSnapshot',
    '  if (-not $snapshot) {',
    '    [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress',
    '    return',
    '  }',
    '  $snapshot | ConvertTo-Json -Compress',
    '}',
    '',
    'switch ($Mode) {',
    '  "install" { Install-Or-UpdateTask }',
    '  "create" { Install-Or-UpdateTask }',
    '  "update" { Install-Or-UpdateTask }',
    '  "remove" { Remove-Task }',
    '  "run" { Run-Task }',
    '  "queryxml" { Query-TaskXml }',
    '  "state" { Query-TaskState }',
    '  "query" { Query-TaskState }',
    '  default { throw "modo invalido: $Mode" }',
    '}'
  ];
  return lines.join("\r\n") + "\r\n";
}

function getTaskScriptPath() {
  return path.join(os.tmpdir(), "mti-notifier-task-" + process.pid + ".ps1");
}

function writeTaskScriptFile(filePath = getTaskScriptPath()) {
  fs.writeFileSync(filePath, buildPowerShellScript(), "utf8");
  return filePath;
}

function invokeTaskMode(mode, execImpl = defaultExecFileSync) {
  const scriptPath = writeTaskScriptFile();
  try {
    return execImpl(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", mode],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
    );
  } finally {
    try { if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath); } catch {}
  }
}

function createOrUpdateTask(execImpl = defaultExecFileSync) {
  return invokeTaskMode("install", execImpl);
}

function queryTaskState(execImpl = defaultExecFileSync) {
  const out = invokeTaskMode("state", execImpl);
  const raw = String(out || "").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function queryTaskXml(execImpl = defaultExecFileSync) {
  return invokeTaskMode("queryxml", execImpl);
}

function runTask(execImpl = defaultExecFileSync) {
  return invokeTaskMode("run", execImpl);
}

function removeTask(execImpl = defaultExecFileSync) {
  return invokeTaskMode("remove", execImpl);
}

function restoreTaskXml(xml, execImpl = defaultExecFileSync) {
  if (!xml || !String(xml).trim()) return "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mti-notifier-task-rollback-"));
  const xmlPath = path.join(dir, "MonitorTI-Notifier.rollback.xml");
  fs.writeFileSync(xmlPath, xml, "utf8");
  try {
    return execImpl(
      "schtasks.exe",
      ["/create", "/xml", xmlPath, "/tn", TASK_NAME, "/f"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }
    );
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  TASK_NAME,
  EXECUTABLE,
  WORKING_DIRECTORY,
  ARGUMENTS,
  TASK_GROUP_ID,
  TASK_LOGON_TYPE,
  TASK_RUN_LEVEL,
  buildTaskSpec,
  validateSpec,
  buildPowerShellScript,
  writeTaskScriptFile,
  getTaskScriptPath,
  invokeTaskMode,
  createOrUpdateTask,
  queryTaskState,
  queryTaskXml,
  runTask,
  removeTask,
  restoreTaskXml
};
