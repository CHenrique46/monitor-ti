# Instala o Monitor TI Server como servico Windows (requer Administrador).
# Reinstala se ja existir, atualizando a configuracao.
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
$xml = Join-Path $agentTest "MonitorTIServer.xml"
$serverDir = Join-Path $repoRoot "server"
$envFile = Join-Path $serverDir ".env"
$distIndex = Join-Path $repoRoot "dashboard\dist\index.html"

if (-not (Test-Path $wrapper)) {
  Write-Error "Nao encontrado: $wrapper. Execute 'npm run build:production' (em server) antes de instalar o servico."
  exit 1
}
if (-not (Test-Path $xml)) {
  Write-Error "Nao encontrado: $xml. Execute 'npm run build:production' (em server) antes de instalar o servico."
  exit 1
}
if (-not (Test-Path $envFile)) {
  Write-Warning "Nao encontrado: $envFile. O servico pode nao conectar ao banco de dados."
}
if (-not (Test-Path $distIndex)) {
  Write-Warning "Dashboard nao compilado ($distIndex). O acesso via navegador pode falhar ate rodar 'npm run build:production'."
}

$svcName = "MonitorTIServer"

$existente = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($existente) {
  Write-Host "Servico $svcName ja existe. Removendo instalacao anterior para atualizar configuracao..."
  & $wrapper stop 2>$null
  & $wrapper uninstall 2>$null
  Start-Sleep -Seconds 2
}

Write-Host "Instalando servico $svcName..."
& $wrapper install
if ($LASTEXITCODE -ne 0) {
  Write-Error "Falha ao instalar o servico (codigo $LASTEXITCODE)."
  exit 1
}

Write-Host "Configurando inicializacao automatica e recuperacao..."
& sc.exe config $svcName start= auto
& sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/5000/restart/5000

Write-Host "Iniciando servico $svcName..."
& $wrapper start
Start-Sleep -Seconds 3

$status = Get-Service -Name $svcName -ErrorAction SilentlyContinue
Write-Host "Status do servico: $($status.Status) (Inicializacao: $($status.StartType))"
if ($status.Status -ne "Running") {
  Write-Warning "O servico nao esta em execucao. Verifique os logs em C:\ProgramData\MonitorTI\server\logs."
  exit 1
}

Write-Host "`nServico $svcName instalado e em execucao."
Write-Host "Dashboard disponivel em http://localhost:4000"
Write-Host "Para desinstalar: installer/uninstall-server-service.ps1"
