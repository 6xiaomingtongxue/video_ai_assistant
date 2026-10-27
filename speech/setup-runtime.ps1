param([Parameter(Mandatory = $true)][string]$RuntimeDirectory)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Native hosts can inherit PowerShell 7's module path. Use this engine's modules.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeDirectory)
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$lockStream = $null
$deadline = (Get-Date).AddMinutes(20)
while (-not $lockStream) {
  try { $lockStream = [IO.File]::Open((Join-Path $runtimeRoot 'setup.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch [IO.IOException] {
    if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for VideoLens runtime setup.' }
    Start-Sleep -Seconds 1
  }
}

function Get-VerifiedDownload([string]$Url, [string]$Path, [string]$Hash) {
  if (Test-Path -LiteralPath $Path) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Hash) { return }
  }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -TimeoutSec 180
      if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Hash) { throw 'Downloaded file checksum mismatch.' }
      return
    } catch { if ($attempt -eq 3) { throw }; Start-Sleep -Seconds 2 }
  }
}

function Get-ReleaseText([string]$Url) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 60
  if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content).Trim() }
  return ([string]$response.Content).Trim()
}

try {
  $requirementsPath = Join-Path $PSScriptRoot 'requirements.txt'
  $requirementsHash = (Get-FileHash -LiteralPath $requirementsPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $readyPath = Join-Path $runtimeRoot 'ready.json'
  $pythonPath = Join-Path $runtimeRoot 'venv\Scripts\python.exe'
  $nodePath = Join-Path $runtimeRoot 'node\node.exe'
  if ((Test-Path -LiteralPath $readyPath) -and (Test-Path -LiteralPath $pythonPath) -and (Test-Path -LiteralPath $nodePath)) {
    try { $ready = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json } catch { $ready = $null }
    if ($ready.schema -eq 1 -and $ready.requirementsHash -eq $requirementsHash) { return }
  }

  $toolsRoot = Join-Path $runtimeRoot 'tools'
  Write-Output 'Preparing the isolated VideoLens runtime...'
  New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
  $uvVersion = '0.8.22'
  $uvArchiveName = 'uv-x86_64-pc-windows-msvc.zip'
  $uvBase = "https://github.com/astral-sh/uv/releases/download/$uvVersion"
  $uvChecksum = Get-ReleaseText "$uvBase/$uvArchiveName.sha256"
  if ($uvChecksum -notmatch '^([a-fA-F0-9]{64})(?:\s|$)') { throw 'Invalid uv release checksum.' }
  $uvHash = $Matches[1]
  $uvZip = Join-Path $toolsRoot 'uv.zip'
  Get-VerifiedDownload "$uvBase/$uvArchiveName" $uvZip $uvHash
  Expand-Archive -LiteralPath $uvZip -DestinationPath $toolsRoot -Force
  $uv = Join-Path $toolsRoot 'uv.exe'
  if (-not (Test-Path -LiteralPath $uv)) { throw 'uv release is missing uv.exe.' }

  # All Python packages and runtimes stay inside VideoLens; no global install or PATH edits.
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot 'python'
  $env:UV_CACHE_DIR = Join-Path $runtimeRoot 'cache'
  if (-not (Test-Path -LiteralPath $pythonPath)) {
    & $uv venv --managed-python --python 3.12 (Join-Path $runtimeRoot 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare the VideoLens Python runtime.' }
  }
  Write-Output 'Preparing video processing dependencies...'
  & $uv pip install --python $pythonPath --only-binary :all: --requirements $requirementsPath
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install VideoLens video processing dependencies.' }
  # Importing alone misses incompatible decoder APIs (for example PyAV 19).
  $decodeCheck = @'
import io, wave, yt_dlp
from faster_whisper.audio import decode_audio
audio = io.BytesIO()
with wave.open(audio, 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(16000)
    output.writeframes(bytes(3200))
audio.seek(0)
assert decode_audio(audio).size == 1600
'@
  & $pythonPath -c $decodeCheck
  if ($LASTEXITCODE -ne 0) { throw 'VideoLens audio decoding validation failed.' }

  Write-Output 'Preparing the VideoLens JavaScript runtime...'
  $nodeBase = 'https://nodejs.org/download/release/latest-v22.x'
  $nodeChecksums = Get-ReleaseText "$nodeBase/SHASUMS256.txt"
  if ($nodeChecksums -notmatch '(?m)^([a-fA-F0-9]{64})\s+(node-v22\.\d+\.\d+-win-x64\.zip)\s*$') { throw 'No supported Node.js release checksum found.' }
  $nodeHash = $Matches[1]
  $nodeArchive = $Matches[2]
  $nodeZip = Join-Path $toolsRoot 'node.zip'
  Get-VerifiedDownload "$nodeBase/$nodeArchive" $nodeZip $nodeHash
  $nodeRoot = Join-Path $runtimeRoot 'node'
  New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $nodePackage = [IO.Compression.ZipFile]::OpenRead($nodeZip)
  try {
    $nodePrefix = $nodeArchive -replace '\.zip$', ''
    foreach ($name in @('node.exe', 'LICENSE')) {
      $entry = $nodePackage.GetEntry("$nodePrefix/$name")
      if (-not $entry) { throw "Node.js release is missing $name." }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $nodeRoot $name), $true)
    }
  } finally { $nodePackage.Dispose() }
  & $nodePath --version
  if ($LASTEXITCODE -ne 0) { throw 'VideoLens JavaScript runtime did not start.' }
  @{ schema = 1; requirementsHash = $requirementsHash } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $readyPath
  Write-Output 'VideoLens video processing runtime is ready.'
} finally { $lockStream.Dispose() }
