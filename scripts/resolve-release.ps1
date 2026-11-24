param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][ValidateSet('push', 'workflow_dispatch')][string]$EventName,
    [string]$RepositoryPath = (Join-Path $PSScriptRoot '..'),
    [string]$EnvironmentFile = $env:GITHUB_ENV
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$Tag = $Tag.Trim()
if ($Tag -cnotmatch '^[vV]\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$') { throw '请输入版本标签，例如 v0.1.0。' }
Push-Location -LiteralPath $RepositoryPath
try {
    git show-ref --verify --quiet "refs/tags/$Tag"
    $tagExists = $LASTEXITCODE -eq 0
    if ($LASTEXITCODE -notin @(0, 1)) { throw '无法读取仓库版本标签' }
    if ($tagExists) {
        git checkout --detach "refs/tags/$Tag"
        if ($LASTEXITCODE -ne 0) { throw '无法检出版本标签对应的代码' }
    } elseif ($EventName -eq 'push') {
        throw "推送事件的版本标签不存在：$Tag"
    }
    $commit = git rev-parse --verify 'HEAD^{commit}'
    if ($LASTEXITCODE -ne 0 -or $commit -cnotmatch '^[0-9a-f]{40}$') { throw '无法确定发行提交' }
    $version = $Tag.Substring(1)
    if ($EnvironmentFile) {
        [IO.File]::AppendAllLines([IO.Path]::GetFullPath($EnvironmentFile), [string[]]@(
            "RELEASE_TAG=$Tag", "RELEASE_VERSION=$version", "RELEASE_COMMIT=$commit", "RELEASE_TAG_EXISTS=$($tagExists.ToString().ToLowerInvariant())"
        ), (New-Object Text.UTF8Encoding($false)))
    }
    [PSCustomObject]@{ Tag = $Tag; Version = $version; Commit = $commit; TagExists = $tagExists }
} finally { Pop-Location }
