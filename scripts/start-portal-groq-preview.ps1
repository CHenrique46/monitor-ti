[CmdletBinding()]
param(
  [string]$RepositoryRoot = $null,
  [int]$RunForSeconds = 0
)

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot "..")) }
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$previewApiScript = Join-Path $RepositoryRoot "scripts\preview-portal-groq.js"
$viteCli = Join-Path $RepositoryRoot "dashboard\node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $previewApiScript)) { throw "API da prévia não encontrada: $previewApiScript" }
if (-not (Test-Path -LiteralPath $viteCli)) { throw "CLI do Vite não encontrado: $viteCli" }
$secureKey = Read-Host "GROQ_API_KEY da prévia (entrada oculta)" -AsSecureString
$keyPtr = [IntPtr]::Zero
$plainKey = $null
$startedProcesses = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$apiProcess = $null
$dashboardProcess = $null
$primaryError = $null

function Start-TrackedProcess([System.Diagnostics.ProcessStartInfo]$StartInfo, [string]$Name) {
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $StartInfo
  try {
    if (-not $process.Start()) { throw "$Name não iniciou." }
    [void]$startedProcesses.Add($process)
    if ($process.HasExited) { throw "$Name encerrou imediatamente com código $($process.ExitCode)." }
    return $process
  } catch {
    if (-not $startedProcesses.Contains($process)) { $process.Dispose() }
    throw
  }
}

try {
  $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
  if ([string]::IsNullOrWhiteSpace($plainKey)) { throw "A chave não pode ser vazia." }
  $node = (Get-Command node.exe -ErrorAction Stop).Source

  $apiInfo = New-Object System.Diagnostics.ProcessStartInfo
  $apiInfo.FileName = $node
  $apiInfo.Arguments = '"{0}"' -f $previewApiScript
  $apiInfo.WorkingDirectory = $RepositoryRoot
  $apiInfo.UseShellExecute = $false
  $apiInfo.EnvironmentVariables["GROQ_API_KEY"] = $plainKey
  $apiInfo.EnvironmentVariables["LUCA_PREVIEW_PORT"] = "4174"
  $apiProcess = Start-TrackedProcess $apiInfo "API candidata"
  Start-Sleep -Milliseconds 250
  if ($apiProcess.HasExited) { throw "API candidata encerrou imediatamente com código $($apiProcess.ExitCode)." }

  $dashboardInfo = New-Object System.Diagnostics.ProcessStartInfo
  $dashboardInfo.FileName = $node
  $dashboardInfo.Arguments = '"{0}" --host 127.0.0.1 --port 4173 --strictPort' -f $viteCli
  $dashboardInfo.WorkingDirectory = Join-Path $RepositoryRoot "dashboard"
  $dashboardInfo.UseShellExecute = $false
  $dashboardInfo.EnvironmentVariables["VITE_LUCA_AI_PREVIEW"] = "true"
  $dashboardInfo.EnvironmentVariables["VITE_PREVIEW_API_URL"] = "http://127.0.0.1:4174"
  [void]$dashboardInfo.EnvironmentVariables.Remove("GROQ_API_KEY")
  $dashboardProcess = Start-TrackedProcess $dashboardInfo "Dashboard Vite"
  Write-Host "Prévia disponível em http://127.0.0.1:4173/portal/certificados"
  Write-Host "Catálogo sintético: Alfa tem dois resultados; IDs 104/105 exercitam duplicidade/falha da API."
  Write-Host "Ctrl+C encerra a prévia e remove a chave dos processos locais."
  $deadline = if ($RunForSeconds -gt 0) { (Get-Date).AddSeconds($RunForSeconds) } else { $null }
  while (-not $dashboardProcess.HasExited -and ($null -eq $deadline -or (Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }
  if ($dashboardProcess.HasExited -and ($null -eq $deadline -or (Get-Date) -lt $deadline)) { throw "Dashboard Vite encerrou inesperadamente com código $($dashboardProcess.ExitCode)." }
} catch {
  $primaryError = $_
} finally {
  for ($index = $startedProcesses.Count - 1; $index -ge 0; $index--) {
    $process = $startedProcesses[$index]
    try {
      if (-not $process.HasExited) {
        $process.Kill()
        [void]$process.WaitForExit(5000)
      }
    } catch {
      Write-Warning "Não foi possível encerrar o processo da prévia $($process.Id): $($_.Exception.Message)"
    } finally {
      try { $process.Dispose() } catch { Write-Warning "Não foi possível liberar o processo da prévia: $($_.Exception.Message)" }
    }
  }
  if ($apiInfo) { [void]$apiInfo.EnvironmentVariables.Remove("GROQ_API_KEY") }
  if ($keyPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr) }
  $plainKey = $null
  $secureKey = $null
}

if ($primaryError) {
  Write-Error $primaryError.Exception.Message
  exit 1
}
