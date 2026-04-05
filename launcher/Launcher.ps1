param(
  [switch]$SmokeTest,
  [switch]$ValidateUI,
  [string]$StartTask,
  [string]$StopTask,
  [string]$OpenTask,
  [switch]$NoUI
)

$ErrorActionPreference = "Stop"

$script:LauncherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ConfigPath = if (Test-Path -LiteralPath (Join-Path $script:LauncherRoot "LauncherConfig.json")) {
  Join-Path $script:LauncherRoot "LauncherConfig.json"
} else {
  Join-Path $script:LauncherRoot "tasks.json"
}
$script:ElevatedRunnerPath = Join-Path $script:LauncherRoot "Invoke-ElevatedLauncherCommand.ps1"
$script:StatePath = Join-Path $script:LauncherRoot "runtime\state.json"
$script:CardRefs = @{}
$script:PendingAutoOpen = @{}
$script:PendingDockerAutoOpen = @{}
$script:PendingDockerActions = @{}
$script:PendingDockerPackNotify = @{}
$script:CompletedDockerActions = @{}
$script:StatusBanner = $null
$script:EnvCache = $null

function Get-ProjectRoot {
  return Split-Path -Parent $script:LauncherRoot
}

function Get-EnvFilePath {
  return Join-Path (Get-ProjectRoot) ".env"
}

function Ensure-Directory {
  param([string]$Path)

  if (-not [string]::IsNullOrWhiteSpace($Path) -and -not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function ConvertTo-AbsolutePath {
  param(
    [string]$BasePath,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Value))
}

function Escape-XmlText {
  param([string]$Text)

  if ($null -eq $Text) {
    return ""
  }

  return [System.Security.SecurityElement]::Escape([string]$Text)
}

function Get-ProjectEnvMap {
  if ($null -ne $script:EnvCache) {
    return $script:EnvCache
  }

  $script:EnvCache = @{}
  $envPath = Get-EnvFilePath
  if (-not (Test-Path -LiteralPath $envPath)) {
    return $script:EnvCache
  }

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
    if ($key) {
      $script:EnvCache[$key] = $value
    }
  }

  return $script:EnvCache
}

function Save-ProjectEnvValues {
  param([hashtable]$Updates)

  $envPath = Get-EnvFilePath
  $lines = @()
  if (Test-Path -LiteralPath $envPath) {
    $lines = @(Get-Content -LiteralPath $envPath -Encoding UTF8)
  }

  $handledKeys = @{}
  $nextLines = @()

  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not ($trimmed -match "^[A-Za-z_][A-Za-z0-9_]*=")) {
      $nextLines += $line
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")
    $key = $trimmed.Substring(0, $separatorIndex).Trim()
    if ($Updates.ContainsKey($key)) {
      $nextLines += "$key=$($Updates[$key])"
      $handledKeys[$key] = $true
    } else {
      $nextLines += $line
    }
  }

  foreach ($key in $Updates.Keys) {
    if (-not $handledKeys.ContainsKey($key)) {
      $nextLines += "$key=$($Updates[$key])"
    }
  }

  [System.IO.File]::WriteAllText($envPath, (($nextLines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.Encoding]::UTF8)
  $script:EnvCache = $null
}

function Get-ProjectSettingValue {
  param(
    [string]$Key,
    [string]$DefaultValue = ""
  )

  $envMap = Get-ProjectEnvMap
  if ($envMap.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($envMap[$Key])) {
    return [string]$envMap[$Key]
  }

  return $DefaultValue
}

function Resolve-DockerOpenUrl {
  param(
    [pscustomobject]$Task,
    [string]$ConfiguredUrl
  )

  if (-not [string]::IsNullOrWhiteSpace($ConfiguredUrl)) {
    return $ConfiguredUrl
  }

  $envMap = Get-ProjectEnvMap

  if (-not [string]::IsNullOrWhiteSpace($envMap.LAUNCHER_DOCKER_OPEN_URL)) {
    return $envMap.LAUNCHER_DOCKER_OPEN_URL
  }

  $domain = $envMap.LOCAL_DOMAIN
  $domainPort = $envMap.DOMAIN_HTTP_PORT
  if (-not [string]::IsNullOrWhiteSpace($domain)) {
    if ([string]::IsNullOrWhiteSpace($domainPort) -or $domainPort -eq "80") {
      return "http://$domain"
    }

    return "http://$domain`:$domainPort"
  }

  $hostAddress = $envMap.HOST_BIND_IP
  if ([string]::IsNullOrWhiteSpace($hostAddress) -or $hostAddress -eq "0.0.0.0") {
    $hostAddress = "127.0.0.1"
  }

  $port = $envMap.APP_HOST_PORT
  if ([string]::IsNullOrWhiteSpace($port)) {
    $port = if ($Task.port) { [string]$Task.port } else { "11301" }
  }

  return "http://$hostAddress`:$port"
}

function Refresh-ResolvedTaskSettings {
  param([object[]]$Tasks)

  foreach ($task in $Tasks) {
    if ($task.docker) {
      $task.docker.openUrl = Resolve-DockerOpenUrl -Task $task -ConfiguredUrl ([string]$task.docker.configuredOpenUrl)
    }
  }
}

function Get-LauncherConfig {
  if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
    throw "Launcher config not found: $script:ConfigPath"
  }

  $configDirectory = Split-Path -Parent $script:ConfigPath
  $raw = Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $tasks = @()

  foreach ($task in @($raw.tasks)) {
    $resolvedWorkingDirectory = ConvertTo-AbsolutePath -BasePath $configDirectory -Value $task.workingDirectory
    $resolvedLogDirectory = ConvertTo-AbsolutePath -BasePath $configDirectory -Value $task.logDirectory
    if ([string]::IsNullOrWhiteSpace([string]$task.projectName)) {
      $projectName = [string]$task.name
    } else {
      $projectName = [string]$task.projectName
    }

    if ($null -ne $task.port) {
      $taskPort = [int]$task.port
    } else {
      $taskPort = $null
    }
    $tags = @()

    foreach ($tag in @($task.tags)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$tag)) {
        $tags += [string]$tag
      }
    }

    $tasks += [pscustomobject]@{
      id = [string]$task.id
      name = [string]$task.name
      projectName = $projectName
      description = [string]$task.description
      workingDirectory = $resolvedWorkingDirectory
      command = [string]$task.command
      openUrl = [string]$task.openUrl
      healthUrl = [string]$task.healthUrl
      port = $taskPort
      logDirectory = $resolvedLogDirectory
      tags = $tags
      docker = [pscustomobject]@{
        enabled = [bool]$task.docker.enabled
        serviceName = [string]$task.docker.serviceName
        upCommand = [string]$task.docker.upCommand
        downCommand = [string]$task.docker.downCommand
        logsCommand = [string]$task.docker.logsCommand
        packCommand = [string]$task.docker.packCommand
        packOutputPath = ConvertTo-AbsolutePath -BasePath $configDirectory -Value ([string]$task.docker.packOutputPath)
        configuredOpenUrl = [string]$task.docker.openUrl
        openUrl = Resolve-DockerOpenUrl -Task $task -ConfiguredUrl ([string]$task.docker.openUrl)
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace([string]$raw.launcherName)) {
    $launcherName = "Workspace Launch Deck"
  } else {
    $launcherName = [string]$raw.launcherName
  }

  return [pscustomobject]@{
    launcherName = $launcherName
    description = [string]$raw.description
    tasks = $tasks
  }
}

function Get-LauncherState {
  Ensure-Directory -Path (Split-Path -Parent $script:StatePath)

  if (-not (Test-Path -LiteralPath $script:StatePath)) {
    return @()
  }

  $content = Get-Content -LiteralPath $script:StatePath -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($content)) {
    return @()
  }

  $parsed = ConvertFrom-Json -InputObject $content
  if ($null -eq $parsed) {
    return @()
  }

  return @($parsed)
}

function Save-LauncherState {
  param([object[]]$Records)

  Ensure-Directory -Path (Split-Path -Parent $script:StatePath)
  @($Records) | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $script:StatePath -Encoding UTF8
}

function Get-StateRecord {
  param([string]$TaskId)

  return Get-LauncherState | Where-Object { $_.id -eq $TaskId } | Select-Object -First 1
}

function Remove-StateRecord {
  param([string]$TaskId)

  $remaining = @(Get-LauncherState | Where-Object { $_.id -ne $TaskId })
  Save-LauncherState -Records $remaining
}

function Set-StateRecord {
  param([pscustomobject]$Record)

  $remaining = @(Get-LauncherState | Where-Object { $_.id -ne $Record.id })
  $remaining += $Record
  Save-LauncherState -Records $remaining
}

function Test-ManagedProcess {
  param([object]$Record)

  if ($null -eq $Record -or $null -eq $Record.pid) {
    return $false
  }

  $process = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
  return $null -ne $process
}

function Test-TaskHealth {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return $false
  }

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Invoke-CommandInDirectory {
  param(
    [string]$WorkingDirectory,
    [string]$Command
  )

  Push-Location $WorkingDirectory
  try {
    return @(& cmd.exe /d /c $Command 2>$null)
  } finally {
    Pop-Location
  }
}

function Get-BackgroundActionRecord {
  param([string]$TaskId)

  $record = $script:PendingDockerActions[$TaskId]
  if (-not $record) {
    return $null
  }

  $process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    $exitCode = $null
    if (-not [string]::IsNullOrWhiteSpace($record.exitCodePath) -and (Test-Path -LiteralPath $record.exitCodePath)) {
      $exitCodeText = (Get-Content -LiteralPath $record.exitCodePath -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
      $parsedExitCode = 0
      if ([int]::TryParse($exitCodeText, [ref]$parsedExitCode)) {
        $exitCode = $parsedExitCode
      }
    }

    $script:CompletedDockerActions[$TaskId] = [pscustomobject]@{
      pid = $record.pid
      action = $record.action
      stdoutPath = $record.stdoutPath
      stderrPath = $record.stderrPath
      exitCodePath = $record.exitCodePath
      exitCode = $exitCode
      startedAt = $record.startedAt
      completedAt = (Get-Date).ToString("o")
    }
    $script:PendingDockerActions.Remove($TaskId) | Out-Null
    return $null
  }

  return $record
}

function Get-CompletedDockerActionRecord {
  param([string]$TaskId)

  return $script:CompletedDockerActions[$TaskId]
}

function Clear-CompletedDockerActionRecord {
  param([string]$TaskId)

  if ($script:CompletedDockerActions.ContainsKey($TaskId)) {
    $script:CompletedDockerActions.Remove($TaskId) | Out-Null
  }
}

function Start-BackgroundCommand {
  param(
    [pscustomobject]$Task,
    [string]$Command,
    [string]$Suffix,
    [string]$Action,
    [switch]$Elevate
  )

  Ensure-Directory -Path $Task.logDirectory
  $stdoutPath = Join-Path $Task.logDirectory "$($Task.id).$Suffix.stdout.log"
  $stderrPath = Join-Path $Task.logDirectory "$($Task.id).$Suffix.stderr.log"
  $exitCodePath = Join-Path $Task.logDirectory "$($Task.id).$Suffix.exitcode.log"
  $wrappedCommand = "call $Command & echo !errorlevel! > `"$exitCodePath`""

  foreach ($path in @($stdoutPath, $stderrPath, $exitCodePath)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }

  if ($Elevate) {
    if (-not (Test-Path -LiteralPath $script:ElevatedRunnerPath)) {
      throw "Elevated launcher helper not found: $script:ElevatedRunnerPath"
    }

    $argumentList = @(
      "-NoProfile"
      "-ExecutionPolicy Bypass"
      "-File `"$script:ElevatedRunnerPath`""
      "-WorkingDirectory `"$($Task.workingDirectory)`""
      "-Command `"$Command`""
      "-StdOutPath `"$stdoutPath`""
      "-StdErrPath `"$stderrPath`""
      "-ExitCodePath `"$exitCodePath`""
    ) -join " "

    $process = Start-Process `
      -FilePath "powershell.exe" `
      -ArgumentList $argumentList `
      -Verb RunAs `
      -WindowStyle Hidden `
      -PassThru
  } else {
    $process = Start-Process `
      -FilePath "cmd.exe" `
      -ArgumentList @("/v:on", "/d", "/c", $wrappedCommand) `
      -WorkingDirectory $Task.workingDirectory `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
  }

  return [pscustomobject]@{
    pid = $process.Id
    action = $Action
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    exitCodePath = $exitCodePath
    startedAt = (Get-Date).ToString("o")
  }
}

function Test-ActionOutputIsFresh {
  param(
    [object]$ActionRecord,
    [string]$OutputPath
  )

  if ([string]::IsNullOrWhiteSpace($OutputPath) -or -not (Test-Path -LiteralPath $OutputPath)) {
    return $false
  }

  $startedAt = $null
  try {
    $startedAt = [datetime]$ActionRecord.startedAt
  } catch {
    $startedAt = $null
  }

  if ($null -eq $startedAt) {
    return $true
  }

  return (Get-Item -LiteralPath $OutputPath).LastWriteTime -ge $startedAt.AddSeconds(-1)
}

function Get-DockerRunningServiceNames {
  param([pscustomobject]$Task)

  if (-not $Task.docker.enabled) {
    return @()
  }

  if (-not (Test-Path -LiteralPath $Task.workingDirectory)) {
    return @()
  }

  try {
    $lines = Invoke-CommandInDirectory -WorkingDirectory $Task.workingDirectory -Command "docker compose ps --services --status running"
    return @($lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })
  } catch {
    return @()
  }
}

function Get-DockerTaskSnapshot {
  param([pscustomobject]$Task)

  if (-not $Task.docker.enabled) {
    return [pscustomobject]@{
      enabled = $false
      running = $false
      statusKey = "disabled"
      statusText = "Docker disabled"
      detailText = "Docker mode is not configured for this task."
      canStart = $false
      canStop = $false
      canLogs = $false
      canPack = $false
    }
  }

  $actionRecord = Get-BackgroundActionRecord -TaskId $Task.id
  $runningServices = @(Get-DockerRunningServiceNames -Task $Task)
  $serviceRunning = $runningServices -contains $Task.docker.serviceName

  if ($serviceRunning) {
    return [pscustomobject]@{
      enabled = $true
      running = $true
      statusKey = "running"
      statusText = "Docker running"
      detailText = "Docker service '$($Task.docker.serviceName)' is up."
      canStart = $false
      canStop = $true
      canLogs = $true
      canPack = -not $actionRecord
    }
  }

  if ($actionRecord) {
    if ($actionRecord.action -eq "up") {
      $statusKey = "starting"
      $statusText = "Docker starting"
      $detailText = "Compose is bringing the stack up in the background."
      $canStart = $false
      $canStop = $true
      $canPack = $false
    } elseif ($actionRecord.action -eq "pack") {
      $statusKey = "starting"
      $statusText = "Docker packing"
      $detailText = "The importable Docker image tar is being generated in the background."
      $canStart = $false
      $canStop = $false
      $canPack = $false
    } else {
      $statusKey = "stopping"
      $statusText = "Docker stopping"
      $detailText = "Compose is shutting the stack down in the background."
      $canStart = $false
      $canStop = $false
      $canPack = $false
    }

    return [pscustomobject]@{
      enabled = $true
      running = $false
      statusKey = $statusKey
      statusText = $statusText
      detailText = $detailText
      canStart = $canStart
      canStop = $canStop
      canLogs = $true
      canPack = $canPack
    }
  }

  return [pscustomobject]@{
    enabled = $true
    running = $false
    statusKey = "stopped"
    statusText = "Docker stopped"
    detailText = "Run Docker Compose for this task."
    canStart = $true
    canStop = $false
    canLogs = $true
    canPack = -not [string]::IsNullOrWhiteSpace($Task.docker.packCommand)
  }
}

function Get-ListeningProcessIds {
  param([int]$Port)

  if (-not $Port) {
    return @()
  }

  $lines = @(netstat -ano -p tcp | Select-String "LISTENING")
  $processIds = @()

  foreach ($line in $lines) {
    $text = ($line.ToString() -replace "\s+", " ").Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
      continue
    }

    $parts = $text.Split(" ")
    if ($parts.Count -lt 5) {
      continue
    }

    $localAddress = $parts[1]
    $pidText = $parts[-1]

    if ($localAddress -notmatch ":(\d+)$") {
      continue
    }

    $localPort = [int]$Matches[1]
    if ($localPort -ne $Port) {
      continue
    }

    $matchedProcessId = 0
    if ([int]::TryParse($pidText, [ref]$matchedProcessId) -and $matchedProcessId -gt 0) {
      $processIds += $matchedProcessId
    }
  }

  return @($processIds | Sort-Object -Unique)
}

function Get-TaskSnapshot {
  param([pscustomobject]$Task)

  $record = Get-StateRecord -TaskId $Task.id
  $managedAlive = Test-ManagedProcess -Record $record

  if ($record -and -not $managedAlive) {
    Remove-StateRecord -TaskId $Task.id
    $record = $null
  }

  $healthy = Test-TaskHealth -Url $Task.healthUrl
  $statusKey = "stopped"
  $statusText = "Stopped"
  if ($Task.port) {
    $detailText = "Port $($Task.port) - Command $($Task.command)"
  } else {
    $detailText = "Command $($Task.command)"
  }

  if ($record) {
    if ($healthy) {
      $statusKey = "running"
      $statusText = "Running"
    } else {
      $statusKey = "starting"
      $statusText = "Starting"
    }

    $startedAt = try { [datetime]$record.startedAt } catch { $null }
    if ($startedAt) {
      $detailText = "PID $($record.pid) - Started $($startedAt.ToString("yyyy-MM-dd HH:mm:ss"))"
    } else {
      $detailText = "PID $($record.pid) - Managed by launcher"
    }
  } elseif ($healthy) {
    $statusKey = "external"
    $statusText = "External"
    $detailText = "Service is reachable, but it is not managed by this launcher."
  }

  return [pscustomobject]@{
    task = $Task
    record = $record
    healthy = $healthy
    managedAlive = [bool]$record
    statusKey = $statusKey
    statusText = $statusText
    detailText = $detailText
    canStart = -not ($healthy -or $record)
    canStop = [bool]$record -or (($healthy -or $statusKey -eq "external") -and [bool]$Task.port)
  }
}

function Get-CombinedTaskSnapshot {
  param([pscustomobject]$Task)

  $localSnapshot = Get-TaskSnapshot -Task $Task
  $dockerSnapshot = Get-DockerTaskSnapshot -Task $Task

  if ($dockerSnapshot.statusKey -eq "running") {
    $statusKey = "running"
    $statusText = "Docker Running"
  } elseif ($dockerSnapshot.statusKey -eq "starting") {
    $statusKey = "starting"
    $statusText = "Docker Starting"
  } elseif ($dockerSnapshot.statusKey -eq "stopping") {
    $statusKey = "starting"
    $statusText = "Docker Stopping"
  } else {
    $statusKey = $localSnapshot.statusKey
    if ($localSnapshot.statusKey -eq "running") {
      $statusText = "Local Running"
    } elseif ($localSnapshot.statusKey -eq "starting") {
      $statusText = "Local Starting"
    } elseif ($localSnapshot.statusKey -eq "external") {
      $statusText = "Port Busy"
    } else {
      $statusText = "Stopped"
    }
  }

  return [pscustomobject]@{
    task = $Task
    local = $localSnapshot
    docker = $dockerSnapshot
    statusKey = $statusKey
    statusText = $statusText
  }
}

function Set-BannerMessage {
  param(
    [string]$Message,
    [string]$Tone = "neutral"
  )

  if ($null -eq $script:StatusBanner) {
    return
  }

  $script:StatusBanner.Text = $Message
  switch ($Tone) {
    "success" {
      $script:StatusBanner.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#0B7A5A")
    }
    "error" {
      $script:StatusBanner.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#B54444")
    }
    default {
      $script:StatusBanner.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#5E5E72")
    }
  }
}

function Get-DirectPreviewUrl {
  param(
    [string]$HostBindIp,
    [string]$AppPort
  )

  $resolvedHost = if ([string]::IsNullOrWhiteSpace($HostBindIp) -or $HostBindIp -eq "0.0.0.0") { "127.0.0.1" } else { $HostBindIp }
  $resolvedPort = if ([string]::IsNullOrWhiteSpace($AppPort)) { "11301" } else { $AppPort }
  return "http://$resolvedHost`:$resolvedPort"
}

function Get-DomainPreviewUrl {
  param(
    [string]$Domain,
    [string]$DomainPort
  )

  if ([string]::IsNullOrWhiteSpace($Domain)) {
    return "Not set"
  }

  if ([string]::IsNullOrWhiteSpace($DomainPort) -or $DomainPort -eq "80") {
    return "http://$Domain"
  }

  return "http://$Domain`:$DomainPort"
}

function Show-NetworkSettingsDialog {
  param([object[]]$Tasks)

  $dialogXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="LAN Settings"
        Width="640"
        Height="560"
        WindowStartupLocation="CenterOwner"
        ResizeMode="NoResize"
        Background="#F7F2EA">
  <Grid Margin="24">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="*" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>
    <StackPanel Grid.Row="0">
      <TextBlock Text="LAN Access Settings"
                 FontSize="28"
                 FontWeight="Bold"
                 Foreground="#171523" />
      <TextBlock Margin="0,10,0,0"
                 TextWrapping="Wrap"
                 FontSize="14"
                 Foreground="#66657A"
                 Text="Configure the host IP, ports, and local domain used by Docker Compose and the desktop launcher." />
    </StackPanel>

    <Border Grid.Row="1"
            Margin="0,18,0,18"
            Padding="22"
            CornerRadius="24"
            Background="#FFFDFC"
            BorderBrush="#E2DDE8"
            BorderThickness="1">
      <Grid>
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
        </Grid.RowDefinitions>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="170" />
          <ColumnDefinition Width="*" />
        </Grid.ColumnDefinitions>

        <TextBlock Grid.Row="0" Grid.Column="0" Margin="0,10,14,0" VerticalAlignment="Center" FontWeight="SemiBold" Foreground="#2F2C45" Text="Host Bind IP" />
        <TextBox x:Name="HostBindIpBox" Grid.Row="0" Grid.Column="1" Height="38" VerticalContentAlignment="Center" />

        <TextBlock Grid.Row="1" Grid.Column="0" Margin="0,14,14,0" VerticalAlignment="Center" FontWeight="SemiBold" Foreground="#2F2C45" Text="App Host Port" />
        <TextBox x:Name="AppPortBox" Grid.Row="1" Grid.Column="1" Height="38" Margin="0,14,0,0" VerticalContentAlignment="Center" />

        <TextBlock Grid.Row="2" Grid.Column="0" Margin="0,14,14,0" VerticalAlignment="Center" FontWeight="SemiBold" Foreground="#2F2C45" Text="Local Domain" />
        <TextBox x:Name="DomainBox" Grid.Row="2" Grid.Column="1" Height="38" Margin="0,14,0,0" VerticalContentAlignment="Center" />

        <TextBlock Grid.Row="3" Grid.Column="0" Margin="0,14,14,0" VerticalAlignment="Center" FontWeight="SemiBold" Foreground="#2F2C45" Text="Domain Port" />
        <TextBox x:Name="DomainPortBox" Grid.Row="3" Grid.Column="1" Height="38" Margin="0,14,0,0" VerticalContentAlignment="Center" />

        <TextBlock Grid.Row="4" Grid.Column="0" Margin="0,14,14,0" VerticalAlignment="Center" FontWeight="SemiBold" Foreground="#2F2C45" Text="Launcher URL Override" />
        <TextBox x:Name="LauncherUrlBox" Grid.Row="4" Grid.Column="1" Height="38" Margin="0,14,0,0" VerticalContentAlignment="Center" />

        <Border Grid.Row="5" Grid.ColumnSpan="2" Margin="0,22,0,0" Padding="16" CornerRadius="18" Background="#F5F6FF">
          <StackPanel>
            <TextBlock Text="Preview" FontWeight="Bold" Foreground="#243A72" />
            <TextBlock x:Name="DirectPreviewText" Margin="0,10,0,0" Foreground="#2F2C45" TextWrapping="Wrap" />
            <TextBlock x:Name="DomainPreviewText" Margin="0,6,0,0" Foreground="#2F2C45" TextWrapping="Wrap" />
          </StackPanel>
        </Border>

        <TextBlock Grid.Row="6" Grid.ColumnSpan="2" Margin="0,18,0,0" Foreground="#66657A" TextWrapping="Wrap"
                   Text="DNS is still external to Docker. Add a router DNS override or a hosts entry that points your domain to the host IP." />
      </Grid>
    </Border>

    <DockPanel Grid.Row="2" LastChildFill="False">
      <TextBlock x:Name="DialogStatusText"
                 VerticalAlignment="Center"
                 Foreground="#66657A"
                 Text="Changes will be written to the project .env file." />
      <StackPanel Orientation="Horizontal" DockPanel.Dock="Right">
        <Button x:Name="CancelButton"
                Width="96"
                Height="40"
                Margin="0,0,10,0"
                Cursor="Hand"
                BorderBrush="#D0CBDD"
                BorderThickness="1"
                Background="#FFFFFF"
                Foreground="#2F2C45"
                Content="Cancel" />
        <Button x:Name="SaveButton"
                Width="116"
                Height="40"
                Cursor="Hand"
                BorderThickness="0"
                Background="#1B1A28"
                Foreground="White"
                Content="Save Settings" />
      </StackPanel>
    </DockPanel>
  </Grid>
</Window>
"@

  [xml]$dialogXml = $dialogXaml
  $dialogReader = New-Object System.Xml.XmlNodeReader $dialogXml
  $dialog = [Windows.Markup.XamlReader]::Load($dialogReader)

  $dialog.Owner = $window

  $hostBindIpBox = $dialog.FindName("HostBindIpBox")
  $appPortBox = $dialog.FindName("AppPortBox")
  $domainBox = $dialog.FindName("DomainBox")
  $domainPortBox = $dialog.FindName("DomainPortBox")
  $launcherUrlBox = $dialog.FindName("LauncherUrlBox")
  $directPreviewText = $dialog.FindName("DirectPreviewText")
  $domainPreviewText = $dialog.FindName("DomainPreviewText")
  $dialogStatusText = $dialog.FindName("DialogStatusText")
  $cancelButton = $dialog.FindName("CancelButton")
  $saveButton = $dialog.FindName("SaveButton")

  $hostBindIpBox.Text = Get-ProjectSettingValue -Key "HOST_BIND_IP" -DefaultValue "0.0.0.0"
  $appPortBox.Text = Get-ProjectSettingValue -Key "APP_HOST_PORT" -DefaultValue "11301"
  $domainBox.Text = Get-ProjectSettingValue -Key "LOCAL_DOMAIN" -DefaultValue "jobviz.home.arpa"
  $domainPortBox.Text = Get-ProjectSettingValue -Key "DOMAIN_HTTP_PORT" -DefaultValue "80"
  $launcherUrlBox.Text = Get-ProjectSettingValue -Key "LAUNCHER_DOCKER_OPEN_URL" -DefaultValue ""

  $updatePreview = {
    $directPreviewText.Text = "Direct URL: $(Get-DirectPreviewUrl -HostBindIp $hostBindIpBox.Text -AppPort $appPortBox.Text)"
    if (-not [string]::IsNullOrWhiteSpace($launcherUrlBox.Text)) {
      $domainPreviewText.Text = "Launcher override: $($launcherUrlBox.Text)"
    } else {
      $domainPreviewText.Text = "Domain URL: $(Get-DomainPreviewUrl -Domain $domainBox.Text -DomainPort $domainPortBox.Text)"
    }
  }

  & $updatePreview

  foreach ($box in @($hostBindIpBox, $appPortBox, $domainBox, $domainPortBox, $launcherUrlBox)) {
    $box.Add_TextChanged({ & $updatePreview })
  }

  $cancelButton.Add_Click({
    $dialog.DialogResult = $false
    $dialog.Close()
  })

  $saveButton.Add_Click({
    $appPort = 0
    $domainPort = 0
    if (-not [int]::TryParse($appPortBox.Text, [ref]$appPort) -or $appPort -lt 1 -or $appPort -gt 65535) {
      $dialogStatusText.Text = "App Host Port must be a number between 1 and 65535."
      $dialogStatusText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#B54444")
      return
    }

    if (-not [int]::TryParse($domainPortBox.Text, [ref]$domainPort) -or $domainPort -lt 1 -or $domainPort -gt 65535) {
      $dialogStatusText.Text = "Domain Port must be a number between 1 and 65535."
      $dialogStatusText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#B54444")
      return
    }

    Save-ProjectEnvValues -Updates @{
      HOST_BIND_IP = $hostBindIpBox.Text.Trim()
      APP_HOST_PORT = $appPortBox.Text.Trim()
      LOCAL_DOMAIN = $domainBox.Text.Trim()
      DOMAIN_HTTP_PORT = $domainPortBox.Text.Trim()
      LAUNCHER_DOCKER_OPEN_URL = $launcherUrlBox.Text.Trim()
    }

    Refresh-ResolvedTaskSettings -Tasks $Tasks
    Update-TaskViews -Tasks $Tasks
    Set-BannerMessage -Message "LAN settings saved to .env. Restart Docker containers to apply the new mapping." -Tone "success"
    $dialog.DialogResult = $true
    $dialog.Close()
  })

  [void]$dialog.ShowDialog()
}

function Start-ManagedTask {
  param([pscustomobject]$Task)

  $snapshot = Get-TaskSnapshot -Task $Task
  if ($snapshot.healthy -or $snapshot.managedAlive) {
    return [pscustomobject]@{
      started = $false
      reason = "already-running"
      snapshot = $snapshot
    }
  }

  if (-not (Test-Path -LiteralPath $Task.workingDirectory)) {
    throw "Task working directory not found: $($Task.workingDirectory)"
  }

  Ensure-Directory -Path $Task.logDirectory

  $stdoutPath = Join-Path $Task.logDirectory "$($Task.id).stdout.log"
  $stderrPath = Join-Path $Task.logDirectory "$($Task.id).stderr.log"

  $process = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/d", "/c", $Task.command) `
    -WorkingDirectory $Task.workingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $record = [pscustomobject]@{
    id = $Task.id
    pid = $process.Id
    startedAt = (Get-Date).ToString("o")
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    workingDirectory = $Task.workingDirectory
    command = $Task.command
    projectName = $Task.projectName
  }

  Set-StateRecord -Record $record

  return [pscustomobject]@{
    started = $true
    reason = "started"
    snapshot = Get-TaskSnapshot -Task $Task
  }
}

function Stop-ManagedTask {
  param([pscustomobject]$Task)

  $didStop = $false
  $record = Get-StateRecord -TaskId $Task.id
  if (-not $record) {
    $processIds = @(Get-ListeningProcessIds -Port $Task.port)

    foreach ($processId in $processIds) {
      try {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -in @("node", "cmd", "npm", "powershell", "pwsh")) {
          & taskkill.exe /PID $processId /T /F | Out-Null
          $didStop = $true
        }
      } catch {
      }
    }

    return $didStop
  }

  try {
    & taskkill.exe /PID ([int]$record.pid) /T /F | Out-Null
    $didStop = $true
  } catch {
  }

  $portProcessIds = @(Get-ListeningProcessIds -Port $Task.port)
  foreach ($processId in $portProcessIds) {
    try {
      & taskkill.exe /PID $processId /T /F | Out-Null
      $didStop = $true
    } catch {
    }
  }

  Remove-StateRecord -TaskId $Task.id
  $script:PendingAutoOpen.Remove($Task.id) | Out-Null
  return $didStop
}

function Open-TaskTarget {
  param([pscustomobject]$Task)

  if (-not [string]::IsNullOrWhiteSpace($Task.openUrl)) {
    Start-Process -FilePath $Task.openUrl | Out-Null
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($Task.workingDirectory)) {
    Start-Process -FilePath "explorer.exe" -ArgumentList @($Task.workingDirectory) | Out-Null
  }
}

function Open-DockerTarget {
  param([pscustomobject]$Task)

  if (-not [string]::IsNullOrWhiteSpace($Task.docker.openUrl)) {
    Start-Process -FilePath $Task.docker.openUrl | Out-Null
    return
  }

  Open-TaskTarget -Task $Task
}

function Open-TaskLog {
  param([pscustomobject]$Task)

  $record = Get-StateRecord -TaskId $Task.id
  $candidates = @()

  if ($record) {
    $candidates += @($record.stderrPath, $record.stdoutPath)
  } elseif ($Task.logDirectory) {
    $candidates += @(
      (Join-Path $Task.logDirectory "$($Task.id).stderr.log"),
      (Join-Path $Task.logDirectory "$($Task.id).stdout.log")
    )
  }

  $logPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($logPath) {
    Start-Process -FilePath "notepad.exe" -ArgumentList @($logPath) | Out-Null
  }
}

function Open-DockerLogs {
  param([pscustomobject]$Task)

  if (-not $Task.docker.enabled -or [string]::IsNullOrWhiteSpace($Task.docker.logsCommand)) {
    return
  }

  Start-Process -FilePath "cmd.exe" -ArgumentList @("/k", $Task.docker.logsCommand) -WorkingDirectory $Task.workingDirectory | Out-Null
}

function Open-DockerPackOutput {
  param([pscustomobject]$Task)

  if ([string]::IsNullOrWhiteSpace($Task.docker.packOutputPath)) {
    return
  }

  if (Test-Path -LiteralPath $Task.docker.packOutputPath) {
    Start-Process -FilePath "explorer.exe" -ArgumentList @("/select,", $Task.docker.packOutputPath) | Out-Null
  }
}

function Invoke-StartAndOpen {
  param([pscustomobject]$Task)

  $result = Start-ManagedTask -Task $Task

  if ($result.started) {
    $script:PendingAutoOpen[$Task.id] = $true
    Set-BannerMessage -Message "Starting $($Task.name). The page will open automatically when the service is ready." -Tone "neutral"
    return
  }

  if ($result.snapshot.healthy) {
    Open-TaskTarget -Task $Task
    Set-BannerMessage -Message "$($Task.name) is already running. The page has been opened." -Tone "success"
    return
  }

  Set-BannerMessage -Message "$($Task.name) is already managed by the launcher. Status will refresh shortly." -Tone "neutral"
}

function Invoke-DockerUpAndOpen {
  param([pscustomobject]$Task)

  $dockerSnapshot = Get-DockerTaskSnapshot -Task $Task
  if (-not $dockerSnapshot.enabled) {
    Set-BannerMessage -Message "Docker mode is not configured for $($Task.name)." -Tone "error"
    return
  }

  if ($dockerSnapshot.running) {
    Open-DockerTarget -Task $Task
    Set-BannerMessage -Message "$($Task.name) Docker stack is already running. The page has been opened." -Tone "success"
    return
  }

  if ($dockerSnapshot.statusKey -in @("starting", "stopping")) {
    Set-BannerMessage -Message "$($Task.name) Docker stack is busy. Please wait a moment." -Tone "neutral"
    return
  }

  try {
    $script:PendingDockerActions[$Task.id] = Start-BackgroundCommand -Task $Task -Command $Task.docker.upCommand -Suffix "docker-up" -Action "up" -Elevate
  } catch {
    Set-BannerMessage -Message "Docker start for $($Task.name) was cancelled or failed to request elevation." -Tone "error"
    return
  }
  $script:PendingDockerAutoOpen[$Task.id] = $true
  Set-BannerMessage -Message "Starting Docker for $($Task.name). The page will open automatically when ready." -Tone "neutral"
}

function Invoke-DockerDown {
  param([pscustomobject]$Task)

  $dockerSnapshot = Get-DockerTaskSnapshot -Task $Task
  if (-not $dockerSnapshot.enabled) {
    Set-BannerMessage -Message "Docker mode is not configured for $($Task.name)." -Tone "error"
    return
  }

  if ($dockerSnapshot.statusKey -eq "stopping") {
    Set-BannerMessage -Message "$($Task.name) Docker stack is already stopping." -Tone "neutral"
    return
  }

  if (-not $dockerSnapshot.running -and $dockerSnapshot.statusKey -ne "starting") {
    Set-BannerMessage -Message "$($Task.name) Docker stack is not currently running." -Tone "neutral"
    return
  }

  try {
    $script:PendingDockerActions[$Task.id] = Start-BackgroundCommand -Task $Task -Command $Task.docker.downCommand -Suffix "docker-down" -Action "down" -Elevate
  } catch {
    Set-BannerMessage -Message "Docker stop for $($Task.name) was cancelled or failed to request elevation." -Tone "error"
    return
  }
  $script:PendingDockerAutoOpen.Remove($Task.id) | Out-Null
  Set-BannerMessage -Message "Stopping Docker for $($Task.name)." -Tone "neutral"
}

function Invoke-DockerPack {
  param([pscustomobject]$Task)

  $dockerSnapshot = Get-DockerTaskSnapshot -Task $Task
  if (-not $dockerSnapshot.enabled) {
    Set-BannerMessage -Message "Docker mode is not configured for $($Task.name)." -Tone "error"
    return
  }

  if ([string]::IsNullOrWhiteSpace($Task.docker.packCommand)) {
    Set-BannerMessage -Message "No Docker pack command is configured for $($Task.name)." -Tone "error"
    return
  }

  if (-not $dockerSnapshot.canPack) {
    Set-BannerMessage -Message "$($Task.name) is busy. Please wait for the current Docker action to finish." -Tone "neutral"
    return
  }

  try {
    $script:PendingDockerActions[$Task.id] = Start-BackgroundCommand -Task $Task -Command $Task.docker.packCommand -Suffix "docker-pack" -Action "pack" -Elevate
  } catch {
    Set-BannerMessage -Message "Docker pack for $($Task.name) was cancelled or failed to request elevation." -Tone "error"
    return
  }
  $script:PendingDockerPackNotify[$Task.id] = $true
  Clear-CompletedDockerActionRecord -TaskId $Task.id
  Set-BannerMessage -Message "Generating the Docker image tar for $($Task.name). Check the launcher logs for progress." -Tone "neutral"
}

function Get-StatusBrushSet {
  param([string]$StatusKey)

  switch ($StatusKey) {
    "running" {
      return @{
        Background = "#DFF7EE"
        Foreground = "#0B7A5A"
        Border = "#95DDBF"
      }
    }
    "starting" {
      return @{
        Background = "#FFF1D9"
        Foreground = "#A45B00"
        Border = "#F2CA7C"
      }
    }
    "external" {
      return @{
        Background = "#E8EEFF"
        Foreground = "#365BBC"
        Border = "#B5C6FF"
      }
    }
    default {
      return @{
        Background = "#F3F1F7"
        Foreground = "#686781"
        Border = "#D6D3E4"
      }
    }
  }
}

function New-Badge {
  param([string]$Text)

  $badge = New-Object System.Windows.Controls.Border
  $badge.Margin = "0,0,8,8"
  $badge.Padding = "12,6,12,6"
  $badge.CornerRadius = "999"
  $badge.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#F2F0F8")

  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = $Text
  $label.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#5E5E72")
  $label.FontWeight = "SemiBold"
  $badge.Child = $label

  return $badge
}

function New-TaskCard {
  param([pscustomobject]$Task)

  $cardXaml = @"
<Border xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Margin="0,0,0,18"
        Padding="24"
        CornerRadius="28"
        BorderBrush="#D8D4E8"
        BorderThickness="1"
        Background="#FFFDFB">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="*" />
      <ColumnDefinition Width="Auto" />
    </Grid.ColumnDefinitions>

    <StackPanel Grid.Row="0" Grid.Column="0" Margin="0,0,18,0">
      <TextBlock x:Name="TaskName"
                 FontSize="26"
                 FontWeight="Bold"
                 Foreground="#181624"
                 Text="$(Escape-XmlText $Task.name)" />
      <TextBlock x:Name="TaskProject"
                 Margin="0,6,0,0"
                 FontSize="13"
                 FontWeight="SemiBold"
                 Foreground="#A55C17"
                 Text="$(Escape-XmlText $Task.projectName)" />
      <TextBlock x:Name="TaskDescription"
                 Margin="0,10,0,0"
                 TextWrapping="Wrap"
                 FontSize="14"
                 Foreground="#66657A"
                 Text="$(Escape-XmlText $Task.description)" />
    </StackPanel>

    <Border x:Name="StatusBadge"
            Grid.Row="0"
            Grid.Column="1"
            Padding="14,8,14,8"
            CornerRadius="999"
            Background="#F3F1F7"
            BorderBrush="#D6D3E4"
            BorderThickness="1"
            VerticalAlignment="Top">
      <TextBlock x:Name="StatusText"
                 FontWeight="Bold"
                 Foreground="#686781"
                 Text="Stopped" />
    </Border>

    <WrapPanel x:Name="MetaHost"
               Grid.Row="1"
               Grid.ColumnSpan="2"
               Margin="0,18,0,0" />

    <Grid Grid.Row="2" Grid.ColumnSpan="2" Margin="0,18,0,0">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto" />
        <RowDefinition Height="Auto" />
        <RowDefinition Height="Auto" />
      </Grid.RowDefinitions>
      <DockPanel Grid.Row="0" LastChildFill="True">
        <TextBlock x:Name="TaskPath"
                   FontSize="13"
                   Foreground="#7A788B"
                   TextWrapping="Wrap"
                   VerticalAlignment="Center"
                   Text="$(Escape-XmlText $Task.workingDirectory)" />
      </DockPanel>
      <StackPanel Grid.Row="1" Margin="0,16,0,0">
        <TextBlock x:Name="TaskDetails"
                   FontSize="13"
                   Foreground="#5E5E72"
                   Text="Local: Command $(Escape-XmlText $Task.command)" />
        <TextBlock x:Name="DockerDetails"
                   Margin="0,6,0,0"
                   FontSize="13"
                   Foreground="#5E5E72"
                   Text="Docker: Not configured" />
      </StackPanel>
      <WrapPanel Grid.Row="2" Margin="0,16,0,0" HorizontalAlignment="Left">
        <Button x:Name="StartButton"
                Width="110"
                Height="40"
                Margin="0,0,10,10"
                BorderThickness="0"
                Cursor="Hand"
                Background="#1B1A28"
                Foreground="White"
                Content="Start Local" />
        <Button x:Name="StopButton"
                Width="100"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderBrush="#E4C2C2"
                BorderThickness="1"
                Background="#FFF3F3"
                Foreground="#A14141"
                Content="Stop Local" />
        <Button x:Name="LogButton"
                Width="92"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderBrush="#D0CBDD"
                BorderThickness="1"
                Background="#FFFFFF"
                Foreground="#4D4A63"
                Content="Local Logs" />
        <Button x:Name="DockerUpButton"
                Width="108"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderThickness="0"
                Background="#243A72"
                Foreground="White"
                Content="Docker Up" />
        <Button x:Name="DockerDownButton"
                Width="118"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderBrush="#BFD0FF"
                BorderThickness="1"
                Background="#EFF3FF"
                Foreground="#294799"
                Content="Docker Down" />
        <Button x:Name="DockerLogsButton"
                Width="110"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderBrush="#D0CBDD"
                BorderThickness="1"
                Background="#FFFFFF"
                Foreground="#4D4A63"
                Content="Docker Logs" />
        <Button x:Name="DockerPackButton"
                Width="112"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderThickness="0"
                Background="#0E6A61"
                Foreground="White"
                Content="Pack Tar" />
        <Button x:Name="OpenButton"
                Width="92"
                Height="40"
                Margin="0,0,10,10"
                Cursor="Hand"
                BorderBrush="#D0CBDD"
                BorderThickness="1"
                Background="#F8F5FF"
                Foreground="#2E2B45"
                Content="Open" />
      </WrapPanel>
    </Grid>
  </Grid>
</Border>
"@

  [xml]$cardXml = $cardXaml
  $reader = New-Object System.Xml.XmlNodeReader $cardXml
  $card = [Windows.Markup.XamlReader]::Load($reader)

  $metaHost = $card.FindName("MetaHost")
  foreach ($tag in @($Task.tags)) {
    $metaHost.Children.Add((New-Badge -Text $tag)) | Out-Null
  }

  if ($Task.port) {
    $metaHost.Children.Add((New-Badge -Text "Port $($Task.port)")) | Out-Null
  }

  $script:CardRefs[$Task.id] = @{
    Root = $card
    StatusBadge = $card.FindName("StatusBadge")
    StatusText = $card.FindName("StatusText")
    TaskDetails = $card.FindName("TaskDetails")
    DockerDetails = $card.FindName("DockerDetails")
    StartButton = $card.FindName("StartButton")
    StopButton = $card.FindName("StopButton")
    OpenButton = $card.FindName("OpenButton")
    LogButton = $card.FindName("LogButton")
    DockerUpButton = $card.FindName("DockerUpButton")
    DockerDownButton = $card.FindName("DockerDownButton")
    DockerLogsButton = $card.FindName("DockerLogsButton")
    DockerPackButton = $card.FindName("DockerPackButton")
  }

  $script:CardRefs[$Task.id].StartButton.Add_Click({
    Invoke-StartAndOpen -Task $Task
    Update-TaskViews -Tasks $script:CurrentConfig.tasks
  })

  $script:CardRefs[$Task.id].StopButton.Add_Click({
    if (Stop-ManagedTask -Task $Task) {
      Set-BannerMessage -Message "$($Task.name) has been stopped." -Tone "success"
    } else {
      Set-BannerMessage -Message "$($Task.name) has no managed process to stop." -Tone "neutral"
    }
    Update-TaskViews -Tasks $script:CurrentConfig.tasks
  })

  $script:CardRefs[$Task.id].OpenButton.Add_Click({
    Open-TaskTarget -Task $Task
  })

  $script:CardRefs[$Task.id].LogButton.Add_Click({
    Open-TaskLog -Task $Task
  })

  $script:CardRefs[$Task.id].DockerUpButton.Add_Click({
    Invoke-DockerUpAndOpen -Task $Task
    Update-TaskViews -Tasks $script:CurrentConfig.tasks
  })

  $script:CardRefs[$Task.id].DockerDownButton.Add_Click({
    Invoke-DockerDown -Task $Task
    Update-TaskViews -Tasks $script:CurrentConfig.tasks
  })

  $script:CardRefs[$Task.id].DockerLogsButton.Add_Click({
    Open-DockerLogs -Task $Task
  })

  $script:CardRefs[$Task.id].DockerPackButton.Add_Click({
    Invoke-DockerPack -Task $Task
    Update-TaskViews -Tasks $script:CurrentConfig.tasks
  })

  return $card
}

function Update-TaskView {
  param([pscustomobject]$Snapshot)

  $refs = $script:CardRefs[$Snapshot.task.id]
  if (-not $refs) {
    return
  }

  $brushSet = Get-StatusBrushSet -StatusKey $Snapshot.statusKey
  $refs.StatusBadge.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString($brushSet.Background)
  $refs.StatusBadge.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($brushSet.Border)
  $refs.StatusText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($brushSet.Foreground)
  $refs.StatusText.Text = $Snapshot.statusText
  $refs.TaskDetails.Text = "Local: $($Snapshot.local.detailText)"
  $refs.DockerDetails.Text = "Docker: $($Snapshot.docker.detailText)"
  $refs.StartButton.IsEnabled = $Snapshot.local.canStart
  $refs.StopButton.IsEnabled = $Snapshot.local.canStop
  $refs.OpenButton.IsEnabled = -not [string]::IsNullOrWhiteSpace($Snapshot.task.openUrl)
  $refs.LogButton.IsEnabled = $true
  $refs.DockerUpButton.IsEnabled = $Snapshot.docker.canStart
  $refs.DockerDownButton.IsEnabled = $Snapshot.docker.canStop
  $refs.DockerLogsButton.IsEnabled = $Snapshot.docker.canLogs
  $refs.DockerPackButton.IsEnabled = $Snapshot.docker.canPack
}

function Update-TaskViews {
  param([object[]]$Tasks)

  $snapshots = @()
  foreach ($task in $Tasks) {
    $snapshot = Get-CombinedTaskSnapshot -Task $task
    $snapshots += $snapshot
    Update-TaskView -Snapshot $snapshot

    if ($script:PendingAutoOpen.ContainsKey($task.id) -and $snapshot.local.healthy) {
      Open-TaskTarget -Task $task
      $script:PendingAutoOpen.Remove($task.id) | Out-Null
      Set-BannerMessage -Message "$($task.name) is ready and the page has been opened." -Tone "success"
    }

    if ($script:PendingDockerAutoOpen.ContainsKey($task.id) -and $snapshot.docker.running) {
      Open-DockerTarget -Task $task
      $script:PendingDockerAutoOpen.Remove($task.id) | Out-Null
      Set-BannerMessage -Message "$($task.name) Docker stack is ready and the page has been opened." -Tone "success"
    }

    $actionRecord = Get-BackgroundActionRecord -TaskId $task.id
    $completedAction = Get-CompletedDockerActionRecord -TaskId $task.id
    if ($script:PendingDockerPackNotify.ContainsKey($task.id) -and -not $actionRecord -and $completedAction -and $completedAction.action -eq "pack") {
      $script:PendingDockerPackNotify.Remove($task.id) | Out-Null
      if ($completedAction.exitCode -eq 0 -and (Test-ActionOutputIsFresh -ActionRecord $completedAction -OutputPath $task.docker.packOutputPath)) {
        Open-DockerPackOutput -Task $task
        Set-BannerMessage -Message "$($task.name) Docker image tar has been generated." -Tone "success"
      } else {
        $stderrPath = $completedAction.stderrPath
        if ([string]::IsNullOrWhiteSpace($stderrPath)) {
          Set-BannerMessage -Message "$($task.name) Docker image tar failed to generate. Check the launcher logs for details." -Tone "error"
        } else {
          Set-BannerMessage -Message "$($task.name) Docker image tar failed. Review $stderrPath for details." -Tone "error"
        }
      }
      Clear-CompletedDockerActionRecord -TaskId $task.id
    }
  }

  if ($script:SummaryText) {
    $localCount = @($snapshots | Where-Object { $_.local.statusKey -in @("running", "starting", "external") }).Count
    $dockerCount = @($snapshots | Where-Object { $_.docker.statusKey -in @("running", "starting", "stopping") }).Count
    $script:SummaryText.Text = "$($Tasks.Count) tasks total. Local active: $localCount. Docker active: $dockerCount."
  }
}

function Invoke-SmokeTest {
  param([pscustomobject]$Config)

  Write-Output "Launcher: $($Config.launcherName)"
  Write-Output "Tasks: $($Config.tasks.Count)"

  foreach ($task in $Config.tasks) {
    $snapshot = Get-CombinedTaskSnapshot -Task $task
    Write-Output "[$($task.id)] $($task.name)"
    Write-Output "  WorkingDirectory: $($task.workingDirectory)"
    Write-Output "  Local: $($snapshot.local.statusText)"
    Write-Output "  Docker: $($snapshot.docker.statusText)"
  }
}

function Invoke-CliMode {
  param([pscustomobject]$Config)

  if ($SmokeTest) {
    Invoke-SmokeTest -Config $Config
  }

  if ($StartTask) {
    $task = $Config.tasks | Where-Object { $_.id -eq $StartTask } | Select-Object -First 1
    if (-not $task) {
      throw "Task not found: $StartTask"
    }

    $result = Start-ManagedTask -Task $task
    if ($result.started) {
      Write-Output "Started $($task.name)"
    } else {
      Write-Output "$($task.name) is already running"
    }
  }

  if ($StopTask) {
    $task = $Config.tasks | Where-Object { $_.id -eq $StopTask } | Select-Object -First 1
    if (-not $task) {
      throw "Task not found: $StopTask"
    }

    if (Stop-ManagedTask -Task $task) {
      Write-Output "Stopped $($task.name)"
    } else {
      Write-Output "$($task.name) has no managed process"
    }
  }

  if ($OpenTask) {
    $task = $Config.tasks | Where-Object { $_.id -eq $OpenTask } | Select-Object -First 1
    if (-not $task) {
      throw "Task not found: $OpenTask"
    }

    Open-TaskTarget -Task $task
    Write-Output "Opened $($task.name)"
  }
}

$script:CurrentConfig = Get-LauncherConfig

if ($SmokeTest -or $StartTask -or $StopTask -or $OpenTask -or $NoUI) {
  Invoke-CliMode -Config $script:CurrentConfig
  if ($NoUI -or $SmokeTest) {
    return
  }
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$windowXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Workspace Launch Deck"
        Width="1180"
        Height="860"
        WindowStartupLocation="CenterScreen"
        ResizeMode="CanResize"
        Background="#F7F2EA">
  <Grid Margin="24">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="*" />
      <RowDefinition Height="Auto" />
    </Grid.RowDefinitions>

    <Border Grid.Row="0"
            Padding="28"
            CornerRadius="32"
            BorderThickness="1"
            BorderBrush="#DED7E5">
      <Border.Background>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
          <GradientStop Color="#FFF6E7" Offset="0" />
          <GradientStop Color="#F5F6FF" Offset="1" />
        </LinearGradientBrush>
      </Border.Background>
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*" />
          <ColumnDefinition Width="Auto" />
        </Grid.ColumnDefinitions>
        <StackPanel Grid.Column="0">
          <TextBlock Text="LOCAL PROJECT DESK"
                     Foreground="#B15F17"
                     FontSize="12"
                     FontWeight="Bold" />
          <TextBlock x:Name="LauncherTitle"
                     Margin="0,10,0,0"
                     FontSize="38"
                     FontWeight="Bold"
                     Foreground="#171523" />
          <TextBlock x:Name="LauncherDescription"
                     Margin="0,12,0,0"
                     FontSize="15"
                     Foreground="#66657A"
                     TextWrapping="Wrap" />
          <TextBlock x:Name="SummaryText"
                     Margin="0,18,0,0"
                     FontSize="14"
                     FontWeight="SemiBold"
                     Foreground="#322F47" />
        </StackPanel>
        <StackPanel Grid.Column="1"
                    Orientation="Horizontal"
                    VerticalAlignment="Bottom">
          <Button x:Name="LanSettingsButton"
                  Width="118"
                  Height="42"
                  Margin="0,0,12,0"
                  Cursor="Hand"
                  BorderBrush="#D2CBDF"
                  BorderThickness="1"
                  Background="#FFFFFF"
                  Foreground="#2F2C45"
                  Content="LAN Settings" />
          <Button x:Name="RefreshButton"
                  Width="98"
                  Height="42"
                  Margin="0,0,12,0"
                  Cursor="Hand"
                  BorderBrush="#D2CBDF"
                  BorderThickness="1"
                  Background="#FFFFFF"
                  Foreground="#2F2C45"
                  Content="Refresh" />
          <Button x:Name="StartAllButton"
                  Width="116"
                  Height="42"
                  Cursor="Hand"
                  BorderThickness="0"
                  Background="#1B1A28"
                  Foreground="White"
                  Content="Start All Local" />
        </StackPanel>
      </Grid>
    </Border>

    <ScrollViewer Grid.Row="1"
                  Margin="0,18,0,18"
                  VerticalScrollBarVisibility="Auto">
      <StackPanel x:Name="TasksHost" />
    </ScrollViewer>

    <Border Grid.Row="2"
            Padding="18,14,18,14"
            CornerRadius="18"
            Background="#FFFDFC"
            BorderBrush="#E2DDE8"
            BorderThickness="1">
      <DockPanel LastChildFill="True">
        <TextBlock x:Name="FooterText"
                   Foreground="#6A687D"
                   FontSize="13"
                   VerticalAlignment="Center"
                   Text="Add more tasks later by editing launcher/LauncherConfig.json." />
        <TextBlock x:Name="StatusBanner"
                   DockPanel.Dock="Right"
                   Foreground="#5E5E72"
                   FontSize="13"
                   FontWeight="SemiBold"
                   VerticalAlignment="Center"
                   Text="Launcher ready." />
      </DockPanel>
    </Border>
  </Grid>
</Window>
"@

[xml]$windowXml = $windowXaml
$windowReader = New-Object System.Xml.XmlNodeReader $windowXml
$window = [Windows.Markup.XamlReader]::Load($windowReader)

$tasksHost = $window.FindName("TasksHost")
$lanSettingsButton = $window.FindName("LanSettingsButton")
$refreshButton = $window.FindName("RefreshButton")
$startAllButton = $window.FindName("StartAllButton")
$launcherTitle = $window.FindName("LauncherTitle")
$launcherDescription = $window.FindName("LauncherDescription")
$script:SummaryText = $window.FindName("SummaryText")
$script:StatusBanner = $window.FindName("StatusBanner")

$launcherTitle.Text = $script:CurrentConfig.launcherName
if ([string]::IsNullOrWhiteSpace($script:CurrentConfig.description)) {
  $launcherDescription.Text = "One-click start for the current project, with room to grow into a multi-task launcher."
} else {
  $launcherDescription.Text = $script:CurrentConfig.description
}

foreach ($task in $script:CurrentConfig.tasks) {
  $tasksHost.Children.Add((New-TaskCard -Task $task)) | Out-Null
}

if ($ValidateUI) {
  Update-TaskViews -Tasks $script:CurrentConfig.tasks
  Write-Output "UI validation passed"
  return
}

$lanSettingsButton.Add_Click({
  Show-NetworkSettingsDialog -Tasks $script:CurrentConfig.tasks
})

$refreshButton.Add_Click({
  Update-TaskViews -Tasks $script:CurrentConfig.tasks
  Set-BannerMessage -Message "Status refreshed." -Tone "neutral"
})

$startAllButton.Add_Click({
  $startedCount = 0
  foreach ($task in $script:CurrentConfig.tasks) {
    $result = Start-ManagedTask -Task $task
    if ($result.started) {
      $script:PendingAutoOpen[$task.id] = $true
      $startedCount += 1
    }
  }

  if ($startedCount -gt 0) {
    Set-BannerMessage -Message "Started $startedCount task(s). Pages will open automatically when ready." -Tone "neutral"
  } else {
    Set-BannerMessage -Message "No additional tasks needed to be started." -Tone "neutral"
  }

  Update-TaskViews -Tasks $script:CurrentConfig.tasks
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({
  Update-TaskViews -Tasks $script:CurrentConfig.tasks
})

$window.Add_SourceInitialized({
  Update-TaskViews -Tasks $script:CurrentConfig.tasks
  Set-BannerMessage -Message "Launcher is ready. You can start the project with one click." -Tone "success"
  $timer.Start()
})

$window.Add_Closed({
  $timer.Stop()
})

[void]$window.ShowDialog()
