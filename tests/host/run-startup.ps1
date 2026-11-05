param(
  [string]$Exe = $(if ($env:DSH_DESKTOP_EXE) { $env:DSH_DESKTOP_EXE } else { 'D:\deepseek-harness\desktop\DeepSeek Harness.exe' })
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath $Exe)) { throw "DSH executable not found: $Exe" }
$preparedFile = Join-Path $root '.harness-startup\prepared.json'
$prepared = Get-Content -LiteralPath $preparedFile -Encoding UTF8 -Raw | ConvertFrom-Json
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $prepared.home
$env:SCHEDULER_STARTUP_PREPARED = $preparedFile
$env:SCHEDULER_STARTUP_HOST_RESOURCES = Join-Path (Split-Path -Parent $Exe) 'resources'
$runId = [guid]::NewGuid().ToString()
$reportDir = Join-Path $root ('.scheduler/startup-host-reports/' + $runId)
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$env:SCHEDULER_STARTUP_RUN_ID = $runId
$env:SCHEDULER_STARTUP_REPORT = Join-Path $reportDir 'report.json'
$scriptPath = Join-Path $PSScriptRoot 'run-startup.mjs'
$process = Start-Process -FilePath $Exe -ArgumentList ('"{0}"' -f $scriptPath) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $reportDir 'stdout.log') -RedirectStandardError (Join-Path $reportDir 'stderr.log')
if ($null -eq $process) { throw "Host process did not start: $reportDir" }
$process.Refresh()
$nativeExit = $process.ExitCode
$nativeExit | Set-Content -LiteralPath (Join-Path $reportDir 'native-exit.txt') -Encoding utf8
if (-not (Test-Path -LiteralPath $env:SCHEDULER_STARTUP_REPORT)) { throw "Startup host did not produce a report: $reportDir" }
$raw = Get-Content -LiteralPath $env:SCHEDULER_STARTUP_REPORT -Encoding UTF8 -Raw
$report = $raw | ConvertFrom-Json
$raw | Write-Output
if ($nativeExit -ne 0 -or $report.runId -ne $runId -or $report.passed -ne $true) { exit 1 }
exit 0
