param(
  [string]$OutputPath = "",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bridgeRoot = Join-Path $root "bridge"
$goCache = Join-Path $root ".tmp\go-build"

$goCandidates = @(
  $env:VIDEOLENS_GO,
  (Join-Path $env:TEMP "videolens-go-1.26.0\go\bin\go.exe"),
  (Get-Command go -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$go = $goCandidates | Select-Object -First 1
if (-not $go) {
  throw "Go 1.26 or newer was not found. Set VIDEOLENS_GO to go.exe."
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $bridgeRoot "dist\videolens-bridge.exe"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDir, $goCache | Out-Null

$previousGoCache = $env:GOCACHE
$env:GOCACHE = $goCache
Push-Location $bridgeRoot
try {
  & $go mod download
  if ($LASTEXITCODE -ne 0) { throw "go mod download failed" }

  & $go mod tidy
  if ($LASTEXITCODE -ne 0) { throw "go mod tidy failed" }

  if (-not $SkipTests) {
    & $go test ./...
    if ($LASTEXITCODE -ne 0) { throw "bridge tests failed" }
  }

  & $go build -trimpath -ldflags "-s -w" -o $OutputPath .
  if ($LASTEXITCODE -ne 0) { throw "bridge build failed" }
} finally {
  Pop-Location
  if ($null -eq $previousGoCache) {
    Remove-Item Env:GOCACHE -ErrorAction SilentlyContinue
  } else {
    $env:GOCACHE = $previousGoCache
  }
}

Write-Output "VideoLens Bridge built: $OutputPath"
