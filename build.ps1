param(
    [string]$Version = '',
    [string]$OutputDirectory = '',
    [string]$SourceDirectory = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($SourceDirectory)
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$') { throw '发行版本号无效' }
$compilerPath = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) { $compilerPath = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw '未找到 Windows .NET Framework C# 编译器' }
$outputRoot = if (-not $OutputDirectory) { Join-Path $projectRoot 'dist\鱼来' } elseif ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory)) }
$distRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$stagingRoot = Join-Path $distRoot ('.build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
try {
$archiveName = "fishcome-$Version-windows.zip"
$buildInfo = Join-Path $stagingRoot 'BuildInfo.cs'
[IO.File]::WriteAllText($buildInfo, "namespace Tide { static class BuildInfo { public const string Version = `"$Version`"; public const string PackageName = `"$archiveName`"; } }", (New-Object Text.UTF8Encoding($false)))
& $compilerPath /nologo /codepage:65001 /optimize+ /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/out:$stagingRoot\鱼来.exe" "$projectRoot\launcher\Program.cs" $buildInfo
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'www') -Destination $stagingRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $stagingRoot '鱼来.exe') -Destination $outputRoot -Force
Copy-Item -LiteralPath (Join-Path $stagingRoot 'www') -Destination $outputRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $outputRoot '使用说明.md') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot '验证记录.md') -Destination (Join-Path $outputRoot '验证记录.md') -Force
# Older installations run from dist/潮生. Invitation routing needs matching web assets and launcher.
$legacyOutputRoot = Join-Path $projectRoot 'dist\潮生'
if (-not $OutputDirectory -and (Test-Path -LiteralPath $legacyOutputRoot -PathType Container)) {
    foreach ($legacyName in @('潮生.exe', '鱼来.exe')) {
        $legacyLauncher = Join-Path $legacyOutputRoot $legacyName
        if (Test-Path -LiteralPath $legacyLauncher -PathType Leaf) {
            Copy-Item -LiteralPath (Join-Path $outputRoot '鱼来.exe') -Destination $legacyLauncher -Force
        }
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'www') -Destination $legacyOutputRoot -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $legacyOutputRoot '使用说明.md') -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot '验证记录.md') -Destination (Join-Path $legacyOutputRoot '验证记录.md') -Force
    Write-Output "已同步兼容发布目录：$legacyOutputRoot\www"
}
$archivePath = Join-Path $distRoot $archiveName
# Package from a fresh staging directory: only the executable and required web assets.
Compress-Archive -LiteralPath (Join-Path $stagingRoot '鱼来.exe'), (Join-Path $stagingRoot 'www') -DestinationPath $archivePath -Force
Write-Output "已构建：$outputRoot\鱼来.exe"
Write-Output "发行包：$archivePath"
if ($env:GITHUB_ENV) { [IO.File]::AppendAllLines($env:GITHUB_ENV, [string[]]@("RELEASE_ARCHIVE=$archivePath", "RELEASE_ASSET_NAME=$archiveName"), (New-Object Text.UTF8Encoding($false))) }
} finally {
    $resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
    if (-not $resolvedStaging.StartsWith($distRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedStaging) -notmatch '^\.build-[0-9a-f]{32}$') { throw '构建临时目录不在预期范围内' }
    if (Test-Path -LiteralPath $resolvedStaging) { Remove-Item -LiteralPath $resolvedStaging -Recurse -Force }
}
