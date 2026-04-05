param(
  [string]$OutputPath = "..\Start-Project-Launcher.exe"
)

$ErrorActionPreference = "Stop"

$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePath = Join-Path $launcherRoot "LauncherWrapper.cs"
$resolvedOutputPath = [System.IO.Path]::GetFullPath((Join-Path $launcherRoot $OutputPath))

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Wrapper source not found: $sourcePath"
}

if (Test-Path -LiteralPath $resolvedOutputPath) {
  Remove-Item -LiteralPath $resolvedOutputPath -Force
}

$sourceCode = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8

Add-Type `
  -TypeDefinition $sourceCode `
  -OutputAssembly $resolvedOutputPath `
  -OutputType WindowsApplication `
  -Language CSharp `
  -ReferencedAssemblies @(
    "System.dll",
    "System.Windows.Forms.dll",
    "System.Drawing.dll"
  )

Write-Output "Built launcher exe: $resolvedOutputPath"
