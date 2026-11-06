<#
  Starts ScaleCart on a local Kubernetes cluster (kind):
    ./k8s/up.ps1            create the cluster if needed, build + load the image, apply, migrate, seed
    ./k8s/up.ps1 -NoSeed    same, without the seed Job
  API: http://localhost:8089 · kubectl --context kind-scalecart -n scalecart get pods
  Delete everything: kind delete cluster --name scalecart
  Needs: Docker Desktop, kind, kubectl. Secrets come from the repo-root .env and are never printed or written to the repo.
#>
param([switch]$NoSeed)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$cluster = 'scalecart'
$ctx = "kind-$cluster"
$kind = (Get-Command kind -ErrorAction SilentlyContinue).Source
if (-not $kind) { $kind = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Kubernetes.kind*\kind.exe" | Select-Object -First 1 -ExpandProperty FullName }
function Kube { & kubectl --context $ctx @args; if ($LASTEXITCODE) { throw "kubectl $args failed" } }

# 1. Cluster
# Through cmd: kind says "No kind clusters found." on stderr, which PowerShell 5.1 would treat as an error.
$existing = cmd /c "`"$kind`" get clusters 2>nul"
if (-not (@($existing) -contains $cluster)) {
  cmd /c "`"$kind`" create cluster --name $cluster --config k8s/kind-config.yaml 2>&1"
}

# 2. Images: the app (built like Compose builds it) and the dependencies, loaded into the cluster's node
cmd /c "docker compose build api 2>&1" | Select-Object -Last 1
$images = 'scalecart/api:dev', 'mysql:8.4.13', 'redis:8.8.2-alpine', 'rabbitmq:4.3.7-management-alpine', 'axllent/mailpit:v1.31.4'
foreach ($img in $images) {
  cmd /c "docker image inspect $img >nul 2>&1 || docker pull $img"
  cmd /c "`"$kind`" load docker-image $img --name $cluster 2>&1" | Select-Object -Last 1
}

# 3. Namespace + Secret from .env (CR stripped; written to a temp file outside the repo, then deleted)
Kube apply -f k8s/00-namespace.yaml | Out-Null
$keys = 'DB_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'RABBITMQ_PASSWORD', 'JWT_SECRET', 'ADMIN_PASSWORD', 'SEED_USER_PASSWORD'
$values = @{}
foreach ($line in [IO.File]::ReadAllLines("$root\.env")) {
  if ($line -match '^\s*([A-Z_]+)=(.*)$' -and $keys -contains $Matches[1]) { $values[$Matches[1]] = $Matches[2].Trim() }
}
$missing = $keys | Where-Object { -not $values[$_] }
if ($missing) { throw "missing in .env: $($missing -join ', ')" }
$tmp = New-TemporaryFile
try {
  [IO.File]::WriteAllLines($tmp, ($keys | ForEach-Object { "$_=$($values[$_])" }))
  & kubectl --context $ctx -n scalecart create secret generic scalecart-secrets --from-env-file=$tmp --dry-run=client -o yaml |
    & kubectl --context $ctx apply -f - | Out-Null
} finally { Remove-Item $tmp -Force }
'secret scalecart-secrets: applied (values not shown)'

# 4. Data services, then the app; migrations before the API can become ready
Kube apply -f k8s/10-data.yaml | Out-Null
Kube -n scalecart rollout status statefulset/mysql --timeout=300s
Kube -n scalecart delete job migrate --ignore-not-found | Out-Null
Kube apply -f k8s/20-app.yaml | Out-Null
Kube -n scalecart wait --for=condition=complete job/migrate --timeout=300s
if (-not $NoSeed) {
  Kube -n scalecart delete job seed --ignore-not-found | Out-Null
  Kube apply -f k8s/seed-job.yaml | Out-Null
  Kube -n scalecart wait --for=condition=complete job/seed --timeout=600s
}
Kube -n scalecart rollout restart deployment/api deployment/worker | Out-Null
Kube -n scalecart rollout status deployment/api --timeout=300s
Kube -n scalecart get pods -o wide
"API: http://localhost:8089/health/ready"
