# Remove o servico Windows do Monitor TI Server (requer Administrador).
param()

$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object System.Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host "Este script requer privilegios de Administrador. Reiniciando elevado..."
  try {
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
      -Verb RunAs
    exit 0
  } catch {
    Write-Error "Nao foi possivel elevar. Execute este script como Administrador manualmente."
    exit 1
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$agentTest = Join-Path $repoRoot "release\agent-test"
$wrapper = Join-Path $agentTest "MonitorTIServer.exe"
$svcName = "MonitorTIServer"

$status = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if (-not $status) {
  Write-Host "Servico $svcName nao esta instalado."
  if (Test-Path $wrapper) {
    & $wrapper uninstall 2>$null
  }
  exit 0
}

Write-Host "Parando e removendo servico $svcName..."
& $wrapper stop 2>$null
Start-Sleep -Seconds 2
& $wrapper uninstall 2>$null

$remaining = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($remaining) {
  Write-Warning "O servico ainda aparece como instalado. Remova manualmente com: sc.exe delete $svcName"
  exit 1
}

Write-Host "Servico $svcName removido com sucesso."
