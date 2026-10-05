param(
  [ValidateSet("install", "remove", "query")]
  [string]$Mode = "query",
  [string]$InstallDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$Executable = [System.IO.Path]::Combine($InstallDir, "MonitorTI-Notifier.exe")
$ShortcutPath = [System.IO.Path]::Combine([Environment]::GetFolderPath("StartMenu"), "Programs", "HenriTech Control.lnk")
$Aumid = "HenriTech.Control.Notifier"

function Get-Shortcut {
  if (-not (Test-Path -LiteralPath $ShortcutPath)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  return $shell.CreateShortcut($ShortcutPath)
}

function Install-ToastIdentity {
  $directory = Split-Path -Parent $ShortcutPath
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $existing = Get-Shortcut
  if ($existing -and (([string]$existing.TargetPath -ne $Executable) -or ([string]$existing.Arguments -ne "--companion"))) {
    throw "atalho HenriTech Control existente não pertence ao MonitorTI-Notifier"
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $Executable
  $shortcut.Arguments = "--companion"
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description = "HenriTech Control"
  $shortcut.Save()
  if (-not (Test-Path -LiteralPath $ShortcutPath)) { throw "atalho de identidade não foi criado" }
  Write-Output "created"
}

function Remove-ToastIdentity {
  $shortcut = Get-Shortcut
  if (-not $shortcut) { Write-Output "absent"; return }
  if (([string]$shortcut.TargetPath -eq $Executable) -and ([string]$shortcut.Arguments -eq "--companion")) {
    Remove-Item -LiteralPath $ShortcutPath -Force
    Write-Output "removed"
    return
  }
  throw "atalho não removido porque não pertence ao MonitorTI-Notifier"
}

function Query-ToastIdentity {
  $shortcut = Get-Shortcut
  [pscustomobject]@{ exists = $null -ne $shortcut; target = if ($shortcut) { [string]$shortcut.TargetPath } else { $null } } | ConvertTo-Json -Compress
}

if ($Mode -eq "install") { Install-ToastIdentity }
elseif ($Mode -eq "remove") { Remove-ToastIdentity }
else { Query-ToastIdentity }
