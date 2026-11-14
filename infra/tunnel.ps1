# Opens the public HTTPS tunnel Razorpay webhooks use: https://<NGROK_DOMAIN> -> NGINX on localhost:8088.
# The domain is fixed (ngrok free static domain), so the dashboard webhook URL never needs changing.
# Usage: ./infra/tunnel.ps1        (Ctrl+C to stop; inspect requests at http://localhost:4040)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

$line = Select-String -Path (Join-Path $root '.env') -Pattern '^NGROK_DOMAIN=(.+)$' | Select-Object -First 1
if (-not $line) { throw 'Set NGROK_DOMAIN in .env (dashboard.ngrok.com -> Domains)' }
$domain = $line.Matches[0].Groups[1].Value.Trim()

$ngrok = (Get-Command ngrok -ErrorAction SilentlyContinue).Source
if (-not $ngrok) {
  $ngrok = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ngrok.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ngrok) { throw 'ngrok not found (winget install Ngrok.Ngrok)' }

Write-Host "Tunnel: https://$domain -> http://localhost:8088"
Write-Host "Razorpay webhook URL: https://$domain/payments/razorpay/webhook"
& $ngrok http 8088 --domain $domain
