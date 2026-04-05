param(
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $scriptRoot $EnvFile
$envMap = @{}

if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")
    if ($separatorIndex -lt 0) {
      continue
    }

    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1).Trim()
    $envMap[$key] = $value
  }
}

$hostIp = if ($envMap.HOST_BIND_IP -and $envMap.HOST_BIND_IP -ne "0.0.0.0") { $envMap.HOST_BIND_IP } else { "127.0.0.1" }
$appPort = if ($envMap.APP_HOST_PORT) { $envMap.APP_HOST_PORT } else { "11301" }
$domain = if ($envMap.LOCAL_DOMAIN) { $envMap.LOCAL_DOMAIN } else { "jobviz.home.arpa" }
$domainPort = if ($envMap.DOMAIN_HTTP_PORT) { $envMap.DOMAIN_HTTP_PORT } else { "80" }

$directUrl = "http://${hostIp}:$appPort/api/dashboard"
$domainUrl = if ($domainPort -eq "80") { "http://$hostIp/" } else { "http://${hostIp}:$domainPort/" }

Write-Output "Direct check: $directUrl"
try {
  $directStatus = (Invoke-WebRequest -Uri $directUrl -UseBasicParsing -TimeoutSec 10).StatusCode
  Write-Output "Direct status: $directStatus"
} catch {
  Write-Output "Direct status: FAILED - $($_.Exception.Message)"
}

Write-Output "Proxy check with Host header: $domain -> $domainUrl"
try {
  $proxyStatus = (Invoke-WebRequest -Uri $domainUrl -Headers @{ Host = $domain } -UseBasicParsing -TimeoutSec 10).StatusCode
  Write-Output "Proxy status: $proxyStatus"
} catch {
  Write-Output "Proxy status: FAILED - $($_.Exception.Message)"
}
