$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$compilerPath = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$outputRoot = Join-Path $projectRoot 'dist\鱼来'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
& $compilerPath /nologo /codepage:65001 /optimize+ /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/out:$outputRoot\鱼来.exe" "$projectRoot\launcher\Program.cs"
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'www') -Destination $outputRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $outputRoot '使用说明.md') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot '验证记录.md') -Destination (Join-Path $outputRoot '验证记录.md') -Force
# Older installations run from dist/潮生. Keep their web assets current while retaining the existing launcher.
$legacyOutputRoot = Join-Path $projectRoot 'dist\潮生'
if (Test-Path -LiteralPath $legacyOutputRoot -PathType Container) {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'www') -Destination $legacyOutputRoot -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $legacyOutputRoot '使用说明.md') -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot '验证记录.md') -Destination (Join-Path $legacyOutputRoot '验证记录.md') -Force
    Write-Output "已同步兼容发布目录：$legacyOutputRoot\www"
}
$archivePath = Join-Path $projectRoot 'dist\鱼来-0.1.0.zip'
Compress-Archive -LiteralPath (Join-Path $outputRoot '鱼来.exe'), (Join-Path $outputRoot 'www'), (Join-Path $outputRoot '使用说明.md'), (Join-Path $outputRoot '验证记录.md') -DestinationPath $archivePath -Force
Write-Output "已构建：$outputRoot\鱼来.exe"
Write-Output "发行包：$archivePath"
