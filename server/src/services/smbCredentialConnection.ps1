param(
    [ValidateSet("connect", "disconnect")][string]$Operation,
    [string]$SourceShareRoot,
    [string]$DestinationShareRoot,
    [string]$SecretPath,
    [string]$ExpectedIdentity
)
$ErrorActionPreference = "Stop"
$plainBytes = $null
$encryptedBytes = $null
$payload = $null
Add-Type -AssemblyName System.Security -ErrorAction Stop

function Normalize-Identity([string]$value) {
    return ([string]$value).Trim().Replace('/', '\')
}

function Get-ValidatedSecretPath([string]$value) {
    $raw = ([string]$value).Trim()
    if (-not $raw -or $raw -match '^[A-Za-z][A-Za-z0-9+.-]*://' -or $raw -match '^\\[?.]' -or $raw -match '[?*]' -or $raw -match '(^|[\\/])\.\.([\\/]|$)' -or $raw -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') {
        throw "SMB_SECRET_PATH_INVALID"
    }
    try { $normalized = [IO.Path]::GetFullPath($raw) } catch { throw "SMB_SECRET_PATH_INVALID" }
    if ([IO.Path]::GetFileName($normalized).ToLowerInvariant() -ne "certificados-smb.dpapi") { throw "SMB_SECRET_FILE_INVALID" }
    try { $item = Get-Item -LiteralPath $normalized -Force -ErrorAction Stop } catch { throw "SMB_SECRET_FILE_UNAVAILABLE" }
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "SMB_SECRET_FILE_INVALID" }
    return $normalized
}

function Get-ValidatedIdentity([string]$value) {
    $normalized = Normalize-Identity $value
    if ($normalized -notmatch '^[^\\/:*?"<>|\s]+\\[^\\/:*?"<>|\s]+$') { throw "SMB_IDENTITY_INVALID" }
    return $normalized
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class HenriTechWNetNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct NETRESOURCE {
        public int dwScope;
        public int dwType;
        public int dwDisplayType;
        public int dwUsage;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpLocalName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpRemoteName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpComment;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpProvider;
    }

    [DllImport("mpr.dll", EntryPoint = "WNetAddConnection2W", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int WNetAddConnection2W(ref NETRESOURCE netResource, [MarshalAs(UnmanagedType.LPWStr)] string password, [MarshalAs(UnmanagedType.LPWStr)] string userName, int flags);

    [DllImport("mpr.dll", EntryPoint = "WNetCancelConnection2W", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int WNetCancelConnection2W([MarshalAs(UnmanagedType.LPWStr)] string name, int flags, bool force);
}
"@

function Write-Result([bool]$Ok, [string]$Code = "") {
    Write-Output ("SMB_RESULT=" + $(if ($Ok) { "OK" } else { "ERROR" }))
    if (-not $Ok) { Write-Output "SMB_CODE=$Code" }
}

function Map-Win32Code([int]$Code) {
    switch ($Code) {
        5 { "SMB_ACCESS_DENIED"; break }
        53 { "SMB_SERVER_UNAVAILABLE"; break }
        67 { "SMB_SHARE_NOT_FOUND"; break }
        1326 { "SMB_INVALID_CREDENTIALS"; break }
        1312 { "SMB_LOGON_SESSION_MISSING"; break }
        1219 { "SMB_SESSION_CONFLICT"; break }
        2250 { "SMB_CONNECTION_NOT_FOUND"; break }
        default { "SMB_WIN32_$Code" }
    }
}

function Disconnect-OwnedShares([string[]]$shares) {
    foreach ($share in @($shares)) {
        if ($share) { [HenriTechWNetNative]::WNetCancelConnection2W($share, 0, $false) | Out-Null }
    }
}

try {
    $secretPath = Get-ValidatedSecretPath $SecretPath
    $identity = Get-ValidatedIdentity $ExpectedIdentity
    $currentIdentity = Normalize-Identity ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    if (-not [string]::Equals($currentIdentity, $identity, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Result $false "SMB_CONTEXT_INVALID"
        exit 0
    }
    if ($Operation -eq "disconnect") {
        $shares = @($SourceShareRoot, $DestinationShareRoot) | Where-Object { $_ } | Select-Object -Unique
        $failed = $false
        foreach ($share in $shares) {
            $code = [HenriTechWNetNative]::WNetCancelConnection2W($share, 0, $false)
            if ($code -ne 0 -and $code -ne 2250) { $failed = $true; $failureCode = Map-Win32Code $code }
        }
        if (-not $failed) { Write-Result $true } else { Write-Result $false $failureCode }
        exit 0
    }
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        Write-Result $false "SMB_CREDENTIAL_NOT_PROVISIONED"
        exit 0
    }
    $encryptedBytes = [IO.File]::ReadAllBytes($secretPath)
    try {
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [byte[]]$encryptedBytes,
            [byte[]]$null,
            [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        $payload = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
    }
    catch {
        Write-Result $false "SMB_DPAPI_INVALID"
        exit 0
    }
    if (-not $payload.Server -or -not $payload.User -or -not $payload.Password) {
        Write-Result $false "SMB_DPAPI_INVALID"
        exit 0
    }
    $remoteName = [string]$payload.Server
    if ($remoteName -notmatch '^\\\\(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\\[^\\\s"]+$') {
        Write-Result $false "SMB_REMOTE_PATH_INVALID"
        exit 0
    }
    $sourceShare = if ($SourceShareRoot) { $SourceShareRoot } else { $remoteName -replace '(?i)(\\[^\\]+\\[^\\]+).*$', '$1' }
    $shares = @($sourceShare, $DestinationShareRoot) | Where-Object { $_ } | Select-Object -Unique
    if ($shares.Count -gt 1 -and $shares[0].ToLowerInvariant() -eq $shares[1].ToLowerInvariant()) { Write-Result $false "SMB_SHARE_CONFIGURATION_INVALID"; exit 0 }
    $connectedShares = @()
    foreach ($share in $shares) {
        if ($share -notmatch '^\\\\[^\\]+\\[^\\\s]+$') { throw "SMB_SHARE_PATH_INVALID" }
        $resource = New-Object HenriTechWNetNative+NETRESOURCE
        $resource.dwType = 1
        $resource.lpLocalName = $null
        $resource.lpRemoteName = $share
        $resource.lpComment = $null
        $resource.lpProvider = $null
        $code = [HenriTechWNetNative]::WNetAddConnection2W([ref]$resource, [string]$payload.Password, [string]$payload.User, 0)
        if ($code -ne 0) { Write-Result $false (Map-Win32Code $code); Disconnect-OwnedShares $connectedShares; exit 0 }
        $connectedShares += $share
    }
    Write-Result $true
}
catch {
    if ($connectedShares) { Disconnect-OwnedShares $connectedShares }
    Write-Result $false "SMB_HELPER_FAILED"
}
finally {
    if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length); $plainBytes = $null }
    if ($encryptedBytes) { [Array]::Clear($encryptedBytes, 0, $encryptedBytes.Length); $encryptedBytes = $null }
    $payload = $null
}
