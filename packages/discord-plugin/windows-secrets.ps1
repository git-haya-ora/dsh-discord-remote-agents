# Host-only DPAPI transport. Input/output are private pipes, never a console.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$failureCode = 'PROTECTED_LOGGING_POLICY'
try {
  # Never handle secrets under transcription or PowerShell module/invocation logging.
  # Inspect both registry views; any configured enabled logging is a hard refusal.
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
  $failureCode = 'PROTECTED_API_UNAVAILABLE'
  Add-Type -AssemblyName System.Security
  $failureCode = 'PROTECTED_STORE_UNSAFE_PATH'
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = 'S-1-5-18'
  $root = [IO.Path]::GetFullPath([string]$request.root)
  if ($root -notmatch '^[A-Za-z]:\\' -or $root.Substring(2).Contains(':') -or $root.StartsWith('\\')) { throw 'path' }
  $root = $root.TrimEnd('\')
  if ($root.Length -le 3 -or $request.ref -isnot [string] -or $request.ref.Length -ne 64 -or $request.ref -cnotmatch '^[a-f0-9]{64}$') { throw 'path' }
  function Assert-NoReparse([string]$path) {
    $cursor = $path
    while ($cursor) {
      if (Test-Path -LiteralPath $cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
      }
      if (Test-Path -LiteralPath $cursor -PathType Container) {
        $ancestorAcl = Get-Acl -LiteralPath $cursor
        foreach ($r in $ancestorAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
          if (($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
          $danger = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
          if ($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($r.FileSystemRights -band $danger) -ne 0 -and $r.IdentityReference.Value -notin @($sid.Value, $system, 'S-1-5-32-544')) { throw 'ancestor-acl' }
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
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne $system)) { throw 'acl' }
    }
    if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })) { throw 'acl' }
  }
  Assert-NoReparse $root
  # Unprivileged third parties must not be able to replace the containing directory.
  $parentAcl = Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($root))
  foreach ($rule in $parentAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $writeMask) -ne 0 -and $rule.IdentityReference.Value -notin @($sid.Value, $system, 'S-1-5-32-544')) { throw 'parent-acl' }
  }
  if (-not (Test-Path -LiteralPath $root)) {
    if ($request.operation -notin @('put', 'journal', 'admission-journal', 'outbox-journal', 'run-outbox-journal')) { throw 'missing' }
    $parent = [IO.Path]::GetDirectoryName($root)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'parent' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid.Value, $system)) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    # .NET Framework creates the directory with the restrictive descriptor.
    [IO.Directory]::CreateDirectory($root, $acl) | Out-Null
  }
  Assert-Private $root
  if ($request.operation -eq 'journal') {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Force)) {
      if ($file.Name -cnotmatch '^secret-(journal|guard)\.sqlite(-journal)?$' -or $file.PSIsContainer) { throw 'journal-file' }
      Assert-Private $file.FullName
    }
    [Console]::Out.Write('{"ok":true}')
    exit 0
  }
  if ($request.operation -eq 'admission-journal') {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Force)) {
      if ($file.Name -cnotmatch '^admission-(journal|guard)\.sqlite(-journal)?$' -or $file.PSIsContainer) { throw 'admission-journal-file' }
      Assert-Private $file.FullName
    }
    [Console]::Out.Write('{"ok":true}')
    exit 0
  }
  if ($request.operation -eq 'outbox-journal') {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Force)) {
      if ($file.Name -cnotmatch '^outbox-(journal|guard)\.sqlite(-journal)?$' -or $file.PSIsContainer) { throw 'outbox-journal-file' }
      Assert-Private $file.FullName
    }
    [Console]::Out.Write('{"ok":true}')
    exit 0
  }
  if ($request.operation -eq 'run-outbox-journal') {
    foreach ($file in @(Get-ChildItem -LiteralPath $root -Force)) {
      if ($file.Name -cnotmatch '^run-outbox-(journal|guard)\.sqlite(-journal)?$' -or $file.PSIsContainer) { throw 'run-outbox-journal-file' }
      Assert-Private $file.FullName
    }
    [Console]::Out.Write('{"ok":true}')
    exit 0
  }
  $path = [IO.Path]::Combine($root, ([string]$request.ref + '.dpapi'))
  if (Test-Path -LiteralPath $path) { Assert-Private $path }
  $entropy = [Text.Encoding]::UTF8.GetBytes('dsh-discord-remote-agents/dpapi/v1')
  $failureCode = 'PROTECTED_STORE_FAILURE'
  switch ($request.operation) {
    'put' {
      $plain = [Convert]::FromBase64String([string]$request.value)
      if ($plain.Length -eq 0 -or $plain.Length -gt 65536) { throw 'size' }
      try {
        $blob = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($blob, 0, $blob.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Assert-Private $path
      } finally { [Array]::Clear($plain, 0, $plain.Length) }
      [Console]::Out.Write('{"ok":true}')
    }
    'read' {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'missing' }
      $info = Get-Item -LiteralPath $path
      if ($info.Length -gt 131072) { throw 'size' }
      $blob = [IO.File]::ReadAllBytes($path)
      $plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      try {
        if ($plain.Length -eq 0 -or $plain.Length -gt 65536) { throw 'size' }
        [Console]::Out.Write((@{ok=$true; value=[Convert]::ToBase64String($plain)} | ConvertTo-Json -Compress))
      } finally { [Array]::Clear($plain, 0, $plain.Length) }
    }
    'delete' {
      if (Test-Path -LiteralPath $path) { [IO.File]::Delete($path) }
      [Console]::Out.Write('{"ok":true}')
    }
    default { throw 'operation' }
  }
} catch {
  # Never forward exception messages, request data, paths, or ciphertext.
  [Console]::Out.Write((@{ok=$false; code=$failureCode} | ConvertTo-Json -Compress))
  exit 1
}
