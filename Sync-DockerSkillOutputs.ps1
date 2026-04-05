param(
  [string]$SourceRoot = "..\skills\jphr\outputs\japan-frontend-jobs",
  [string]$TargetRoot = ".\docker-assets\skills\jphr\outputs\japan-frontend-jobs"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$resolvedSourceRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $SourceRoot))
$resolvedTargetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $TargetRoot))

if (-not (Test-Path -LiteralPath $resolvedSourceRoot)) {
  throw "Skill output source directory not found: $resolvedSourceRoot"
}

$latestDirectory = Get-ChildItem -LiteralPath $resolvedSourceRoot -Directory |
  Sort-Object Name -Descending |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "jobs.json") } |
  Select-Object -First 1

if (-not $latestDirectory) {
  throw "No dated skill output directories containing jobs.json were found under: $resolvedSourceRoot"
}

$sourceJobsPath = Join-Path $latestDirectory.FullName "jobs.json"
$targetDirectory = Join-Path $resolvedTargetRoot $latestDirectory.Name
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null

Get-ChildItem -LiteralPath $resolvedTargetRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne $latestDirectory.Name } |
  Remove-Item -Recurse -Force

Copy-Item -LiteralPath $sourceJobsPath -Destination (Join-Path $targetDirectory "jobs.json") -Force

Write-Output "Synced Docker skill output:"
Write-Output "  Source: $sourceJobsPath"
Write-Output "  Target: $(Join-Path $targetDirectory 'jobs.json')"
