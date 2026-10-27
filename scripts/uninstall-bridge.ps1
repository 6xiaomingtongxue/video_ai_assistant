param(
  [switch]$KeepAccountData
)

$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "VideoLens\Bridge"
$managedRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $installDir 'text-service\runtime')) + [IO.Path]::DirectorySeparatorChar
$managedServerPath = Join-Path $installDir 'text-service\server.py'
Get-Process -Name 'videolens-bridge' -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath((Join-Path $installDir 'videolens-bridge.exe'))
} | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and $_.CommandLine -and
  [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($managedRuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -and
  $_.CommandLine.IndexOf($managedServerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$registryPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videolens.bridge",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videolens.bridge"
)
foreach ($registryPath in $registryPaths) {
  if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -Recurse -Force -LiteralPath $registryPath
  }
}

$manifestDir = Join-Path $env:LOCALAPPDATA "VideoLens\NativeMessaging"
$manifestPath = Join-Path $manifestDir "com.videolens.bridge.json"
if (Test-Path -LiteralPath $manifestPath) {
  Remove-Item -Force -LiteralPath $manifestPath
}

if (-not $KeepAccountData) {
  $resolvedBase = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "VideoLens"))
  $resolvedTarget = [System.IO.Path]::GetFullPath($installDir)
  if (-not $resolvedTarget.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove an unexpected install directory: $resolvedTarget"
  }
  if (Test-Path -LiteralPath $resolvedTarget) {
    Remove-Item -Recurse -Force -LiteralPath $resolvedTarget
  }
}

Write-Output "VideoLens Bridge uninstalled."
