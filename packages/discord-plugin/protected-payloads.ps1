# Host-only payload DPAPI transport. Never use the token store namespace.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$failureCode = 'PROTECTED_PAYLOAD_LOGGING_POLICY'
try {
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      try {
        foreach ($name in @('Transcription', 'ModuleLogging', 'ScriptBlockLogging')) {
          $key = $base.OpenSubKey(('Software\Policies\Microsoft\Windows\PowerShell\' + $name))
          if ($key) {
            try { foreach ($valueName in $key.GetValueNames()) { if ($valueName.StartsWith('Enable') -and [string]$key.GetValue($valueName) -ne '0') { throw 'logging-policy' } } }
            finally { $key.Dispose() }
          }
        }
      } finally { $base.Dispose() }
    }
  }
  $failureCode = 'PROTECTED_PAYLOAD_API_UNAVAILABLE'
  Add-Type -AssemblyName System.Security
  # Validate file link count on the actual opened handle, using documented Win32.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PayloadFileIdentity {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attributes,c1,c2,a1,a2,w1,w2,volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  public static bool IsSingle(SafeFileHandle h) {
    Info i; if (!GetFileInformationByHandle(h,out i)) throw new Exception("file-api");
    return i.links == 1 && (i.attributes & 0x410) == 0;
  }
}
'@
  $failureCode = 'PROTECTED_PAYLOAD_FAILURE'
  # APIs run under FAILURE; only an observed unsafe predicate uses this code.
  # Script scope is essential: a local function assignment would not update catch.
  function Reject-Unsafe {
    $script:failureCode = 'PROTECTED_PAYLOAD_UNSAFE_PATH'
    throw 'unsafe-observed'
  }
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = 'S-1-5-18'
  $root = [IO.Path]::GetFullPath([string]$request.root)
  if ($root -notmatch '^[A-Za-z]:\\' -or $root.Substring(2).Contains(':') -or $root.StartsWith('\\')) { Reject-Unsafe }
  $root = $root.TrimEnd('\')
  if ($root.Length -le 3 -or $request.ref -isnot [string] -or $request.ref.Length -ne 64 -or $request.ref -cnotmatch '^[a-f0-9]{64}$' -or $request.operation -notin @('put','read')) { Reject-Unsafe }
  function Assert-NoReparse([string]$path) {
    $cursor = $path
    while ($cursor) {
      if (Test-Path -LiteralPath $cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Reject-Unsafe }
      }
      if (Test-Path -LiteralPath $cursor -PathType Container) {
        $ancestorAcl = Get-Acl -LiteralPath $cursor
        foreach ($r in $ancestorAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
          if (($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
          $danger = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
          if ($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($r.FileSystemRights -band $danger) -ne 0 -and $r.IdentityReference.Value -notin @($sid.Value, $system, 'S-1-5-32-544')) { Reject-Unsafe }
        }
      }
      $parent = [IO.Path]::GetDirectoryName($cursor)
      if ($parent -eq $cursor) { break }
      $cursor = $parent
    }
  }
  function Assert-Private([string]$path) {
    Assert-NoReparse $path
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { Reject-Unsafe }
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne $system)) { Reject-Unsafe }
    }
    if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })) { Reject-Unsafe }
  }
  Assert-NoReparse $root
  $rootParent = [IO.Path]::GetDirectoryName($root)
  if (-not (Test-Path -LiteralPath $rootParent -PathType Container)) { Reject-Unsafe }
  $parentAcl = Get-Acl -LiteralPath $rootParent
  foreach ($rule in $parentAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $writeMask) -ne 0 -and $rule.IdentityReference.Value -notin @($sid.Value, $system, 'S-1-5-32-544')) { Reject-Unsafe }
  }
  if (-not (Test-Path -LiteralPath $root)) {
    if ($request.operation -ne 'put') { Reject-Unsafe }
    $parent = [IO.Path]::GetDirectoryName($root)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { Reject-Unsafe }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid.Value, $system)) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [IO.Directory]::CreateDirectory($root, $acl) | Out-Null
  }
  Assert-Private $root
  foreach ($file in @(Get-ChildItem -LiteralPath $root -Force)) {
    if ($file.Name -cnotmatch '^payload-[a-f0-9]{64}\.dpapi$' -or $file.PSIsContainer) { Reject-Unsafe }
    Assert-Private $file.FullName
    $check = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      if (-not [PayloadFileIdentity]::IsSingle($check.SafeFileHandle)) { Reject-Unsafe }
    } finally { $check.Dispose() }
  }
  $path = [IO.Path]::Combine($root, ('payload-' + [string]$request.ref + '.dpapi'))
  if (Test-Path -LiteralPath $path) { Assert-Private $path }
  $entropy = [Text.Encoding]::UTF8.GetBytes('dsh-discord-remote-agents/payload/v1')
  if ($request.operation -eq 'put') {
    $plain = [Convert]::FromBase64String([string]$request.value)
    try {
      if ($plain.Length -eq 0 -or $plain.Length -gt 98304) { throw 'size' }
      $blob = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        if (-not [PayloadFileIdentity]::IsSingle($stream.SafeFileHandle)) { Reject-Unsafe }
        Assert-Private $path
        $stream.Write($blob, 0, $blob.Length)
        $stream.Flush($true)
      } finally { $stream.Dispose() }
      Assert-Private $path
      [Console]::Out.Write('{"ok":true}')
    } finally { [Array]::Clear($plain, 0, $plain.Length) }
  } else {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Reject-Unsafe }
    $stream = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      if (-not [PayloadFileIdentity]::IsSingle($stream.SafeFileHandle)) { Reject-Unsafe }
      Assert-Private $path
      if ($stream.Length -eq 0 -or $stream.Length -gt 131072) { throw 'size' }
      $blob = New-Object byte[] ([int]$stream.Length)
      $offset = 0
      while ($offset -lt $blob.Length) {
        $n = $stream.Read($blob, $offset, $blob.Length - $offset)
        if ($n -le 0) { throw 'read' }
        $offset += $n
      }
      $plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      try {
        if ($plain.Length -eq 0 -or $plain.Length -gt 98304) { throw 'size' }
        [Console]::Out.Write((@{ok=$true; value=[Convert]::ToBase64String($plain)} | ConvertTo-Json -Compress))
      } finally { [Array]::Clear($plain, 0, $plain.Length) }
    } finally { $stream.Dispose() }
  }
} catch {
  # Never forward private data, paths, ciphertext, provider messages or exceptions.
  [Console]::Out.Write((@{ok=$false; code=$failureCode} | ConvertTo-Json -Compress))
  exit 1
}
