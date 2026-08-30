$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-EnvironmentInteger {
    param([string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum)
    $rawValue = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($rawValue)) { return $Default }
    $parsedValue = 0
    if (-not [int]::TryParse($rawValue, [ref]$parsedValue) -or $parsedValue -lt $Minimum -or $parsedValue -gt $Maximum) {
        throw "$Name must be an integer from $Minimum to $Maximum."
    }
    return $parsedValue
}

function Get-PropertyValue {
    param([AllowNull()][object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Convert-ModelResponseToJson {
    param([string]$Text)
    $candidate = $Text.Trim()
    if ($candidate.StartsWith("```")) {
        $candidate = $candidate -replace '^```(?:json)?\s*', ''
        $candidate = $candidate -replace '\s*```$', ''
        $candidate = $candidate.Trim()
    }
    try {
        return $candidate | ConvertFrom-Json -Depth 100
    }
    catch {
        throw "Non-retryable: model response was not valid JSON. Response: $candidate"
    }
}

$BridgeUrl = $env:GEMINI_BRIDGE_URL
$Token = $env:GEMINI_BRIDGE_WORKER_TOKEN
if ([string]::IsNullOrWhiteSpace($BridgeUrl)) { throw "GEMINI_BRIDGE_URL environment variable is missing." }
if ([string]::IsNullOrWhiteSpace($Token)) { throw "GEMINI_BRIDGE_WORKER_TOKEN environment variable is missing." }
$BridgeUrl = $BridgeUrl.TrimEnd('/')

$WorkerId = if ([string]::IsNullOrWhiteSpace($env:GEMINI_WORKER_ID)) { "$env:COMPUTERNAME-$PID" } else { $env:GEMINI_WORKER_ID }
$LeaseSeconds = Get-EnvironmentInteger "GEMINI_LEASE_SECONDS" 300 60 1800
$HeartbeatSeconds = Get-EnvironmentInteger "GEMINI_HEARTBEAT_SECONDS" 60 10 900
$JobTimeoutSeconds = Get-EnvironmentInteger "GEMINI_JOB_TIMEOUT_SECONDS" 3600 60 14400
$IdleSeconds = Get-EnvironmentInteger "GEMINI_IDLE_SECONDS" 5 1 300
$MaxPromptCharacters = Get-EnvironmentInteger "GEMINI_MAX_PROMPT_CHARACTERS" 100000 1000 250000
$Model = $env:GEMINI_MODEL

if ($HeartbeatSeconds -ge $LeaseSeconds) { throw "GEMINI_HEARTBEAT_SECONDS must be less than GEMINI_LEASE_SECONDS." }

$agyCommand = Get-Command "agy" -ErrorAction Stop
$AgyPath = $agyCommand.Source
if ([string]::IsNullOrWhiteSpace($AgyPath)) { $AgyPath = $agyCommand.Definition }

$Headers = @{
    "Authorization" = "Bearer $Token"
    "Content-Type"  = "application/json"
}

function Invoke-Bridge {
    param(
        [string]$Path,
        [hashtable]$Body
    )
    $json = $Body | ConvertTo-Json -Depth 100 -Compress
    return Invoke-RestMethod -Uri "$BridgeUrl$Path" -Method Post -Headers $Headers -Body $json -TimeoutSec 60
}

Write-Host ""
Write-Host "Gemini Research Bridge Worker"
Write-Host "Worker: $WorkerId"
Write-Host "Bridge: $BridgeUrl"
Write-Host "Lease: $LeaseSeconds seconds; heartbeat: $HeartbeatSeconds seconds"
if (-not [string]::IsNullOrWhiteSpace($Model)) { Write-Host "Model override: $Model" }
Write-Host ""
Write-Host "Waiting for research jobs..."
Write-Host ""

while ($true) {
    $job = $null
    $agyBackgroundJob = $null

    try {
        $claim = Invoke-Bridge "/v1/worker/claim" @{
            worker_id     = $WorkerId
            lease_seconds = $LeaseSeconds
        }
        $job = Get-PropertyValue $claim "job"
        if ($null -eq $job) {
            Start-Sleep -Seconds $IdleSeconds
            continue
        }

        $jobId = [string](Get-PropertyValue $job "id")
        $claimToken = [string](Get-PropertyValue $job "claim_token")
        $prompt = [string](Get-PropertyValue $job "prompt")
        if ([string]::IsNullOrWhiteSpace($jobId)) { throw "Non-retryable: claimed job has no id." }
        if ([string]::IsNullOrWhiteSpace($claimToken)) { throw "Non-retryable: claimed job has no claim token." }
        if ([string]::IsNullOrWhiteSpace($prompt)) { throw "Non-retryable: claimed job has no prompt." }
        if ($prompt.Length -gt $MaxPromptCharacters) {
            throw "Non-retryable: job $jobId prompt has $($prompt.Length) characters; limit is $MaxPromptCharacters."
        }

        Write-Host "Running job $jobId"

        $agyArgs = @("-p", $prompt, "--output-format", "json")
        if (-not [string]::IsNullOrWhiteSpace($Model)) {
            $agyArgs += @("--model", $Model)
        }

        $argumentsJson = ConvertTo-Json -InputObject @($agyArgs) -Compress
        $agyBackgroundJob = Start-Job -ScriptBlock {
            param($CommandPath, $ArgumentsJson)
            $commandArguments = @($ArgumentsJson | ConvertFrom-Json)
            $capturedOutput = & $CommandPath @commandArguments 2>&1
            $nativeExitCode = $LASTEXITCODE
            [PSCustomObject]@{
                output    = ($capturedOutput | Out-String).Trim()
                exit_code = $nativeExitCode
            }
        } -ArgumentList $AgyPath, $argumentsJson

        $runTimer = [System.Diagnostics.Stopwatch]::StartNew()
        $nextHeartbeatAt = $HeartbeatSeconds
        while ($null -eq (Wait-Job -Job $agyBackgroundJob -Timeout 5)) {
            if ($runTimer.Elapsed.TotalSeconds -ge $JobTimeoutSeconds) {
                Stop-Job -Job $agyBackgroundJob
                throw "Non-retryable: agy exceeded the $JobTimeoutSeconds second job timeout."
            }

            if ($runTimer.Elapsed.TotalSeconds -ge $nextHeartbeatAt) {
                try {
                    Invoke-Bridge "/v1/worker/jobs/$jobId/heartbeat" @{
                        worker_id     = $WorkerId
                        claim_token   = $claimToken
                        lease_seconds = $LeaseSeconds
                    } | Out-Null
                    $nextHeartbeatAt = $runTimer.Elapsed.TotalSeconds + $HeartbeatSeconds
                }
                catch {
                    Write-Warning "Heartbeat failed: $($_.Exception.Message)"
                    $nextHeartbeatAt = $runTimer.Elapsed.TotalSeconds + 15
                }
            }
        }

        $runTimer.Stop()
        $runResult = Receive-Job -Job $agyBackgroundJob -ErrorAction Stop
        Remove-Job -Job $agyBackgroundJob -Force
        $agyBackgroundJob = $null
        if ($runResult -is [array]) { $runResult = $runResult[-1] }

        $raw = [string](Get-PropertyValue $runResult "output")
        $exitCode = [int](Get-PropertyValue $runResult "exit_code")
        if ($exitCode -ne 0) { throw "agy exited with code $exitCode. Output: $raw" }

        try { $agyResult = $raw | ConvertFrom-Json -Depth 100 }
        catch { throw "agy returned invalid wrapper JSON: $raw" }

        $response = [string](Get-PropertyValue $agyResult "response")
        if ([string]::IsNullOrWhiteSpace($response)) { throw "agy returned JSON without a response." }
        $proposal = Convert-ModelResponseToJson $response

        Invoke-Bridge "/v1/worker/jobs/$jobId/propose" @{
            worker_id   = $WorkerId
            claim_token = $claimToken
            result      = $proposal
        } | Out-Null

        Write-Host "Submitted proposal for job $jobId"
        $job = $null
    }
    catch {
        $message = $_.Exception.Message
        if ($message.Length -gt 4000) { $message = $message.Substring(0, 4000) }
        Write-Host "ERROR: $message"

        if ($null -ne $job) {
            $jobId = [string](Get-PropertyValue $job "id")
            $claimToken = [string](Get-PropertyValue $job "claim_token")
            if (-not [string]::IsNullOrWhiteSpace($jobId) -and -not [string]::IsNullOrWhiteSpace($claimToken)) {
                try {
                    Invoke-Bridge "/v1/worker/jobs/$jobId/fail" @{
                        worker_id   = $WorkerId
                        claim_token = $claimToken
                        error       = $message
                        retry       = -not $message.StartsWith("Non-retryable:")
                    } | Out-Null
                }
                catch { Write-Warning "Could not report failed job: $($_.Exception.Message)" }
            }
        }
        Start-Sleep -Seconds $IdleSeconds
    }
    finally {
        if ($null -ne $agyBackgroundJob) {
            Stop-Job -Job $agyBackgroundJob -ErrorAction SilentlyContinue
            Remove-Job -Job $agyBackgroundJob -Force -ErrorAction SilentlyContinue
        }
    }
}
