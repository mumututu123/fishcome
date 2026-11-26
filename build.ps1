param(
    [string]$Version = '',
    [string]$OutputDirectory = '',
    [string]$SourceDirectory = $PSScriptRoot,
    [string]$ArchiveDirectory = '',
    [ValidateSet('windows', 'linux')][string]$TargetOS
)

$ErrorActionPreference = 'Stop'
$projectRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceDirectory)
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$') { throw '发行版本号无效' }
$hostOS, $hostArch = & go env GOHOSTOS GOHOSTARCH
if ($LASTEXITCODE -ne 0) { throw '无法确定 Go 构建环境' }
if (-not $TargetOS) { $TargetOS = $hostOS }
if ($TargetOS -notin @('windows', 'linux')) { throw '请选择 Windows 或 Linux 作为构建目标' }
$TargetOS = $TargetOS.ToLowerInvariant()
$launcherName, $assetPlatform = if ($TargetOS -eq 'windows') { '鱼来.exe', 'windows' } else { 'fishcome', 'linux-amd64' }
$archiveName = "fishcome-$Version-$assetPlatform.zip"

function Resolve-BuildDirectory([string]$Path, [string]$DefaultPath) {
    if (-not $Path) { $Path = $DefaultPath }
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $projectRoot $Path }
    [IO.Path]::GetFullPath($Path)
}
$outputRoot = Resolve-BuildDirectory $OutputDirectory 'dist/鱼来'
$distRoot = Resolve-BuildDirectory $ArchiveDirectory 'dist'
$stagingRoot = Join-Path $distRoot ('.build-' + [Guid]::NewGuid().ToString('N'))
$wwwSource = Join-Path $projectRoot 'www'
$rulesSource = Get-Content -LiteralPath (Join-Path $wwwSource 'rules.js') -Raw -Encoding UTF8
$rulesMatch = [regex]::Match($rulesSource, 'Object\.freeze\((\{[\s\S]*?\})\)')
if (-not $rulesMatch.Success) { throw '无法从 www/rules.js 解析联机规则版本' }
$rulesObject = $rulesMatch.Groups[1].Value | ConvertFrom-Json
foreach ($prop in $rulesObject.PSObject.Properties) {
    if ($prop.Value -isnot [int] -and $prop.Value -isnot [long]) { throw "联机规则版本字段必须为整数：$($prop.Name)" }
}
$rules = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rulesMatch.Groups[1].Value))

New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
try {
    $compiled = Join-Path $stagingRoot 'launcher'
    $launcher = Join-Path $stagingRoot $launcherName
    $archive = Join-Path $stagingRoot $archiveName
    $linkFlags = "-X main.version=$Version -X main.releaseStamp=fishcome-release:$($Version): -X main.buildRules=$rules"
    if ($TargetOS -eq 'windows') { $linkFlags += ' -H=windowsgui' }

    $previousOS, $previousArch, $previousCGO = $env:GOOS, $env:GOARCH, $env:CGO_ENABLED
    try {
        $env:GOOS, $env:GOARCH, $env:CGO_ENABLED = $TargetOS, 'amd64', '0'
        & go -C $projectRoot build -trimpath -ldflags $linkFlags -o $compiled ./launcher
        if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }

        $env:GOOS, $env:GOARCH = $hostOS, $hostArch
        $packaging = Join-Path $PSScriptRoot 'scripts/packaging'
        $packageArgs = @($compiled, $launcher, $wwwSource, $archive)
        if ($TargetOS -eq 'windows') { $packageArgs += $Version }
        & go -C $packaging run -mod=readonly . @packageArgs
        if ($LASTEXITCODE -ne 0) { throw '创建发行包失败' }
    } finally {
        $env:GOOS, $env:GOARCH, $env:CGO_ENABLED = $previousOS, $previousArch, $previousCGO
    }

    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    Copy-Item -LiteralPath $launcher -Destination $outputRoot -Force
    function Copy-ReleaseFiles([string]$Destination) {
        Copy-Item -LiteralPath $wwwSource -Destination $Destination -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $Destination '使用说明.md') -Force
        Copy-Item -LiteralPath (Join-Path $projectRoot '验证记录.md') -Destination (Join-Path $Destination '验证记录.md') -Force
    }
    Copy-ReleaseFiles $outputRoot
    $legacyOutputRoot = Join-Path $projectRoot 'dist/潮生'
    if ($TargetOS -eq 'windows' -and -not $OutputDirectory -and (Test-Path -LiteralPath $legacyOutputRoot -PathType Container)) {
        foreach ($legacyName in @('潮生.exe', '鱼来.exe')) {
            $legacyLauncher = Join-Path $legacyOutputRoot $legacyName
            if (Test-Path -LiteralPath $legacyLauncher -PathType Leaf) {
                Copy-Item -LiteralPath $launcher -Destination $legacyLauncher -Force
            }
        }
        Copy-ReleaseFiles $legacyOutputRoot
        Write-Output "已同步兼容发布目录：$legacyOutputRoot"
    }

    $archivePath = Join-Path $distRoot $archiveName
    Move-Item -LiteralPath $archive -Destination $archivePath -Force
    Write-Output "已构建：$(Join-Path $outputRoot $launcherName)"
    Write-Output "发行包：$archivePath"
    if ($env:GITHUB_ENV) {
        [IO.File]::AppendAllLines($env:GITHUB_ENV, [string[]]@("RELEASE_ARCHIVE=$archivePath", "RELEASE_ASSET_NAME=$archiveName"), (New-Object Text.UTF8Encoding($false)))
    }
} finally {
    $resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
    $expectedParent = $distRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ([IO.Path]::GetDirectoryName($resolvedStaging).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -ne $expectedParent -or [IO.Path]::GetFileName($resolvedStaging) -notmatch '^\.build-[0-9a-f]{32}$') { throw '构建临时目录不在预期范围内' }
    $cleanup = [IO.DirectoryInfo]::new($resolvedStaging)
    if ($cleanup.Exists -and ($cleanup.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        $hidden = ($cleanup.Attributes -band [IO.FileAttributes]::Hidden) -ne 0
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force:$hidden
    }
}
