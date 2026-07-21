#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runScript = Join-Path $scriptDir 'run-service.ps1'
$stopFile = Join-Path $env:LOCALAPPDATA 'Claude Code Discord Presence\stop.request'
$name = 'ClaudeCodeDiscordPresence'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue

$escapedRunScript = [WildcardPattern]::Escape($runScript)
function Get-PresenceSupervisor {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^(?:powershell|pwsh)\.exe$' -and
        $_.CommandLine -like "*$escapedRunScript*"
    })
}

$supervisors = @(Get-PresenceSupervisor)
if ($supervisors.Count -gt 0) {
    $stopDir = Split-Path -Parent $stopFile
    if (-not (Test-Path -LiteralPath $stopDir)) {
        New-Item -ItemType Directory -Path $stopDir -Force | Out-Null
    }
    [IO.File]::WriteAllText(
        $stopFile,
        [DateTimeOffset]::Now.ToString('O'),
        [Text.UTF8Encoding]::new($false)
    )
    $deadline = [DateTimeOffset]::Now.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $supervisors = @(Get-PresenceSupervisor)
    } while ($supervisors.Count -gt 0 -and [DateTimeOffset]::Now -lt $deadline)
    if ($supervisors.Count -gt 0) {
        throw 'The background service did not stop within 15 seconds.'
    }
} else {
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Removed '$name' from $runKey."
