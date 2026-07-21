$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$entryPoint = Join-Path $projectDir 'dist\index.js'
$logFile = Join-Path $env:LOCALAPPDATA 'Claude Code Discord Presence\supervisor.log'
$maxLogBytes = 1MB

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ClaudeCodeDiscordPresenceSupervisor', [ref]$created)
if (-not $created) { exit 0 }

$logDir = Split-Path -Parent $logFile
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

Set-Location $projectDir

function Rotate-Log {
    try {
        if (-not (Test-Path -LiteralPath $logFile)) { return }
        if ((Get-Item -LiteralPath $logFile).Length -lt $maxLogBytes) { return }
        $archive = "$logFile.1"
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $logFile -Destination $archive -Force
    } catch {}
}

function Write-BoundedLog([string]$message) {
    Rotate-Log
    try { Add-Content -LiteralPath $logFile -Value $message -Encoding UTF8 } catch {}
}

Rotate-Log
$fastExits = 0
while ($true) {
    $startedAt = Get-Date
    & node --disable-warning=ExperimentalWarning --env-file-if-exists=.env --enable-source-maps $entryPoint 2>&1 |
        ForEach-Object { Write-BoundedLog ([string]$_) }
    $exitCode = $LASTEXITCODE
    $uptimeSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
    Write-BoundedLog "[$(Get-Date -Format o)] supervisor: service exited code=$exitCode uptime=${uptimeSeconds}s"
    if ($uptimeSeconds -lt 60) { $fastExits++ } else { $fastExits = 0 }
    $delay = [int][Math]::Min(60, 5 * [Math]::Pow(2, [Math]::Min($fastExits, 4)))
    Start-Sleep -Seconds $delay
}
