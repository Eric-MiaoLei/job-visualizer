param(
  [string]$AppImage = "job-visualizer-app:portable",
  [string]$MongoImage = "mongo:7",
  [string]$ProxyImage = "job-visualizer-proxy:portable",
  [string]$OutputPath = "..\job-visualizer-images.tar"
)

$ErrorActionPreference = "Stop"

function Invoke-NativeStep {
  param(
    [string]$Description,
    [scriptblock]$Command
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
} else {
  $resolvedOutputPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath))
}

Write-Output "Syncing bundled skill outputs for Docker"
Invoke-NativeStep -Description "Sync-DockerSkillOutputs.ps1" -Command {
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot "Sync-DockerSkillOutputs.ps1")
}

Write-Output "Building app image: $AppImage"
Invoke-NativeStep -Description "docker build for $AppImage" -Command {
  docker build -t $AppImage $projectRoot
}

Write-Output "Building proxy image: $ProxyImage"
Invoke-NativeStep -Description "docker build for $ProxyImage" -Command {
  docker build -t $ProxyImage (Join-Path $projectRoot "nginx")
}

Write-Output "Pulling Mongo image: $MongoImage"
Invoke-NativeStep -Description "docker pull for $MongoImage" -Command {
  docker pull $MongoImage
}

Write-Output "Saving images to: $resolvedOutputPath"
Invoke-NativeStep -Description "docker save to $resolvedOutputPath" -Command {
  docker save -o $resolvedOutputPath $AppImage $MongoImage $ProxyImage
}

Write-Output "Docker image archive created: $resolvedOutputPath"
