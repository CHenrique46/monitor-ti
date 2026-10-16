[CmdletBinding()]
param(
  [string]$RepositoryRoot = $null
)

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "..")) }
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$secureKey = Read-Host "GROQ_API_KEY da prévia (entrada oculta)" -AsSecureString
$keyPtr = [IntPtr]::Zero
$plainKey = $null
$apiProcess = $null
$dashboardProcess = $null

try {
  $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
  if ([string]::IsNullOrWhiteSpace($plainKey)) { throw "A chave não pode ser vazia." }
  $node = (Get-Command node -ErrorAction Stop).Source
  $apiInfo = New-Object System.Diagnostics.ProcessStartInfo
  $apiInfo.FileName = $node
  $apiInfo.Arguments = '"scripts\preview-portal-groq.js"'
  $apiInfo.WorkingDirectory = $RepositoryRoot
  $apiInfo.UseShellExecute = $false
  $apiInfo.EnvironmentVariables["GROQ_API_KEY"] = $plainKey
  $apiInfo.EnvironmentVariables["LUCA_PREVIEW_PORT"] = "4174"
  $apiProcess = New-Object System.Diagnostics.Process
  $apiProcess.StartInfo = $apiInfo
  [void]$apiProcess.Start()

  $npm = (Get-Command npm -ErrorAction Stop).Source
  $dashboardInfo = New-Object System.Diagnostics.ProcessStartInfo
  $dashboardInfo.FileName = $npm
  $dashboardInfo.Arguments = "run dev -- --host 127.0.0.1 --port 4173"
  $dashboardInfo.WorkingDirectory = Join-Path $RepositoryRoot "dashboard"
  $dashboardInfo.UseShellExecute = $false
  $dashboardInfo.EnvironmentVariables["VITE_LUCA_AI_PREVIEW"] = "true"
  $dashboardInfo.EnvironmentVariables["VITE_PREVIEW_API_URL"] = "http://127.0.0.1:4174"
  $dashboardProcess = New-Object System.Diagnostics.Process
  $dashboardProcess.StartInfo = $dashboardInfo
  [void]$dashboardProcess.Start()
  Write-Host "Prévia disponível em http://127.0.0.1:4173/portal/certificados"
  Write-Host "Catálogo sintético: Alfa tem dois resultados; IDs 104/105 exercitam duplicidade/falha da API."
  Write-Host "Ctrl+C encerra a prévia e remove a chave dos processos locais."
  while (-not $dashboardProcess.HasExited) { Start-Sleep -Seconds 1 }
}
finally {
  if ($dashboardProcess -and -not $dashboardProcess.HasExited) { $dashboardProcess.Kill() }
  if ($apiProcess -and -not $apiProcess.HasExited) { $apiProcess.Kill() }
  if ($apiInfo) { $apiInfo.EnvironmentVariables.Remove("GROQ_API_KEY") }
  if ($keyPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr) }
  $plainKey = $null
  $secureKey = $null
}
