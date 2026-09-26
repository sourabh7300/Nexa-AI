param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$baseUrl = 'http://127.0.0.1:3000'

function Test-NexaReady {
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/healthz" -TimeoutSec 2
    $page = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec 2
    return $health.StatusCode -eq 200 -and $health.Content -eq 'ok' -and $page.Content.Contains('<title>Nexa AI')
  } catch {
    return $false
  }
}

if (-not (Test-NexaReady)) {
  Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/k', 'npm.cmd start') -WorkingDirectory $root
}

$deadline = (Get-Date).AddSeconds(30)
do {
  if (Test-NexaReady) {
    if (-not $NoBrowser) { Start-Process 'http://localhost:3000/' }
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

Write-Error 'Nexa did not start. Check that Node.js is installed and the server window has no error.'
exit 1
