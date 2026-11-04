#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$repository = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptPath = Join-Path $repository 'scripts/update-windows.ps1'
$shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
$temporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]'\/')
$temporaryRoot = Join-Path $temporaryParent ('hulinger-windows-update-test-' + [Guid]::NewGuid().ToString('N'))
[void][System.IO.Directory]::CreateDirectory($temporaryRoot)
$previousPath = $env:PATH
$oldDatabase = $env:DATABASE_URL
$oldSecret = $env:BETTER_AUTH_SECRET
$oldLog = $env:UPDATE_TEST_LOG
$oldFail = $env:UPDATE_TEST_FAIL
$passed = 0

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Write-Text([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Git([string]$Path, [string[]]$Arguments) {
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $git -C $Path @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $before }
    $text = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    if ($code -ne 0) { throw "Fixture Git command failed: $text" }
    return $text.Trim()
}

function Commit([string]$Path, [string]$Message) {
    $actual = Git $Path @('rev-parse', '--show-toplevel')
    Assert ([System.IO.Path]::GetFullPath($actual) -eq [System.IO.Path]::GetFullPath($Path)) 'Fixture commit escaped its repository root.'
    [void](Git $Path @('add', '--all'))
    [void](Git $Path @('-c', 'user.name=Windows updater test', '-c', 'user.email=fixture@example.test', 'commit', '-m', $Message))
}

function New-Fixture([string]$Name, [switch]$Conflict) {
    $root = Join-Path $temporaryRoot $Name
    $upstream = Join-Path $root 'upstream'
    $source = Join-Path $root ('production source ' + [char]0x6E90)
    $candidate = Join-Path $root ('candidate release ' + [char]0x65B0)
    [void][System.IO.Directory]::CreateDirectory($upstream)
    [void](Git $upstream @('init', '-b', 'main'))
    Write-Text (Join-Path $upstream '.gitignore') ".env`n.deploy/`nnode_modules/`n"
    Write-Text (Join-Path $upstream 'package.json') "{`"name`":`"synthetic-windows-fixture`",`"version`":`"0.1.0`"}`n"
    Write-Text (Join-Path $upstream 'settings.txt') "baseline setting`n"
    Commit $upstream 'chore: Initialize fixture'
    [void](Git $root @('clone', '--no-hardlinks', '--', $upstream, $source))
    Write-Text (Join-Path $source 'local-admin.txt') "synthetic local admin compatibility`n"
    if ($Conflict) { Write-Text (Join-Path $source 'settings.txt') "local change must be reviewed`n" }
    Commit $source 'fix(auth): Retain synthetic local admin behavior'
    $firstLocal = Git $source @('rev-parse', 'HEAD')
    Write-Text (Join-Path $source 'local-tests.txt') "synthetic local regression tests`n"
    Commit $source 'test(auth): Retain synthetic local checks'
    Write-Text (Join-Path $source '.env') "SYNTHETIC_PRIVATE_SETTING=leave-unchanged`n"
    Write-Text (Join-Path $upstream 'package.json') "{`"name`":`"synthetic-windows-fixture`",`"version`":`"0.2.0`"}`n"
    Write-Text (Join-Path $upstream 'drive-feature.txt') "synthetic upstream drive feature`n"
    if ($Conflict) { Write-Text (Join-Path $upstream 'settings.txt') "upstream incompatible change`n" }
    Commit $upstream 'feat(drive): Add synthetic upstream feature'
    return [pscustomobject]@{
        Root = $root; Upstream = $upstream; Source = $source; Candidate = $candidate
        SourceHead = (Git $source @('rev-parse', 'HEAD')); UpstreamHead = (Git $upstream @('rev-parse', 'HEAD'))
        FirstLocal = $firstLocal; Log = (Join-Path $root 'npm-calls.txt')
    }
}

function Run-Updater($Fixture, [string]$Candidate = '') {
    if (-not $Candidate) { $Candidate = $Fixture.Candidate }
    $env:UPDATE_TEST_LOG = $Fixture.Log
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $shell -NoProfile -File $scriptPath -DeploymentSourcePath $Fixture.Source -CandidatePath $Candidate -UpstreamRepository $Fixture.Upstream -UpstreamRef main 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $before }
    return @{ Code = $code; Output = (($lines | ForEach-Object { $_.ToString() }) -join "`n") }
}

function Assert-SourceUntouched($Fixture) {
    Assert ((Git $Fixture.Source @('rev-parse', 'HEAD')) -eq $Fixture.SourceHead) 'Updater changed the deployment HEAD.'
    Assert ((Get-Content -LiteralPath (Join-Path $Fixture.Source '.env') -Raw) -eq "SYNTHETIC_PRIVATE_SETTING=leave-unchanged`n") 'Updater changed private deployment settings.'
}

try {
    $bin = Join-Path $temporaryRoot 'mock executable directory'
    [void][System.IO.Directory]::CreateDirectory($bin)
    # Git and Node are real. Only the npm subprocess is replaced so failure order
    # and credential isolation are deterministic without installing fixture deps.
    Write-Text (Join-Path $bin 'npm.cmd') "@echo off`r`nif defined DATABASE_URL exit /b 88`r`nif defined BETTER_AUTH_SECRET exit /b 89`r`necho %*>>`"%UPDATE_TEST_LOG%`"`r`nif `"%*`"==`"%UPDATE_TEST_FAIL%`" exit /b 41`r`nexit /b 0`r`n"
    $env:PATH = $bin + [System.IO.Path]::PathSeparator + $previousPath
    $env:DATABASE_URL = 'synthetic-production-marker-must-not-reach-npm'
    $env:BETTER_AUTH_SECRET = 'synthetic-secret-marker-must-not-reach-npm'
    $env:UPDATE_TEST_FAIL = ''

    $fixture = New-Fixture 'preserve-two-local-commits'
    $result = Run-Updater $fixture
    Assert ($result.Code -eq 0) $result.Output
    Assert-SourceUntouched $fixture
    Assert (-not (Git $fixture.Source @('status', '--porcelain'))) 'Source acquired untracked or modified files.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture.Candidate '.env'))) 'Private .env was copied into candidate.'
    Assert ((Get-Content -LiteralPath (Join-Path $fixture.Candidate 'local-admin.txt') -Raw) -match 'local admin') 'Local behavior was lost.'
    Assert (Test-Path -LiteralPath (Join-Path $fixture.Candidate 'drive-feature.txt')) 'Upstream feature is absent.'
    [void](Git $fixture.Candidate @('merge-base', '--is-ancestor', $fixture.SourceHead, 'HEAD'))
    [void](Git $fixture.Candidate @('merge-base', '--is-ancestor', $fixture.UpstreamHead, 'HEAD'))
    $report = Get-Content -LiteralPath (Join-Path $fixture.Candidate '.deploy/windows-update/report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($report.status -eq 'prepared' -and $report.sourceUnchanged -and -not $report.productionActivated) 'Preparation report overstates activation or misses preservation.'
    Assert ($report.retainedLocalCommits.Count -eq 2 -and $report.retainedLocalCommits -contains $fixture.FirstLocal) 'Both local commits were not retained.'
    Assert ($report.applicationVersion -eq '0.2.0') 'Candidate version was not reported.'
    Assert (($report.checks.command -join ',') -eq 'npm ci,npm run setup,npm run check,npm run build') 'Validation order changed.'
    Assert ((Git $fixture.Candidate @('remote', 'get-url', '--push', 'upstream')) -eq 'disabled://candidate-read-only') 'Candidate could accidentally push deployment commits.'
    Assert ($env:DATABASE_URL -eq 'synthetic-production-marker-must-not-reach-npm') 'Parent environment was changed.'
    Write-Host 'PASS: divergent upstream plus two local commits, source preservation, isolated package commands and report'
    $passed++

    $fixture = New-Fixture 'dirty-source'
    Write-Text (Join-Path $fixture.Source 'local-tests.txt') "uncommitted user work`n"
    $result = Run-Updater $fixture
    Assert ($result.Code -ne 0 -and -not (Test-Path -LiteralPath $fixture.Candidate)) 'Dirty source was cloned or overwritten.'
    Assert ((Get-Content -LiteralPath (Join-Path $fixture.Source 'local-tests.txt') -Raw) -eq "uncommitted user work`n") 'Dirty work was not preserved.'
    Assert-SourceUntouched $fixture
    Write-Host 'PASS: dirty production source is refused without modifying user work'
    $passed++

    $fixture = New-Fixture 'conflicting-local-commit' -Conflict
    $result = Run-Updater $fixture
    Assert ($result.Code -ne 0) 'Conflicting histories were silently resolved.'
    Assert ((Git $fixture.Candidate @('diff', '--name-only', '--diff-filter=U')) -eq 'settings.txt') 'Merge conflict was not left reviewable in candidate.'
    Assert (-not (Test-Path -LiteralPath $fixture.Log)) 'Package commands ran after a merge conflict.'
    Assert-SourceUntouched $fixture
    $report = Get-Content -LiteralPath (Join-Path $fixture.Candidate '.deploy/windows-update/report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($report.status -eq 'failed' -and $report.failedStage -eq 'merge' -and $report.sourceUnchanged) 'Merge failure report is inaccurate.'
    Write-Host 'PASS: conflict remains only in candidate; production and package commands remain untouched'
    $passed++

    $fixture = New-Fixture 'quality-check-failure'
    $env:UPDATE_TEST_FAIL = 'run check'
    $result = Run-Updater $fixture
    $env:UPDATE_TEST_FAIL = ''
    Assert ($result.Code -ne 0) 'Failed quality check was treated as success.'
    Assert (((Get-Content -LiteralPath $fixture.Log) -join ',') -eq 'ci,run setup,run check') 'Build ran after failed quality check.'
    Assert-SourceUntouched $fixture
    $report = Get-Content -LiteralPath (Join-Path $fixture.Candidate '.deploy/windows-update/report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($report.status -eq 'failed' -and $report.failedStage -eq 'npm run check') 'Quality failure report is inaccurate.'
    Write-Host 'PASS: a failed quality check stops before build and keeps a diagnosable candidate'
    $passed++

    $fixture = New-Fixture 'existing-candidate'
    [void][System.IO.Directory]::CreateDirectory($fixture.Candidate)
    $sentinel = Join-Path $fixture.Candidate 'user-file.txt'
    Write-Text $sentinel 'leave this existing directory alone'
    $result = Run-Updater $fixture
    Assert ($result.Code -ne 0 -and (Get-Content -LiteralPath $sentinel -Raw) -eq 'leave this existing directory alone') 'Existing candidate was modified.'
    Assert-SourceUntouched $fixture
    Write-Host 'PASS: existing candidate is never deleted or reused'
    $passed++

    $fixture = New-Fixture 'nested-candidate'
    $nested = Join-Path $fixture.Source 'release-candidate'
    $result = Run-Updater $fixture $nested
    Assert ($result.Code -ne 0 -and -not (Test-Path -LiteralPath $nested)) 'Candidate was created inside production source.'
    Assert-SourceUntouched $fixture
    Write-Host 'PASS: candidate cannot be nested inside production source'
    $passed++

    $fixture = New-Fixture 'untracked-source'
    Write-Text (Join-Path $fixture.Source 'untracked-personal-change.txt') 'uncommitted local customization'
    $result = Run-Updater $fixture
    Assert ($result.Code -ne 0 -and -not (Test-Path -LiteralPath $fixture.Candidate)) 'Untracked source work was silently dropped.'
    Assert-SourceUntouched $fixture
    Write-Host 'PASS: untracked source work requires review before preparation'
    $passed++

    $fixture = New-Fixture 'junction-parent'
    $realParent = Join-Path $fixture.Root 'real release directory'
    $junction = Join-Path $fixture.Root 'junction release directory'
    [void][System.IO.Directory]::CreateDirectory($realParent)
    [void](New-Item -ItemType Junction -Path $junction -Target $realParent)
    $result = Run-Updater $fixture (Join-Path $junction 'candidate')
    Assert ($result.Code -ne 0 -and -not (Test-Path -LiteralPath (Join-Path $realParent 'candidate'))) 'Candidate followed a junction parent.'
    Assert-SourceUntouched $fixture
    Remove-Item -LiteralPath $junction -Force
    Write-Host 'PASS: junction parent is rejected without writing to its target'
    $passed++

    Write-Host "Windows updater regression tests passed: $passed. Git operations are real; npm execution uses a deterministic fixture."
} finally {
    $env:PATH = $previousPath
    $env:DATABASE_URL = $oldDatabase
    $env:BETTER_AUTH_SECRET = $oldSecret
    $env:UPDATE_TEST_LOG = $oldLog
    $env:UPDATE_TEST_FAIL = $oldFail
    $resolved = [System.IO.Path]::GetFullPath($temporaryRoot)
    $expectedPrefix = $temporaryParent + [System.IO.Path]::DirectorySeparatorChar + 'hulinger-windows-update-test-'
    if (-not $resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Directory]::GetParent($resolved).FullName -ne $temporaryParent) {
        throw 'Refusing cleanup outside the exact isolated test directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
