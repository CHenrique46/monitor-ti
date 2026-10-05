param()

$ErrorActionPreference = "Stop"
$MaxInputBytes = 16384
$MaxOutputBytes = 4096

function Write-Protocol([bool]$Ok, [string]$Result, [string]$Code) {
    $payload = [ordered]@{ ok = $Ok; result = $Result; code = $Code }
    $json = $payload | ConvertTo-Json -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt $MaxOutputBytes) { $json = '{"ok":false,"result":"ERROR","code":"HELPER_OUTPUT_LIMIT"}' }
    [Console]::Out.Write($json)
}

function Fail([string]$Code) {
    Write-Protocol $false "ERROR" $Code
    exit 0
}

function Is-Reparse([IO.FileSystemInfo]$Item) {
    return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Remove-KnownProviderPrefix([string]$Value) {
    if ($Value -match '^(?i:Microsoft\.PowerShell\.Core\\FileSystem|FileSystem)::(.+)$') { return $Matches[1] }
    if ($Value -match '^[^:]+::') { Fail "PROVIDER_INVALID" }
    return $Value
}

function Normalize-CanonicalPath([string]$Value, [string]$Code) {
    $raw = Remove-KnownProviderPrefix ([string]$Value)
    if ([string]::IsNullOrWhiteSpace($raw)) { Fail $Code }
    try {
        $full = [IO.Path]::GetFullPath($raw)
        if ([string]::IsNullOrWhiteSpace($full)) { Fail $Code }
        return $full.TrimEnd('\')
    } catch { Fail $Code }
}

function Get-CanonicalExisting([string]$Value, [string]$Code) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 4096) { Fail $Code }
    try { $item = Get-Item -LiteralPath $Value -Force -ErrorAction Stop } catch { Fail $Code }
    if (-not $item.PSProvider -or $item.PSProvider.Name -ne "FileSystem") { Fail "PROVIDER_INVALID" }
    if (Is-Reparse $item) { Fail "TARGET_UNSAFE" }
    try { $resolved = Resolve-Path -LiteralPath $item.FullName -ErrorAction Stop } catch { Fail $Code }
    if (-not $resolved.Provider -or $resolved.Provider.Name -ne "FileSystem") { Fail "PROVIDER_INVALID" }
    return Normalize-CanonicalPath $resolved.ProviderPath $Code
}

function Test-Within([string]$Root, [string]$Target) {
    $rootValue = $Root.TrimEnd('\')
    $targetValue = $Target.TrimEnd('\')
    return [string]::Equals($rootValue, $targetValue, [StringComparison]::OrdinalIgnoreCase) -or $targetValue.StartsWith($rootValue + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-Root([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 4096) { Fail "ROOT_INVALID" }
    if ($Value -match '^[A-Za-z][A-Za-z0-9+.-]*://' -or $Value -match '[*?]' -or $Value -match '(^|[\/])\.\.([\/]|$)' -or $Value -match '[\x00-\x1F]') { Fail "ROOT_INVALID" }
    try { $item = Get-Item -LiteralPath $Value -Force -ErrorAction Stop } catch { Fail "ROOT_UNAVAILABLE" }
    if (-not $item.PSIsContainer -or (Is-Reparse $item)) { Fail "ROOT_INVALID" }
    return Get-CanonicalExisting $item.FullName "ROOT_INVALID"
}

function Get-CanonicalTarget([string]$Root, [string]$Filename, [bool]$AllowTemp = $false) {
    if ([string]::IsNullOrWhiteSpace($Filename) -or $Filename.Length -gt 255) { Fail "TARGET_INVALID" }
    if ($Filename -match '(^|[\/])\.\.([\/]|$)' -or $Filename -match '[\\/:*?"<>|]' -or $Filename -match '[\x00-\x1F]' -or $Filename -match '\.\.') { Fail "TARGET_INVALID" }
    if ([IO.Path]::GetFileName($Filename) -ne $Filename) { Fail "TARGET_INVALID" }
    if ($AllowTemp) {
        if ($Filename -notmatch '(?i)^\.[0-9a-f-]{36}\.(pfx|p12)\.tmp$') { Fail "TEMP_TARGET_INVALID" }
    } elseif ($Filename -notmatch '(?i)^[^./]+\.(pfx|p12)$') { Fail "TARGET_INVALID" }
    $targetInput = Join-Path $Root $Filename
    $existing = $null
    try { $existing = Get-Item -LiteralPath $targetInput -Force -ErrorAction Stop } catch { $existing = $null }
    if ($existing) {
        if ($existing.PSIsContainer -or (Is-Reparse $existing)) { Fail "TARGET_UNSAFE" }
        $target = Get-CanonicalExisting $existing.FullName "TARGET_UNAVAILABLE"
    } else {
        $target = Normalize-CanonicalPath $targetInput "TARGET_INVALID"
    }
    if (-not (Test-Within $Root $target)) { Fail "TARGET_OUTSIDE_ROOT" }
    return $target
}

function Get-TempTarget([string]$Root, [string]$Filename) {
    return Get-CanonicalTarget $Root $Filename $true
}

function Inspect([string]$Root, [string]$Filename, [string]$ExpectedFingerprint) {
    $target = Get-CanonicalTarget $Root $Filename
    try { $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop } catch { if ($_.Exception -is [IO.FileNotFoundException] -or $_.Exception.HResult -eq -2147024894) { return "ABSENT" }; Fail "TARGET_UNAVAILABLE" }
    if ($item.PSIsContainer -or (Is-Reparse $item)) { Fail "TARGET_UNSAFE" }
    if ([string]::IsNullOrWhiteSpace($ExpectedFingerprint) -or $ExpectedFingerprint -notmatch '^[A-Fa-f0-9]{64}$') { Fail "FINGERPRINT_INVALID" }
    try { $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash } catch { Fail "HASH_FAILED" }
    if (-not [string]::Equals($actual, $ExpectedFingerprint, [StringComparison]::OrdinalIgnoreCase)) { Fail "FINGERPRINT_MISMATCH" }
    return "PRESENT_VALID"
}

try {
    $InputJson = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($InputJson) -gt $MaxInputBytes) { Fail "INPUT_LIMIT" }
    $request = $InputJson | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $request -or $request.operation -notin @("inspect", "inspect_presence", "remove", "remove_temp")) { Fail "INPUT_INVALID" }
    $root = Get-Root ([string]$request.destinationRoot)
    $filename = [string]$request.filename
    $fingerprint = [string]$request.expectedFingerprint
    if ($request.operation -eq "remove_temp") {
        $target = Get-TempTarget $root $filename
        try { $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop } catch { if ($_.Exception -is [IO.FileNotFoundException] -or $_.Exception.HResult -eq -2147024894) { Write-Protocol $true "ABSENT" ""; exit 0 }; Fail "TEMP_TARGET_UNAVAILABLE" }
        if ($item.PSIsContainer -or (Is-Reparse $item)) { Fail "TEMP_TARGET_UNSAFE" }
        Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        try { Get-Item -LiteralPath $target -Force -ErrorAction Stop | Out-Null; Fail "DELETE_UNCONFIRMED" } catch { if ($_.Exception -isnot [IO.FileNotFoundException] -and $_.Exception.HResult -ne -2147024894) { Fail "DELETE_UNCONFIRMED" } }
        Write-Protocol $true "REMOVED" ""
        exit 0
    }
    if ($request.operation -eq "inspect_presence") {
        $target = Get-CanonicalTarget $root $filename
        try { $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop } catch { if ($_.Exception -is [IO.FileNotFoundException] -or $_.Exception.HResult -eq -2147024894) { Write-Protocol $true "ABSENT" ""; exit 0 }; Fail "TARGET_UNAVAILABLE" }
        if ($item.PSIsContainer -or (Is-Reparse $item)) { Fail "TARGET_UNSAFE" }
        Write-Protocol $true "PRESENT" ""
        exit 0
    }
    $state = Inspect $root $filename $fingerprint
    if ($request.operation -eq "inspect") {
        Write-Protocol $true $state ""
        exit 0
    }
    if ($state -eq "ABSENT") { Write-Protocol $true "ABSENT" ""; exit 0 }
    $target = Get-CanonicalTarget $root $filename
    Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    try { Get-Item -LiteralPath $target -Force -ErrorAction Stop | Out-Null; Fail "DELETE_UNCONFIRMED" } catch { if ($_.Exception -isnot [IO.FileNotFoundException] -and $_.Exception.HResult -ne -2147024894) { Fail "DELETE_UNCONFIRMED" } }
    Write-Protocol $true "REMOVED" ""
}
catch { Write-Protocol $false "ERROR" "HELPER_FAILED" }
finally {
    $request = $null
}
