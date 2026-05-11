# Wrapper script to run the Meetup->Facebook sync headless and log output
# Ensure FB_PAGE_ACCESS_TOKEN is set as a user environment variable before scheduling
$ErrorActionPreference = 'Stop'

$syncDir = 'C:\LPNO\fb-sync'
$logDir = Join-Path $syncDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Try to stop Edge so the profile can be reused cleanly
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if (-not $env:FB_PAGE_ACCESS_TOKEN) {
  Write-Error 'FB_PAGE_ACCESS_TOKEN is not set in the environment. Set it for the user or system before running this script.'
  exit 1
}

# Run headless sync and capture stdout/stderr to a timestamped log
$timestamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$logFile = Join-Path $logDir "sync-$timestamp.log"
Push-Location $syncDir

# Ensure HEADLESS is set for the node process
# Run visible (non-headless) to allow interactive debugging during the noon test
$env:HEADLESS = '0'
# Enable destructive deletion of FB events when Meetup event is deleted (set by user request)
$env:DELETE_ON_MEETUP = '1'

# Invoke node and tee output to the log (captures stderr as well)
node sync.js 2>&1 | Tee-Object -FilePath $logFile -Append

Pop-Location
