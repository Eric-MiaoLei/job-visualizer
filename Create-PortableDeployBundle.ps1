param(
  [string]$OutputDirectory = "..\job-visualizer-portable-bundle",
  [string]$OutputTar = "..\job-visualizer-portable-bundle.tar"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$portableRoot = Join-Path $projectRoot "portable"
if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  $resolvedOutputDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}

if ([System.IO.Path]::IsPathRooted($OutputTar)) {
  $resolvedOutputTar = [System.IO.Path]::GetFullPath($OutputTar)
} else {
  $resolvedOutputTar = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputTar))
}

if (Test-Path -LiteralPath $resolvedOutputDirectory) {
  Remove-Item -LiteralPath $resolvedOutputDirectory -Recurse -Force
}

New-Item -ItemType Directory -Path $resolvedOutputDirectory | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "docker-compose.portable.yml") -Destination (Join-Path $resolvedOutputDirectory "docker-compose.yml")
Copy-Item -LiteralPath (Join-Path $portableRoot ".env.example") -Destination (Join-Path $resolvedOutputDirectory ".env.example")
Copy-Item -LiteralPath (Join-Path $portableRoot "README.md") -Destination (Join-Path $resolvedOutputDirectory "README.md")
Copy-Item -LiteralPath (Join-Path $portableRoot "Start-Portable.ps1") -Destination (Join-Path $resolvedOutputDirectory "Start-Portable.ps1")
Copy-Item -LiteralPath (Join-Path $portableRoot "Stop-Portable.ps1") -Destination (Join-Path $resolvedOutputDirectory "Stop-Portable.ps1")
Copy-Item -LiteralPath (Join-Path $portableRoot "Check-Portable.ps1") -Destination (Join-Path $resolvedOutputDirectory "Check-Portable.ps1")
Copy-Item -LiteralPath (Join-Path $portableRoot "Start-Portable.bat") -Destination (Join-Path $resolvedOutputDirectory "Start-Portable.bat")
Copy-Item -LiteralPath (Join-Path $portableRoot "Stop-Portable.bat") -Destination (Join-Path $resolvedOutputDirectory "Stop-Portable.bat")

if (Test-Path -LiteralPath $resolvedOutputTar) {
  Remove-Item -LiteralPath $resolvedOutputTar -Force
}

tar -cf $resolvedOutputTar -C $resolvedOutputDirectory .

Write-Output "Portable deploy bundle created:"
Write-Output "  Directory: $resolvedOutputDirectory"
Write-Output "  Tar: $resolvedOutputTar"
