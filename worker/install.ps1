param(
    [string]$InstallDir = "C:\GeminiResearchBridge",
    [string]$BridgeUrl,
    [string]$Model
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkerSource = Join-Path $SourceDir "worker.ps1"
if (-not (Test-Path $WorkerSource)) { throw "worker.ps1 was not found next to install.ps1." }

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path $WorkerSource -Destination (Join-Path $InstallDir "worker.ps1") -Force

if (-not [string]::IsNullOrWhiteSpace($BridgeUrl)) {
    [Environment]::SetEnvironmentVariable("GEMINI_BRIDGE_URL", $BridgeUrl.TrimEnd('/'), "User")
}
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    [Environment]::SetEnvironmentVariable("GEMINI_MODEL", $Model, "User")
}

Write-Host ""
Write-Host "Gemini Research Bridge worker installed to:"
Write-Host "  $InstallDir\worker.ps1"
Write-Host ""
Write-Host "Required user environment variables:"
Write-Host "  GEMINI_BRIDGE_URL"
Write-Host "  GEMINI_BRIDGE_WORKER_TOKEN"
Write-Host ""
Write-Host "Optional:"
Write-Host "  GEMINI_MODEL"
Write-Host ""
Write-Host "Set the worker token without putting it in this repository:"
Write-Host '  [Environment]::SetEnvironmentVariable("GEMINI_BRIDGE_WORKER_TOKEN", "<token>", "User")'
Write-Host ""
Write-Host "Open a new PowerShell window after changing user environment variables, then run:"
Write-Host "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $InstallDir\worker.ps1"
