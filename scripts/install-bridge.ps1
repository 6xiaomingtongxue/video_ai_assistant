param(
  [string]$ExtensionId = "lkgggjdngjahbpabmolelmepilppdnlj",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "ExtensionId must be a 32-character Chrome extension ID."
}

$root = Split-Path -Parent $PSScriptRoot
$sourceExe = Join-Path $root "bridge\dist\videolens-bridge.exe"
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot "build-bridge.ps1") -OutputPath $sourceExe
}
if (-not (Test-Path -LiteralPath $sourceExe)) {
  throw "Bridge executable not found: $sourceExe"
}
$textFiles = @('server.py', 'video_jobs.py', 'requirements.txt', 'setup-runtime.ps1')
foreach ($name in $textFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $root "speech\$name"))) { throw "Video text component is missing: $name" }
}

$installDir = Join-Path $env:LOCALAPPDATA "VideoLens\Bridge"
$manifestDir = Join-Path $env:LOCALAPPDATA "VideoLens\NativeMessaging"
$targetExe = Join-Path $installDir "videolens-bridge.exe"
$manifestPath = Join-Path $manifestDir "com.videolens.bridge.json"

New-Item -ItemType Directory -Force -Path $installDir, $manifestDir | Out-Null
$textDir = Join-Path $installDir 'text-service'
New-Item -ItemType Directory -Force -Path $textDir | Out-Null
# Update only VideoLens's own host. Account credentials and completed text remain.
Get-Process -Name 'videolens-bridge' -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($targetExe)
} | Stop-Process -Force
$managedRuntimeRoot = [IO.Path]::GetFullPath((Join-Path $textDir 'runtime')) + [IO.Path]::DirectorySeparatorChar
$managedServerPath = Join-Path $textDir 'server.py'
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and $_.CommandLine -and
  [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($managedRuntimeRoot, [StringComparison]::OrdinalIgnoreCase) -and
  $_.CommandLine.IndexOf($managedServerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Copy-Item -Force -LiteralPath $sourceExe -Destination $targetExe
foreach ($name in $textFiles) { Copy-Item -Force -LiteralPath (Join-Path $root "speech\$name") -Destination (Join-Path $textDir $name) }

$manifest = [ordered]@{
  name = "com.videolens.bridge"
  description = "VideoLens automatic video text and account bridge"
  path = $targetExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $manifestPath

$registryPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.videolens.bridge",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.videolens.bridge"
)
foreach ($registryPath in $registryPaths) {
  New-Item -Force -Path $registryPath | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
}

Write-Output "VideoLens Bridge installed for extension $ExtensionId."
Write-Output "Reload the extension. Video text processing will be set up and started automatically when needed."
