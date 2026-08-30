[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CanvasPath = "/zh/editor?createNew=1"
$CanvasUrl = "http://localhost:3000$CanvasPath"
$ApiHealthUrl = "http://127.0.0.1:8000/api/v1/health"
$RootPackageLock = Join-Path $RepoRoot "package-lock.json"
$InstalledPackageLock = Join-Path $RepoRoot "node_modules\.package-lock.json"

function Test-CanvasReady {
  try {
    $response = Invoke-WebRequest -Uri $CanvasUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

function Test-ApiReady {
  try {
    $response = Invoke-WebRequest -Uri $ApiHealthUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

function Start-LocalApiIfConfigured {
  if (Test-ApiReady) {
    Write-Host "Local API is already running on port 8000." -ForegroundColor Green
    return
  }

  $ApiPython = Join-Path $RepoRoot "apps\api\.venv\Scripts\python.exe"
  $ApiEnv = Join-Path $RepoRoot "apps\api\.env"
  if (-not (Test-Path -LiteralPath $ApiPython) -or -not (Test-Path -LiteralPath $ApiEnv)) {
    Write-Host "AI API not started: apps/api/.venv and apps/api/.env are not configured yet." -ForegroundColor Yellow
    Write-Host "The canvas can still open; upstream model discovery and generation need the local API runtime." -ForegroundColor DarkYellow
    return
  }

  $hasDatabase = Select-String -LiteralPath $ApiEnv -Pattern '^\s*DATABASE_URL\s*=\s*\S+' -Quiet
  if (-not $hasDatabase) {
    Write-Host "AI API not started: DATABASE_URL is missing from apps/api/.env." -ForegroundColor Yellow
    return
  }

  $RuntimeDir = Join-Path $RepoRoot ".runtime"
  New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
  $ApiLog = Join-Path $RuntimeDir "local-api.log"
  $ApiErrorLog = Join-Path $RuntimeDir "local-api-error.log"
  $env:LOCAL_CANVAS_MODE = "true"
  Start-Process -FilePath $ApiPython `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000') `
    -WorkingDirectory (Join-Path $RepoRoot 'apps\api') `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ApiLog `
    -RedirectStandardError $ApiErrorLog

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if (Test-ApiReady) {
      Write-Host "Local AI API started on port 8000." -ForegroundColor Green
      return
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "AI API is still starting. Check .runtime/local-api-error.log if model calls fail." -ForegroundColor Yellow
}

function Get-RequiredCommand {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Required command '$Name' was not found. Install Node.js 20 or newer and try again."
  }
  return $command.Source
}

Set-Location $RepoRoot

# The bypass is consumed only by explicit development-mode code paths.
$env:LOCAL_CANVAS_MODE = "true"
$env:VITE_LOCAL_CANVAS_MODE = "true"
$env:VITE_COLLAB_ENABLED = "false"
$env:VITE_DEV_OPEN_PATH = $CanvasPath

Start-LocalApiIfConfigured

if (Test-CanvasReady) {
  Write-Host "Canvas is already running. Opening $CanvasUrl" -ForegroundColor Green
  Start-Process $CanvasUrl
  exit 0
}

$Node = Get-RequiredCommand "node.exe"
$Npm = Get-RequiredCommand "npm.cmd"
$NodeVersion = (& $Node --version).Trim()
$NodeMajor = [int](($NodeVersion -replace '^v', '') -split '\.')[0]

if ($NodeMajor -lt 20) {
  throw "Node.js 20 or newer is required. Current version: $NodeVersion"
}

Write-Host "Zuoge canvas local launcher" -ForegroundColor Cyan
Write-Host "Project : $RepoRoot"
Write-Host "Node.js: $NodeVersion"
Write-Host "URL     : $CanvasUrl"
Write-Host ""

$NeedsInstall = -not (Test-Path $InstalledPackageLock)
if (-not $NeedsInstall -and (Test-Path $RootPackageLock)) {
  $sourceLockTime = (Get-Item $RootPackageLock).LastWriteTimeUtc
  $installedLockTime = (Get-Item $InstalledPackageLock).LastWriteTimeUtc
  $NeedsInstall = $sourceLockTime -gt $installedLockTime
}

if ($NeedsInstall) {
  Write-Host "Installing or updating frontend dependencies..." -ForegroundColor Yellow
  & $Npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
  }
  Write-Host "Dependencies are ready." -ForegroundColor Green
  Write-Host ""
}

Write-Host "Starting the canvas. The browser will open automatically." -ForegroundColor Green
Write-Host "Keep this window open. Press Ctrl+C here to stop the canvas." -ForegroundColor DarkGray
Write-Host ""

& $Npm run dev:web
if ($LASTEXITCODE -ne 0) {
  throw "Canvas dev server exited with code $LASTEXITCODE."
}
