param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [ValidateRange(1, 65534)][int]$Port = 39781,
    [string]$SourceDirectory = (Join-Path $PSScriptRoot '..'),
    [string]$BrowserTestPath = '',
    [switch]$LegacyWindows
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceDirectory)
if (-not $BrowserTestPath) { $BrowserTestPath = Join-Path $projectRoot 'tests/browser-release.cjs' }
$archivePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArchivePath)
$assetName = [IO.Path]::GetFileName($archivePath)
if ($assetName -cnotmatch '^fishcome-(.+)-(windows|linux-amd64)\.zip$') { throw '发布包文件名无效' }
$version, $platform = $Matches[1], $Matches[2]
$windows = $platform -eq 'windows'
if ($windows -ne ([IO.Path]::DirectorySeparatorChar -eq '\') -or ($LegacyWindows -and -not $windows)) {
    throw '请在发布包实际适用的系统上验证'
}
$launcherName = if ($windows) { '鱼来.exe' } else { 'fishcome' }
$wwwRoot = Join-Path $projectRoot 'www'
$distRoot = Join-Path $projectRoot 'dist'
$testRoot = Join-Path $distRoot ('.smoke-' + [Guid]::NewGuid().ToString('N'))
$processes = @()

$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $actual = @($archive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
    $expected = @(@($launcherName) + @(Get-ChildItem -LiteralPath $wwwRoot -Recurse -File | ForEach-Object { 'www/' + $_.FullName.Substring($wwwRoot.Length + 1).Replace('\', '/') }) | Sort-Object)
    if (@(Compare-Object $expected $actual -CaseSensitive).Count -ne 0) { throw "发布包必须仅包含根目录 $launcherName 和完整 www 资源" }
    if (-not $windows -and (($archive.GetEntry($launcherName).ExternalAttributes -shr 16) -band 511) -ne 493) {
        throw 'Linux 发布包未保存启动器的可执行权限'
    }
} finally { $archive.Dispose() }

try {
    $browserArgs = @("http://127.0.0.1:$Port", $assetName)
    $ports = if ($LegacyWindows) { @($Port) } else { @($Port, ($Port + 1)) }
    foreach ($listenPort in $ports) {
        $instanceRoot = Join-Path $testRoot "instance-$listenPort"
        [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $instanceRoot)
        $launcher = Join-Path $instanceRoot $launcherName
        $processOptions = @{}
        if ($windows) {
            $processOptions.WindowStyle = 'Hidden'
            if (-not $LegacyWindows) {
                $productVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($launcher).ProductVersion
                if ($productVersion -cne $version) { throw "启动器的 Windows 产品版本为 $productVersion，发布包版本为 $version" }
            }
        }
        $process = Start-Process -FilePath $launcher -ArgumentList @('--headless', '--loopback', '--port', $listenPort) -WorkingDirectory $instanceRoot -PassThru @processOptions
        $processes += $process
        $base = "http://127.0.0.1:$listenPort"
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $health = $null
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) { throw "解压后的启动器提前退出，端口 $listenPort" }
            try { $health = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2; if ($health.ok) { break } } catch { }
            Start-Sleep -Milliseconds 200
        }
        if (-not $health.ok) { throw "解压后的启动器未能启动网页服务，端口 $listenPort" }
        if ($health.version -cne $version) { throw '启动器版本与发布包名称不一致' }
        if ($listenPort -ne $Port) { $browserArgs += $base }
    }

    $base = $browserArgs[0]
    foreach ($file in Get-ChildItem -LiteralPath $wwwRoot -Recurse -File) {
        $relative = $file.FullName.Substring($wwwRoot.Length + 1).Replace('\', '/')
        $response = Invoke-WebRequest -Uri "$base/$relative" -UseBasicParsing -TimeoutSec 5
        $response.RawContentStream.Position = 0
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $servedHash = [BitConverter]::ToString($sha.ComputeHash($response.RawContentStream)).Replace('-', '') } finally { $sha.Dispose() }
        if ($servedHash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "网页资源与源码不一致：$relative" }
    }
    & node $BrowserTestPath @browserArgs
    if ($LASTEXITCODE -ne 0) { throw '解压后的发布页面浏览器验证失败' }
    Write-Output '发布包验证通过：解压后可直接启动，程序版本与包名一致，网页资源完整，浏览器验证通过。'
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) {
            Stop-Process -InputObject $process -ErrorAction SilentlyContinue
            if (-not $process.WaitForExit(5000)) { throw '验证启动器未能及时退出' }
        }
        $process.Dispose()
    }
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($resolvedTest) -ne $distRoot -or [IO.Path]::GetFileName($resolvedTest) -notmatch '^\.smoke-[0-9a-f]{32}$') { throw '验证临时目录不在预期范围内' }
    $cleanup = [IO.DirectoryInfo]::new($resolvedTest)
    if ($cleanup.Exists -and ($cleanup.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        $hidden = ($cleanup.Attributes -band [IO.FileAttributes]::Hidden) -ne 0
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force:$hidden
    }
}
