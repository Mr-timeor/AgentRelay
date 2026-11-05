param([string]$Exe = $(if ($env:DSH_DESKTOP_EXE) { $env:DSH_DESKTOP_EXE } else { 'D:\deepseek-harness\desktop\DeepSeek Harness.exe' }))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Exe)) { throw "找不到DSH桌面可执行文件：$Exe" }
$env:ELECTRON_RUN_AS_NODE = '1'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runId = [guid]::NewGuid().ToString()
$resultPrefix = Join-Path $projectRoot ('.scheduler/view-host-report-' + $runId)
New-Item -ItemType Directory -Path (Split-Path -Parent $resultPrefix) -Force | Out-Null
$reportPath = $resultPrefix + '.json'
$env:SCHEDULER_VIEW_RUN_ID = $runId
$env:SCHEDULER_VIEW_REPORT = $reportPath
$scriptPath = Join-Path $PSScriptRoot 'view-host.mjs'
$process = Start-Process -FilePath $Exe -ArgumentList ('"{0}"' -f $scriptPath) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput ($resultPrefix + '-stdout.log') -RedirectStandardError ($resultPrefix + '-stderr.log')
if ($null -eq $process) { throw "View host process did not start: $resultPrefix" }
$process.Refresh()
$nativeExit = $process.ExitCode
$nativeExit | Set-Content -LiteralPath ($resultPrefix + '-native-exit.txt') -Encoding utf8
if (-not (Test-Path -LiteralPath $reportPath)) { throw "View host did not produce a report: $reportPath" }
$raw = Get-Content -LiteralPath $reportPath -Raw
$result = $raw | ConvertFrom-Json
$raw | Write-Output
if ($nativeExit -ne 0 -or $result.runId -ne $runId -or $result.passed -ne $true) { exit 1 }
exit 0
