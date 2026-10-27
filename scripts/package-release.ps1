param(
  [string]$ExtensionId = "lkgggjdngjahbpabmolelmepilppdnlj",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "ExtensionId must be a 32-character Chrome extension ID."
}

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $root "release"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$stageRoot = Join-Path $OutputDirectory ".staging-$PID"
$resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
if (-not $resolvedStage.StartsWith($OutputDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use an unexpected staging directory: $resolvedStage"
}

Push-Location $root
try {
  & npm run validate
  if ($LASTEXITCODE -ne 0) { throw "extension validation failed" }

  & npm test
  if ($LASTEXITCODE -ne 0) { throw "extension tests failed" }

  & (Join-Path $PSScriptRoot "build-bridge.ps1")

  $manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $root "extension\manifest.json") | ConvertFrom-Json
  $version = [string]$manifest.version
  if (-not $version) { throw "Extension version is missing from manifest.json." }

  if (Test-Path -LiteralPath $resolvedStage) {
    Remove-Item -Recurse -Force -LiteralPath $resolvedStage
  }
  $extensionStage = Join-Path $resolvedStage "extension"
  $bridgeStage = Join-Path $resolvedStage "bridge-package"
  New-Item -ItemType Directory -Force -Path $extensionStage, $bridgeStage | Out-Null

  Copy-Item -Recurse -Force -Path (Join-Path $root "extension\*") -Destination $extensionStage
  $forbiddenExtensionFiles = Get-ChildItem -Recurse -File -LiteralPath $extensionStage | Where-Object {
    $_.Extension -in @(".pem", ".pfx", ".key", ".crx")
  }
  if ($forbiddenExtensionFiles) {
    throw "Release extension contains a private key or packaged CRX file."
  }

  New-Item -ItemType Directory -Force -Path (
    Join-Path $bridgeStage "bridge\dist"
  ), (
    Join-Path $bridgeStage "bridge\third_party"
  ), (
    Join-Path $bridgeStage "scripts"
  ), (
    Join-Path $bridgeStage "speech"
  ) | Out-Null
  foreach ($name in @('server.py', 'video_jobs.py', 'requirements.txt', 'setup-runtime.ps1')) {
    Copy-Item -Force -LiteralPath (Join-Path $root "speech\$name") -Destination (Join-Path $bridgeStage "speech\$name")
  }
  Copy-Item -Force -LiteralPath (Join-Path $root "bridge\dist\videolens-bridge.exe") -Destination (
    Join-Path $bridgeStage "bridge\dist\videolens-bridge.exe"
  )
  Copy-Item -Force -LiteralPath (Join-Path $root "bridge\README.md") -Destination (
    Join-Path $bridgeStage "bridge\README.md"
  )
  Copy-Item -Force -LiteralPath (Join-Path $root "bridge\THIRD_PARTY_NOTICES.md") -Destination (
    Join-Path $bridgeStage "bridge\THIRD_PARTY_NOTICES.md"
  )
  Copy-Item -Force -LiteralPath (Join-Path $root "bridge\third_party\CLIProxyAPI-LICENSE.txt") -Destination (
    Join-Path $bridgeStage "bridge\third_party\CLIProxyAPI-LICENSE.txt"
  )
  Copy-Item -Force -LiteralPath (Join-Path $root "scripts\install-bridge.ps1") -Destination (
    Join-Path $bridgeStage "scripts\install-bridge.ps1"
  )
  Copy-Item -Force -LiteralPath (Join-Path $root "scripts\uninstall-bridge.ps1") -Destination (
    Join-Path $bridgeStage "scripts\uninstall-bridge.ps1"
  )

  $installWrapper = @"
`$ErrorActionPreference = "Stop"
`$root = Split-Path -Parent `$MyInvocation.MyCommand.Path
& (Join-Path `$root "scripts\install-bridge.ps1") -SkipBuild -ExtensionId "$ExtensionId"
"@
  Set-Content -Encoding UTF8 -LiteralPath (Join-Path $bridgeStage "install.ps1") -Value $installWrapper

  $uninstallWrapper = @'
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $root "scripts\uninstall-bridge.ps1")
'@
  Set-Content -Encoding UTF8 -LiteralPath (Join-Path $bridgeStage "uninstall.ps1") -Value $uninstallWrapper

  $releaseInfo = @"
VideoLens Bridge $version
Extension ID: $ExtensionId

Install for the current Windows user:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

Uninstall and remove local account credentials:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
"@
  Set-Content -Encoding UTF8 -LiteralPath (Join-Path $bridgeStage "README.txt") -Value $releaseInfo

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $extensionArchive = Join-Path $OutputDirectory "videolens-extension-$version.zip"
  $bridgeArchive = Join-Path $OutputDirectory "videolens-bridge-windows-$version.zip"
  Compress-Archive -Force -Path (Join-Path $extensionStage "*") -DestinationPath $extensionArchive
  Compress-Archive -Force -Path (Join-Path $bridgeStage "*") -DestinationPath $bridgeArchive

  Write-Output "Extension package: $extensionArchive"
  Write-Output "Bridge package: $bridgeArchive"
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $resolvedStage) {
    Remove-Item -Recurse -Force -LiteralPath $resolvedStage
  }
}
