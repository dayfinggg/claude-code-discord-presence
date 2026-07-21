#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$name = 'ClaudeCodeDiscordPresence'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
Write-Host "Removed '$name' from $runKey."
