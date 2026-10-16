[CmdletBinding()]
param(
  [string]$RepositoryRoot = $null
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))
}
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot "scripts\test-portal-luca-groq-real.js"))) { throw "RepositoryRoot inválido: runner do teste não encontrado." }

$secureKey = Read-Host "GROQ_API_KEY (entrada oculta)" -AsSecureString
$keyPtr = [IntPtr]::Zero
$plainKey = $null
$process = $null

try {
  $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
  if ([string]::IsNullOrWhiteSpace($plainKey)) { throw "A chave não pode ser vazia." }

  $nodeCommand = Get-Command node -ErrorAction Stop
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeCommand.Source
  $startInfo.Arguments = '"scripts\test-portal-luca-groq-real.js"'
  $startInfo.WorkingDirectory = $RepositoryRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables["LUCA_PROVIDER"] = "groq"
  $startInfo.EnvironmentVariables["LUCA_GROQ_MODEL"] = "openai/gpt-oss-20b"
  $startInfo.EnvironmentVariables["LUCA_GROQ_FOCUSED_CASES"] = "true"
  $startInfo.EnvironmentVariables["GROQ_API_KEY"] = $plainKey

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($stdout) { [Console]::Write($stdout) }
  if ($stderr) { [Console]::Error.Write($stderr) }
  exit $process.ExitCode
}
finally {
  if ($startInfo) { $startInfo.EnvironmentVariables.Remove("GROQ_API_KEY") }
  if ($process) { $process.Dispose() }
  if ($keyPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr) }
  $plainKey = $null
  $secureKey = $null
}
