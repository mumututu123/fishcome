param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [int]$Port = 39781,
    [string]$SourceDirectory = (Join-Path $PSScriptRoot '..'),
    [string]$BrowserTestPath = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = [IO.Path]::GetFullPath($SourceDirectory)
if (-not $BrowserTestPath) { $BrowserTestPath = Join-Path $projectRoot 'tests\browser-release.cjs' }
$assetName = [IO.Path]::GetFileName($ArchivePath)
if ($assetName -notmatch '^fishcome-(.+)-windows\.zip$') { throw '发布包名称必须为 fishcome-版本-windows.zip' }
$version = $Matches[1]
$distRoot = Join-Path $projectRoot 'dist'
$testRoot = Join-Path $distRoot ('.smoke-' + [Guid]::NewGuid().ToString('N'))
$process = $null
try {
    $archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
    try {
        $actual = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
        $wwwRoot = Join-Path $projectRoot 'www'
        $expected = @(@('鱼来.exe') + @(Get-ChildItem -LiteralPath $wwwRoot -Recurse -File | ForEach-Object { 'www/' + $_.FullName.Substring($wwwRoot.Length + 1).Replace('\', '/') }) | Sort-Object)
        if (@(Compare-Object $expected $actual).Count -ne 0) { throw '发布包必须仅包含根目录鱼来.exe和完整www资源' }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($ArchivePath), $testRoot)
    $process = Start-Process -FilePath (Join-Path $testRoot '鱼来.exe') -ArgumentList @('--headless', '--loopback', '--port', $Port) -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
    $base = "http://127.0.0.1:$Port"
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) { throw '解压后的启动器提前退出' }
        try { $health = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2; if ($health.ok) { $ready = $true; break } } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw '解压后的启动器未能启动网页服务' }
    if ($health.version -ne $version) { throw '启动器版本与发布包名称不一致' }
    foreach ($file in Get-ChildItem -LiteralPath $wwwRoot -Recurse -File) {
        $relative = $file.FullName.Substring($wwwRoot.Length + 1).Replace('\', '/')
        $response = Invoke-WebRequest -Uri "$base/$relative" -UseBasicParsing -TimeoutSec 5
        $response.RawContentStream.Position = 0
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $servedHash = [BitConverter]::ToString($sha.ComputeHash($response.RawContentStream)).Replace('-', '') } finally { $sha.Dispose() }
        if ($servedHash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "网页资源与源码不一致：$relative" }
    }
    & node $BrowserTestPath $base $assetName
    if ($LASTEXITCODE -ne 0) { throw '解压后的发布页面浏览器验证失败' }
    Write-Output '发布包验证通过：名称与版本一致，程序可启动，资源完整，首次进入与刷新无前端异常。'
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        if (-not $process.WaitForExit(5000)) { throw '验证启动器未能及时退出' }
    }
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTest.StartsWith($distRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedTest) -notmatch '^\.smoke-[0-9a-f]{32}$') { throw '验证临时目录不在预期范围内' }
    if (Test-Path -LiteralPath $resolvedTest) { Remove-Item -LiteralPath $resolvedTest -Recurse -Force }
}
