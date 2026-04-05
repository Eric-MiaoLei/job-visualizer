param(
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptRoot
try {
  docker compose -f .\docker-compose.yml --env-file $EnvFile up -d
} finally {
  Pop-Location
}
