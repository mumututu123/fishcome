$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $projectRoot 'test-output'
$testRoot = Join-Path $outputRoot ('.release-' + [Guid]::NewGuid().ToString('N'))
$resolver = Join-Path $projectRoot 'scripts\resolve-release.ps1'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Commit-Fixture($text) {
    Set-Content -LiteralPath (Join-Path $testRoot 'fixture.txt') -Value $text
    git add fixture.txt
    git -c user.name=release-test -c user.email=release-test@example.invalid commit --quiet -m $text
    if ($LASTEXITCODE -ne 0) { throw '测试仓库提交失败' }
    git rev-parse HEAD
}
Push-Location -LiteralPath $testRoot
try {
    git init --quiet
    $first = Commit-Fixture 'first'
    git tag v0.1.0
    $second = Commit-Fixture 'second'
    git -c user.name=release-test -c user.email=release-test@example.invalid tag -a v0.2.0-beta.1 -m beta
    $envFile = Join-Path $testRoot 'github-env.txt'
    $new = & $resolver -Tag ' V1.0.0 ' -EventName workflow_dispatch -RepositoryPath $testRoot -EnvironmentFile $envFile
    Assert ($new.Tag -ceq 'V1.0.0' -and $new.Version -eq '1.0.0' -and $new.Commit -eq $second -and -not $new.TagExists) '无标签手动发布应使用所选提交，支持大写V和首尾空白'
    Assert ((Get-Content -LiteralPath $envFile -Raw).Contains("RELEASE_COMMIT=$second")) '发行提交必须写入后续步骤环境'
    git show-ref --verify --quiet refs/tags/V1.0.0
    Assert ($LASTEXITCODE -eq 1) '构建前不应提前创建新版本标签'
    $existing = & $resolver -Tag v0.1.0 -EventName workflow_dispatch -RepositoryPath $testRoot -EnvironmentFile ''
    Assert ($existing.Commit -eq $first -and $existing.TagExists) '重发已有标签必须构建该标签的提交'
    $annotated = & $resolver -Tag v0.2.0-beta.1 -EventName push -RepositoryPath $testRoot -EnvironmentFile ''
    Assert ($annotated.Commit -eq $second -and $annotated.TagExists) '注解标签推送必须解引用到正确提交'
    foreach ($case in @(@('v9.9.9', 'push'), @('../master', 'workflow_dispatch'), @('v1.0.0;bad', 'workflow_dispatch'))) {
        $rejected = $false
        try { & $resolver -Tag $case[0] -EventName $case[1] -RepositoryPath $testRoot -EnvironmentFile '' | Out-Null } catch { $rejected = $true }
        Assert $rejected '缺失的推送标签或非法版本必须拒绝'
    }
    Write-Output '发行版本解析通过：新标签手动发布、已有标签、注解标签、环境传递和非法输入。'
    $global:LASTEXITCODE = 0
} finally {
    Pop-Location
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTest.StartsWith($outputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedTest) -notmatch '^\.release-[0-9a-f]{32}$') { throw '测试临时目录不在预期范围内' }
    if (Test-Path -LiteralPath $resolvedTest) { Remove-Item -LiteralPath $resolvedTest -Recurse -Force }
}
