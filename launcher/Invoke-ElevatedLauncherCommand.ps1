param(
  [string]$WorkingDirectory,
  [string]$Command,
  [string]$StdOutPath,
  [string]$StdErrPath,
  [string]$ExitCodePath
)

$ErrorActionPreference = "Stop"

try {
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    Set-Location -LiteralPath $WorkingDirectory
  }

  foreach ($path in @($StdOutPath, $StdErrPath, $ExitCodePath)) {
    if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }

  $quotedStdOutPath = $StdOutPath.Replace('"', '""')
  $quotedStdErrPath = $StdErrPath.Replace('"', '""')
  $cmdLine = "$Command 1> `"$quotedStdOutPath`" 2> `"$quotedStdErrPath`""

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "cmd.exe"
  $startInfo.Arguments = "/d /c $cmdLine"
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $process.WaitForExit()
  $exitCode = $process.ExitCode
} catch {
  $message = ($_ | Out-String)
  if (-not [string]::IsNullOrWhiteSpace($StdErrPath)) {
    [System.IO.File]::AppendAllText($StdErrPath, $message, [System.Text.Encoding]::UTF8)
  }

  $exitCode = 1
}

[System.IO.File]::WriteAllText($ExitCodePath, [string]$exitCode, [System.Text.Encoding]::UTF8)
exit $exitCode
