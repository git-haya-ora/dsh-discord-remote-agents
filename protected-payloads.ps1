# Host-only payload DPAPI transport. Never use the token store namespace.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:failureCode = 'PROTECTED_PAYLOAD_LOGGING_POLICY'
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
  $script:failureCode = 'PROTECTED_PAYLOAD_API_UNAVAILABLE'
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
  $script:failureCode = 'PROTECTED_PAYLOAD_FAILURE'
  # APIs run under FAILURE; only an observed unsafe predicate uses this code.
  # Script scope is essential: a local function assignment would not update catch.
  function Reject-Unsafe {
    $script:failureCode = 'PROTECTED_PAYLOAD_UNSAFE_PATH'
    throw 'unsafe-observed'
  }
  function Reject-Quota {
    $script:failureCode = 'PROTECTED_PAYLOAD_QUOTA'
    throw 'quota-observed'
  }
  function Reject-Mismatch {
    $script:failureCode = 'PROTECTED_PAYLOAD_MISMATCH'
    throw 'payload-mismatch'
  }
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = 'S-1-5-18'
  $rootInput = [string]$request.root
  if ([string]::IsNullOrWhiteSpace($rootInput) -or $rootInput -match '[\x00-\x1f\x7f]') { Reject-Unsafe }
  $root = [IO.Path]::GetFullPath($rootInput)
  if ($root -notmatch '^[A-Za-z]:\\' -or $root.Substring(2).Contains(':') -or $root.StartsWith('\\')) { Reject-Unsafe }
  $root = $root.TrimEnd('\')
  $operation = [string]$request.operation
  if ($root.Length -le 3 -or $operation -notin @('estimate','stats','putBatch','readBatch','deleteBatch')) { Reject-Unsafe }
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
    if ($operation -eq 'stats') { [Console]::Out.Write('{"ok":true,"bytes":0,"files":[]}'); exit 0 }
    if ($operation -notin @('estimate','putBatch')) { Reject-Unsafe }
    if ($operation -eq 'putBatch') {
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
  }
  $rootExists = Test-Path -LiteralPath $root -PathType Container
  if ((Test-Path -LiteralPath $root) -and -not $rootExists) { Reject-Unsafe }
  if (-not $rootExists -and $operation -ne 'estimate') { Reject-Unsafe }
  if ($rootExists) { Assert-Private $root }
  $inventory = New-Object 'System.Collections.Generic.List[object]'
  [long]$inventoryBytes = 0
  if ($rootExists) {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Force)) {
      if ($file.Name -cnotmatch '^payload-[a-f0-9]{64}\.dpapi$' -or $file.PSIsContainer) { Reject-Unsafe }
      Assert-Private $file.FullName
      $check = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try {
        if (-not [PayloadFileIdentity]::IsSingle($check.SafeFileHandle)) { Reject-Unsafe }
        if ($check.Length -eq 0 -or $check.Length -gt 131072) { Reject-Unsafe }
        $bytes = [long]$check.Length
      } finally { $check.Dispose() }
      $inventoryBytes += $bytes
      $inventory.Add(@{ref=$file.Name.Substring(8,64); bytes=$bytes})
      if ($inventory.Count -gt 32768 -or $inventoryBytes -gt 134217728) { Reject-Quota }
    }
  }
  $entropy = [Text.Encoding]::UTF8.GetBytes('dsh-discord-remote-agents/payload/v1')
  if ($operation -eq 'stats') {
    [Console]::Out.Write((@{ok=$true; bytes=$inventoryBytes; files=@($inventory.ToArray())} | ConvertTo-Json -Compress -Depth 4))
    exit 0
  }
  if ($operation -eq 'estimate') {
    $values = @($request.values)
    if ($values.Length -lt 1 -or $values.Length -gt 200) { throw 'request' }
    $sizes = New-Object 'System.Collections.Generic.List[long]'
    foreach ($encoded in $values) {
      if ($encoded -isnot [string] -or $encoded -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'request' }
      $plain = [Convert]::FromBase64String($encoded); $blob = $null
      try {
        if ($plain.Length -eq 0 -or $plain.Length -gt 98304 -or [Convert]::ToBase64String($plain) -cne $encoded) { throw 'size' }
        $blob = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($blob.Length -gt 131072) { Reject-Quota }
        $sizes.Add([long]$blob.Length)
      } finally { [Array]::Clear($plain, 0, $plain.Length); if ($blob) { [Array]::Clear($blob, 0, $blob.Length) } }
    }
    [Console]::Out.Write((@{ok=$true; sizes=@($sizes.ToArray())} | ConvertTo-Json -Compress -Depth 4))
    exit 0
  }
  if ($operation -in @('putBatch','readBatch','deleteBatch')) {
    $items = @($request.items)
    if ($items.Length -lt 1 -or $items.Length -gt 200) { throw 'request' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $results = New-Object 'System.Collections.Generic.List[object]'
    foreach ($entry in $items) {
      $ref = if ($operation -eq 'putBatch') { [string]$entry.ref } else { [string]$entry }
      if ($ref.Length -ne 64 -or $ref -cnotmatch '^[a-f0-9]{64}$' -or -not $seen.Add($ref)) { Reject-Unsafe }
      $itemPath = [IO.Path]::Combine($root, ('payload-' + $ref + '.dpapi'))
      if (Test-Path -LiteralPath $itemPath) { Assert-Private $itemPath }
      if ($operation -eq 'putBatch') {
        $plain = [Convert]::FromBase64String([string]$entry.value); $blob = $null
        try {
          if ($plain.Length -eq 0 -or $plain.Length -gt 98304 -or [Convert]::ToBase64String($plain) -cne [string]$entry.value) { throw 'size' }
          $blob = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
          [long]$maxBytes = $entry.maxBytes
          if ($maxBytes -ne $blob.Length -or $maxBytes -gt 131072) { Reject-Quota }
          if (Test-Path -LiteralPath $itemPath -PathType Leaf) {
            $existingStream = New-Object IO.FileStream($itemPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
              if (-not [PayloadFileIdentity]::IsSingle($existingStream.SafeFileHandle) -or $existingStream.Length -eq 0 -or $existingStream.Length -gt 131072) { Reject-Unsafe }
              if ($existingStream.Length -ne $maxBytes) { Reject-Quota }
              $existingBlob = New-Object byte[] ([int]$existingStream.Length); $offset = 0
              while ($offset -lt $existingBlob.Length) { $n = $existingStream.Read($existingBlob, $offset, $existingBlob.Length - $offset); if ($n -le 0) { throw 'read' }; $offset += $n }
            } finally { $existingStream.Dispose() }
            $existingPlain = [Security.Cryptography.ProtectedData]::Unprotect($existingBlob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            try { if ([Convert]::ToBase64String($existingPlain) -cne [Convert]::ToBase64String($plain)) { Reject-Mismatch } }
            finally { [Array]::Clear($existingPlain, 0, $existingPlain.Length); [Array]::Clear($existingBlob, 0, $existingBlob.Length) }
            $results.Add(@{ref=$ref; bytes=$blob.Length; exists=$true})
          } else {
            if ($inventory.Count -ge 32768 -or $inventoryBytes + $blob.Length -gt 134217728) { Reject-Quota }
            $stream = New-Object IO.FileStream($itemPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
              if (-not [PayloadFileIdentity]::IsSingle($stream.SafeFileHandle)) { Reject-Unsafe }
              Assert-Private $itemPath; $stream.Write($blob, 0, $blob.Length); $stream.Flush($true)
            } finally { $stream.Dispose() }
            Assert-Private $itemPath; $inventoryBytes += $blob.Length
            $inventory.Add(@{ref=$ref; bytes=[long]$blob.Length}); $results.Add(@{ref=$ref; bytes=$blob.Length; exists=$false})
          }
        } finally { [Array]::Clear($plain, 0, $plain.Length); if ($blob) { [Array]::Clear($blob, 0, $blob.Length) } }
      } elseif ($operation -eq 'readBatch') {
        if (-not (Test-Path -LiteralPath $itemPath -PathType Leaf)) { Reject-Unsafe }
        $readStream = New-Object IO.FileStream($itemPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
          if (-not [PayloadFileIdentity]::IsSingle($readStream.SafeFileHandle)) { Reject-Unsafe }
          Assert-Private $itemPath
          if ($readStream.Length -eq 0 -or $readStream.Length -gt 131072) { throw 'size' }
          $readBlob = New-Object byte[] ([int]$readStream.Length); $offset = 0
          while ($offset -lt $readBlob.Length) { $n = $readStream.Read($readBlob, $offset, $readBlob.Length - $offset); if ($n -le 0) { throw 'read' }; $offset += $n }
          $readPlain = [Security.Cryptography.ProtectedData]::Unprotect($readBlob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
          try { if ($readPlain.Length -eq 0 -or $readPlain.Length -gt 98304) { throw 'size' }; $results.Add(@{ref=$ref; value=[Convert]::ToBase64String($readPlain)}) }
          finally { [Array]::Clear($readPlain, 0, $readPlain.Length); [Array]::Clear($readBlob, 0, $readBlob.Length) }
        } finally { $readStream.Dispose() }
      } else {
        if (-not (Test-Path -LiteralPath $itemPath -PathType Leaf)) { $results.Add(@{ref=$ref; deleted=$false; bytes=0}); continue }
        $deleteStream = New-Object IO.FileStream($itemPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { if (-not [PayloadFileIdentity]::IsSingle($deleteStream.SafeFileHandle)) { Reject-Unsafe }; Assert-Private $itemPath; $deleteBytes = [long]$deleteStream.Length }
        finally { $deleteStream.Dispose() }
        [IO.File]::Delete($itemPath); Assert-Private $root
        $results.Add(@{ref=$ref; deleted=$true; bytes=$deleteBytes})
      }
    }
    [Console]::Out.Write((@{ok=$true; results=@($results.ToArray())} | ConvertTo-Json -Compress -Depth 5))
    exit 0
  }
  throw 'request'
} catch {
  # Never forward private data, paths, ciphertext, provider messages or exceptions.
  [Console]::Out.Write((@{ok=$false; code=$script:failureCode} | ConvertTo-Json -Compress))
  exit 1
}
