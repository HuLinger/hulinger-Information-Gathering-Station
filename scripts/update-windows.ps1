#requires -Version 5.1
<#
.SYNOPSIS
Prepares an independent, validated Windows release while retaining local commits.
.DESCRIPTION
Only the new candidate directory is changed. No services, production settings,
database migrations, deployment source files, or Git history are overwritten.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DeploymentSourcePath,
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [string]$UpstreamRef = 'main',
    [string]$UpstreamRepository = 'https://github.com/HuLinger/hulinger-Information-Gathering-Station.git'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$previousOutputEncoding = [Console]::OutputEncoding
$previousPipelineEncoding = $OutputEncoding
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$savedEnvironment = @{}
$reportDirectory = $null
$commandLog = $null
$source = $null
$sourceHead = $null
$candidate = $null
$stage = 'preflight'
$report = [ordered]@{
    formatVersion = 1
    status = 'preparing'
    startedAt = [DateTime]::UtcNow.ToString('o')
    sourcePath = $null
    candidatePath = $null
    sourceCommit = $null
    upstreamCommit = $null
    candidateCommit = $null
    retainedLocalCommits = @()
    applicationVersion = $null
    nodeVersion = $null
    checks = @()
    databaseIntegrationValidation = 'not_run_requires_an_explicit_isolated_test_database'
    sourceUnchanged = $false
    productionActivated = $false
}

function Write-Utf8([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Get-AbsolutePath([string]$Path) {
    if (-not [System.IO.Path]::IsPathRooted($Path)) { throw 'Use absolute source and candidate paths.' }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath -eq [System.IO.Path]::GetPathRoot($fullPath)) { throw 'A filesystem root is not a deployment or candidate directory.' }
    return $fullPath.TrimEnd([char[]]'\/')
}

function Assert-NoReparseAncestor([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Use real directories, not a symbolic link or junction, for source and candidate paths.'
            }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Test-NestedPath([string]$Child, [string]$Parent) {
    return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
        $Child.StartsWith($Parent + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Native([string]$Executable, [string[]]$Arguments, [switch]$Quiet) {
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Executable @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $before }
    $output = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    if ($commandLog) {
        [System.IO.File]::AppendAllText($commandLog, $output + "`n", $utf8)
    }
    if (-not $Quiet -and $output) { Write-Host $output }
    return @{ Code = $code; Text = $output }
}

function Invoke-Git([string]$Directory, [string[]]$Arguments, [switch]$Quiet) {
    # Trust only the explicitly selected checkout, without changing global Git settings.
    return Invoke-Native $git (@('-c', "safe.directory=$Directory", '-C', $Directory) + $Arguments) -Quiet:$Quiet
}

function Get-GitText([string]$Directory, [string[]]$Arguments) {
    $result = Invoke-Git $Directory $Arguments -Quiet
    if ($result.Code -ne 0) { throw "Git inspection failed (exit $($result.Code))." }
    return $result.Text.Trim()
}

function Require-Git([string]$Directory, [string[]]$Arguments) {
    $result = Invoke-Git $Directory $Arguments
    if ($result.Code -ne 0) { throw "Git operation failed during $stage (exit $($result.Code)). Candidate files are retained." }
}

function Save-Report {
    if ($reportDirectory) {
        Write-Utf8 (Join-Path $reportDirectory 'report.json') (($report | ConvertTo-Json -Depth 8) + "`n")
    }
}

function Assert-SourceUnchanged {
    $head = Get-GitText $source @('rev-parse', 'HEAD')
    $status = Get-GitText $source @('status', '--porcelain', '--untracked-files=normal')
    $report.sourceUnchanged = $head -eq $sourceHead -and -not $status
    if (-not $report.sourceUnchanged) { throw 'Deployment source changed during preparation. Keep production running and review both checkouts.' }
}

try {
    if ($MyInvocation.InvocationName -eq '.') { throw 'Run this script normally; do not dot-source it.' }
    # Remove inherited service credentials and test switches from this process only.
    # No values are displayed, saved, or changed in the machine/user environment.
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $key = [string]$entry.Key
        if ($key -match '^(GIT_|PG|DRIVE_|HUB_|RESTIC_|BETTER_AUTH_|APP_|SITE_|DATABASE_URL$|TEST_DATABASE_URL$|AUTH_TEST_DATABASE_URL$|RUN_DB_TESTS$|COLLECTOR_|CADDY_BINARY$|NODE_ENV$|NODE_OPTIONS$|CI$)' -or
            $key -match '(PASSWORD|SECRET|TOKEN|API_KEY)') {
            $savedEnvironment[$key] = [string]$entry.Value
            [Environment]::SetEnvironmentVariable($key, $null, 'Process')
        }
    }
    if (-not $savedEnvironment.ContainsKey('GIT_TERMINAL_PROMPT')) { $savedEnvironment['GIT_TERMINAL_PROMPT'] = $null }
    if (-not $savedEnvironment.ContainsKey('GIT_MERGE_AUTOEDIT')) { $savedEnvironment['GIT_MERGE_AUTOEDIT'] = $null }
    if (-not $savedEnvironment.ContainsKey('GIT_OPTIONAL_LOCKS')) { $savedEnvironment['GIT_OPTIONAL_LOCKS'] = $null }
    [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT', '0', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_MERGE_AUTOEDIT', 'no', 'Process')
    [Environment]::SetEnvironmentVariable('GIT_OPTIONAL_LOCKS', '0', 'Process')
    [Environment]::SetEnvironmentVariable('CI', '1', 'Process')
    $git = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $source = Get-AbsolutePath $DeploymentSourcePath
    $candidate = Get-AbsolutePath $CandidatePath
    Assert-NoReparseAncestor $source
    Assert-NoReparseAncestor $candidate
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'DeploymentSourcePath must be an existing checkout.' }
    if ((Test-NestedPath $candidate $source) -or (Test-NestedPath $source $candidate)) { throw 'Source and candidate paths must be separate, non-nested directories.' }
    if (Test-Path -LiteralPath $candidate) { throw 'CandidatePath already exists. Choose a new directory; nothing will be deleted.' }
    $candidateParent = [System.IO.Directory]::GetParent($candidate)
    if ($null -eq $candidateParent -or -not (Test-Path -LiteralPath $candidateParent.FullName -PathType Container)) {
        throw 'Create the intended candidate parent directory first and give the operator access to it.'
    }
    $actualRoot = Get-AbsolutePath (Get-GitText $source @('rev-parse', '--show-toplevel'))
    if (-not $actualRoot.Equals($source, [StringComparison]::OrdinalIgnoreCase)) { throw 'DeploymentSourcePath must be the repository root, not a directory inside a parent repository.' }
    $sourceHead = Get-GitText $source @('rev-parse', '--verify', 'HEAD')
    if (Get-GitText $source @('status', '--porcelain', '--untracked-files=normal')) {
        throw 'Deployment source contains uncommitted or untracked changes. Commit reviewed source changes on its local branch first; leave private settings outside Git.'
    }
    if ($UpstreamRef -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or
        (Invoke-Git $source @('check-ref-format', '--allow-onelevel', $UpstreamRef) -Quiet).Code -ne 0) {
        throw 'UpstreamRef must be one explicit branch, tag, or commit; refspecs and command options are not accepted.'
    }
    if ([System.IO.Path]::IsPathRooted($UpstreamRepository)) {
        $UpstreamRepository = Get-AbsolutePath $UpstreamRepository
        Assert-NoReparseAncestor $UpstreamRepository
        if (-not (Test-Path -LiteralPath $UpstreamRepository -PathType Container)) { throw 'The explicitly selected local upstream mirror does not exist.' }
    } else {
        $uri = $null
        if (-not [Uri]::TryCreate($UpstreamRepository, [UriKind]::Absolute, [ref]$uri) -or
            $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
            throw 'UpstreamRepository must be an HTTPS URL without embedded credentials, or an absolute local mirror path.'
        }
    }
    $version = Invoke-Native $node @('--version') -Quiet
    if ($version.Code -ne 0 -or $version.Text -notmatch '^v(\d+)\.') { throw 'Cannot determine the installed Node.js version.' }
    if ([int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
    $report.nodeVersion = $version.Text
    $report.sourcePath = $source
    $report.candidatePath = $candidate
    $report.sourceCommit = $sourceHead
    $report.upstreamRef = $UpstreamRef
    $stage = 'clone'
    Write-Host 'Cloning the existing deployment into an independent candidate...'
    $cloned = Invoke-Native $git @('-c', "safe.directory=$source", 'clone', '--config', 'core.autocrlf=false', '--no-local', '--no-hardlinks', '--', $source, $candidate)
    if ($cloned.Code -ne 0) { throw 'Candidate clone failed. Any partial candidate was retained; production was not changed.' }
    $reportDirectory = Join-Path $candidate '.deploy/windows-update'
    [void][System.IO.Directory]::CreateDirectory($reportDirectory)
    $commandLog = Join-Path $reportDirectory 'commands.log'
    [System.IO.File]::AppendAllText((Join-Path $candidate '.git/info/exclude'), "`n/.deploy/`n", $utf8)
    if ((Get-GitText $candidate @('rev-parse', 'HEAD')) -ne $sourceHead) { throw 'Source HEAD changed while cloning. Keep this candidate for review and prepare a new one.' }
    Require-Git $candidate @('remote', 'remove', 'origin')
    Require-Git $candidate @('remote', 'add', 'upstream', $UpstreamRepository)
    # A preparation checkout must not accidentally push private deployment commits.
    Require-Git $candidate @('remote', 'set-url', '--push', 'upstream', 'disabled://candidate-read-only')
    Require-Git $candidate @('config', '--local', 'core.autocrlf', 'false')
    $branch = 'codex/chore/windows-candidate-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    Require-Git $candidate @('switch', '-c', $branch)
    $stage = 'fetch'
    Require-Git $candidate @('fetch', '--no-tags', 'upstream', $UpstreamRef)
    $upstreamHead = Get-GitText $candidate @('rev-parse', '--verify', 'FETCH_HEAD^{commit}')
    $report.upstreamCommit = $upstreamHead
    $localHistory = Get-GitText $candidate @('rev-list', "$upstreamHead..$sourceHead")
    $report.retainedLocalCommits = @($localHistory -split "`n" | Where-Object { $_ })
    Save-Report
    $stage = 'merge'
    Require-Git $candidate @('-c', 'user.name=Hulinger candidate updater', '-c', 'user.email=hulinger-candidate@localhost',
        'merge', '--no-ff', '--no-edit', '-m', 'chore(deploy): Merge upstream into Windows candidate', $upstreamHead)
    $mergedHead = Get-GitText $candidate @('rev-parse', 'HEAD')
    Require-Git $candidate @('merge-base', '--is-ancestor', $sourceHead, $mergedHead)
    Require-Git $candidate @('merge-base', '--is-ancestor', $upstreamHead, $mergedHead)
    $report.candidateCommit = $mergedHead
    # Reject a committed environment file before Next/npm can load it.
    $tracked = (Get-GitText $candidate @('ls-files')) -split "`n"
    foreach ($file in $tracked) {
        $name = [System.IO.Path]::GetFileName($file)
        if (($name -eq '.env' -or $name.StartsWith('.env.')) -and $name -notmatch '^\.env(?:\.[a-zA-Z0-9_-]+)*\.example$') {
            throw 'A real environment file is tracked in the candidate. Remove it safely before running package commands.'
        }
    }
    $package = Get-Content -LiteralPath (Join-Path $candidate 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $report.applicationVersion = [string]$package.version
    Push-Location -LiteralPath $candidate
    try {
        foreach ($command in @(@('ci'), @('run', 'setup'), @('run', 'check'), @('run', 'build'))) {
            $stage = 'npm ' + ($command -join ' ')
            Write-Host "Running $stage in the candidate..."
            $result = Invoke-Native $npm $command
            $report.checks += [ordered]@{ command = $stage; exitCode = $result.Code; passed = ($result.Code -eq 0) }
            Save-Report
            if ($result.Code -ne 0) { throw "$stage failed (exit $($result.Code)). The candidate is retained and production is untouched." }
        }
    } finally { Pop-Location }
    if (Get-GitText $candidate @('status', '--porcelain', '--untracked-files=normal')) {
        throw 'Validation changed candidate source files. Review and commit those changes, then prepare and validate a new candidate.'
    }
    Assert-SourceUnchanged
    $report.status = 'prepared'
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Save-Report
    $checklist = @"
# Windows candidate prepared; production has not been activated

- Candidate: $candidate
- Application version: $($report.applicationVersion)
- Node.js used for preparation: $($report.nodeVersion)
- Original deployment commit retained: $sourceHead
- Upstream commit included: $upstreamHead
- Candidate merge commit: $mergedHead
- Original checkout verified unchanged. No environment files were copied.
- npm ci, setup, check and build passed; see report.json and commands.log.
- Database integration tests were not enabled. Skipped tests are not passes.

Before switching services, follow docs/windows-update.md in this candidate:
1. Review the merge and your local admin/login tests and Windows configuration.
2. Run database, migration, drive storage and backup/restore checks on isolated test data.
3. Complete a paired encrypted backup and record its snapshot and previous release.
4. Configure the existing service accounts, external environment and drive directory ACLs.
5. Use your existing service management scripts to stop writers, migrate and switch paths.
6. Verify health, login/MFA, collection, upload/resume/download and backup/monitoring.
7. Keep the old source and build. Roll back service paths only while database-compatible.

Do not run a setup/reset-owner command, copy a new .env over production, push this
candidate's local commits, or remove old data. No automatic activation is provided.
"@
    Write-Utf8 (Join-Path $reportDirectory 'NEXT-STEPS.md') ($checklist.Replace("`r`n", "`n") + "`n")
    Write-Host "Candidate prepared: $candidate"
    Write-Host "Version $($report.applicationVersion); local commits retained: $($report.retainedLocalCommits.Count)."
    Write-Host "Review $reportDirectory\NEXT-STEPS.md before using your existing service management scripts."
} catch {
    $failure = $_.Exception.Message
    $report.status = 'failed'
    $report.failedStage = $stage
    $report.failure = $failure
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    if ($sourceHead) {
        try { Assert-SourceUnchanged } catch { $report.sourceUnchanged = $false }
    }
    Save-Report
    Write-Error -ErrorAction Continue ("Windows update preparation stopped during ${stage}: " + $failure)
    if ($reportDirectory) { Write-Host "Candidate and diagnostic report retained: $reportDirectory" }
    exit 1
} finally {
    foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    if (-not $savedEnvironment.ContainsKey('CI')) { [Environment]::SetEnvironmentVariable('CI', $null, 'Process') }
    [Console]::OutputEncoding = $previousOutputEncoding
    $OutputEncoding = $previousPipelineEncoding
}
