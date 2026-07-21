#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$launcher = Join-Path $scriptDir 'run-hidden.vbs'
$entryPoint = Join-Path $projectDir 'dist\index.js'
$name = 'ClaudeCodeDiscordPresence'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not available on PATH.'
}
if (-not (Test-Path -LiteralPath $entryPoint)) {
    throw 'Built service not found. Run npm install and npm run build first.'
}

$command = "wscript.exe `"$launcher`""
Set-ItemProperty -Path $runKey -Name $name -Value $command

$escapedEntryPoint = [WildcardPattern]::Escape($entryPoint)
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$escapedEntryPoint*" }
if (-not $existing) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$launcher`"" -WindowStyle Hidden
}

Write-Host "Registered '$name' in $runKey."
Write-Host "Remove it with: Remove-ItemProperty -Path '$runKey' -Name '$name'"
