$ErrorActionPreference = "Stop"

param(
  [ValidateSet("install","create","update","remove","run","query")]
  [string]$Mode = "install"
)

$TaskName = "MonitorTI-Notifier"
$Executable = "C:\Program Files (x86)\MonitorTI\Agent\MonitorTI-Notifier.exe"
$WorkingDirectory = "C:\Program Files (x86)\MonitorTI\Agent"
$Arguments = "--companion"

function Invoke-Schtasks([string[]]$Args) {
  $p = Start-Process -FilePath "schtasks.exe" -ArgumentList $Args -PassThru -Wait -WindowStyle Hidden
  if ($p.ExitCode -ne 0) {
    throw "schtasks exit code $($p.ExitCode)"
  }
}

function Install-Or-UpdateTask {
  Invoke-Schtasks @(
    "/create",
    "/tn", $TaskName,
    "/tr", ('"{0}" {1}' -f $Executable, $Arguments),
    "/sc", "onlogon",
    "/rl", "limited",
    "/f"
  )
}

function Remove-Task {
  Invoke-Schtasks @(
    "/delete",
    "/tn", $TaskName,
    "/f"
  )
}

function Run-Task {
  Invoke-Schtasks @(
    "/run",
    "/tn", $TaskName
  )
}

function Query-Task {
  Invoke-Schtasks @(
    "/query",
    "/tn", $TaskName,
    "/fo", "list",
    "/v"
  )
}

switch ($Mode) {
  "install" { Install-Or-UpdateTask }
  "create" { Install-Or-UpdateTask }
  "update" { Install-Or-UpdateTask }
  "remove" { Remove-Task }
  "run" { Run-Task }
  "query" { Query-Task }
}
