<#
.SYNOPSIS
  Runs a k6 experiment and checks that the load generator itself was not the bottleneck.

.EXAMPLE
  ./load-tests/run.ps1 -Script e0-calibration.js
  ./load-tests/run.ps1 -Script e0-event-loop.js -K6Env PART=cpu,CPU_MS=5

  Raw output lands in load-tests/results/<name>-<timestamp>.*; a per-step table is printed at the end.
#>
param(
  [Parameter(Mandatory)][string]$Script,
  [string]$Name = [IO.Path]::GetFileNameWithoutExtension($Script),
  [string[]]$K6Env = @(),
  [int]$Hold = 20,
  [string]$BaseUrl = 'http://localhost:8088'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$results = Join-Path $here 'results'
New-Item -ItemType Directory -Force $results | Out-Null

# Find k6 even if this terminal was opened before k6 was installed (stale PATH).
$k6Exe = (Get-Command k6 -ErrorAction SilentlyContinue).Source
if (-not $k6Exe) {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $k6Exe = (Get-Command k6 -ErrorAction SilentlyContinue).Source
}
if (-not $k6Exe -and (Test-Path 'C:\Program Files\k6\k6.exe')) { $k6Exe = 'C:\Program Files\k6\k6.exe' }
if (-not $k6Exe) { throw 'k6 not found. Install it with: winget install GrafanaLabs.k6' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runId = "$Name-$stamp"
$summary = Join-Path $results "$runId.summary.json"
$log = Join-Path $results "$runId.log"
$loadgen = Join-Path $results "$runId.loadgen.json"

# Passwords the scripts log in with come from the repo's .env (never committed).
# k6 sees the process environment, so loading them here is enough.
$dotEnv = Join-Path (Split-Path $here -Parent) '.env'
if (Test-Path $dotEnv) {
  foreach ($line in Get-Content $dotEnv) {
    if ($line -match '^\s*(ADMIN_PASSWORD|SEED_USER_PASSWORD)\s*=\s*(.*?)\s*$') {
      Set-Item "Env:$($Matches[1])" $Matches[2]
    }
  }
}

$env:K6_PROMETHEUS_RW_SERVER_URL = 'http://localhost:9090/api/v1/write'
$env:K6_PROMETHEUS_RW_TREND_STATS = 'p(50),p(95),p(99),max'

$k6Args = @(
  'run', '--quiet',
  '--summary-export', "`"$summary`"",
  '--summary-trend-stats', '"avg,med,p(95),p(99),max"',
  '-o', 'experimental-prometheus-rw',
  '--tag', "testid=$runId",
  '-e', "HOLD=$Hold",
  '-e', "BASE_URL=$BaseUrl"
)
foreach ($kv in $K6Env) { $k6Args += @('-e', $kv) }
$k6Args += "`"$(Join-Path $here $Script)`""

Write-Host "run: $runId"
$k6 = Start-Process -FilePath $k6Exe -ArgumentList $k6Args -NoNewWindow -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err"

# Sample once per second: k6's own CPU and total host CPU.
# (Server-side CPU comes from Prometheus below; Windows hides the Docker VM process from normal users.)
$cores = [Environment]::ProcessorCount
$samples = @()
$lastK6 = 0.0; $lastAt = Get-Date
$startedAt = Get-Date
while (-not $k6.HasExited) {
  $total = $null
  try {
    $total = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue
  } catch { Start-Sleep -Seconds 1 }
  $now = Get-Date
  $elapsed = ($now - $lastAt).TotalSeconds
  $k6.Refresh()
  $k6Cpu = if ($k6.HasExited) { $lastK6 } else { $k6.TotalProcessorTime.TotalSeconds }
  if ($elapsed -gt 0 -and $lastK6 -gt 0) {
    $samples += [pscustomobject]@{
      k6Cores    = [math]::Round(($k6Cpu - $lastK6) / $elapsed, 2)
      hostCpuPct = if ($null -ne $total) { [math]::Round($total, 1) } else { $null }
    }
  }
  $lastK6 = $k6Cpu; $lastAt = $now
}
$k6.WaitForExit()
$durationSec = [int][math]::Ceiling(((Get-Date) - $startedAt).TotalSeconds)

# Server side, over the whole run: peak CPU (cores) and peak event-loop utilization across API instances.
function Invoke-PromMax([string]$expr, [int]$window = $durationSec) {
  $q = [uri]::EscapeDataString("max_over_time(($expr)[${window}s:5s])")
  try {
    $r = Invoke-RestMethod "http://localhost:9090/api/v1/query?query=$q"
    if ($r.data.result.Count -gt 0) { return [math]::Round([double]$r.data.result[0].value[1], 2) }
  } catch {}
  return $null
}
$apiCpuMax = Invoke-PromMax 'max(rate(process_cpu_seconds_total{job="api"}[10s]))'
$apiEluMax = Invoke-PromMax 'max(nodejs_eventloop_utilization_ratio)'
# Successful requests per second by all API instances together (best 20 s window). The first
# 13 s are skipped: a 20 s rate window there still contains the previous run's traffic.
$apiPeakRps = Invoke-PromMax 'sum(rate(http_server_request_duration_seconds_count{job="api",status_code=~"2.."}[20s]))' ([math]::Max(5, $durationSec - 13))

$stats = {
  param($values)
  $v = @($values | Where-Object { $null -ne $_ })
  if ($v.Count -eq 0) { return $null }
  $m = $v | Measure-Object -Average -Maximum
  [pscustomobject]@{ avg = [math]::Round($m.Average, 2); max = [math]::Round($m.Maximum, 2) }
}
$gitSha = cmd /c "git -C `"$here`" rev-parse --short HEAD 2>nul"
if (-not $gitSha) { $gitSha = 'uncommitted' }
$dirty = cmd /c "git -C `"$here`" status --porcelain 2>nul"
if ($dirty) { $gitSha = "$gitSha+dirty" }
$meta = [pscustomobject]@{
  runId        = $runId
  script       = $Script
  k6Env        = $K6Env
  holdSeconds  = $Hold
  gitSha       = $gitSha
  hostLogicalCores = $cores
  apiCpus      = $(if ($env:API_CPUS) { $env:API_CPUS } else { '1.0 (default)' })
  httpAdapter  = $(if ($env:HTTP_ADAPTER) { $env:HTTP_ADAPTER } else { 'fastify (default)' })
  stockReservation = $(if ($env:STOCK_RESERVATION) { $env:STOCK_RESERVATION } else { 'atomic (default)' })
  apiReplicas  = $(if ($env:API_REPLICAS) { $env:API_REPLICAS } else { '1 (default)' })
  cacheEnabled = $(if ($env:CACHE_ENABLED) { $env:CACHE_ENABLED } else { 'true (default)' })
  listenBacklog = $(if ($env:HTTP_LISTEN_BACKLOG) { $env:HTTP_LISTEN_BACKLOG } else { '4096 (default)' })
  apiPeakRps   = $apiPeakRps
  durationSec  = $durationSec
  k6Cores      = & $stats ($samples.k6Cores)
  hostCpuPct   = & $stats ($samples.hostCpuPct)
  apiCpuCoresMax = $apiCpuMax
  apiEventLoopUtilizationMax = $apiEluMax
}
$meta | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $loadgen

Write-Host ''
Write-Host "Load generator check (host has $cores logical cores):"
Write-Host ("  k6 CPU        avg {0} / max {1} cores" -f $meta.k6Cores.avg, $meta.k6Cores.max)
Write-Host ("  Host CPU      avg {0}% / max {1}%" -f $meta.hostCpuPct.avg, $meta.hostCpuPct.max)
Write-Host "Server side (peak during run, from Prometheus):"
Write-Host ("  API CPU       max {0} cores   |   event-loop utilization max {1}" -f $apiCpuMax, $apiEluMax)
Write-Host ("  API throughput peak {0} req/s (all instances, best 20 s window)" -f $apiPeakRps)
if ($meta.hostCpuPct.max -gt 85) {
  Write-Warning 'Host CPU exceeded 85%: k6 and the app competed for CPU. Treat the highest steps as suspect.'
}
Write-Host ''
node (Join-Path $here 'report.mjs') $summary $Hold
if ((Get-Item "$log.err").Length -gt 0) { Write-Host "k6 stderr: $log.err" }
