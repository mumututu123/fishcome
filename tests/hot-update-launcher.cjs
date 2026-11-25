const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const scratchRoot = path.join(project, 'dist', '.hot-update-launcher-' + Date.now());
const archivesDir = path.join(scratchRoot, 'archives');
const children = [];

function buildVersion(version, outDir) {
  execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ProgressPreference = 'SilentlyContinue'; & '${path.join(project, 'build.ps1')}' -Version '${version}' -OutputDirectory '${outDir}' -ArchiveDirectory '${archivesDir}'`
  ], { stdio: 'pipe' });
  return {
    dir: outDir,
    exe: path.join(outDir, '鱼来.exe'),
    zip: path.join(archivesDir, `fishcome-${version}-windows.zip`)
  };
}

function buildCrashingUpdateZip(version, zipPath) {
  const dir = path.join(scratchRoot, 'crash-pkg-' + version);
  fs.mkdirSync(path.join(dir, 'www'), { recursive: true });
  for (const name of ['index.html', 'app.js', 'rules.js', 'update.js', 'network.js', 'storage.js', 'style.css']) {
    fs.writeFileSync(path.join(dir, 'www', name), `/* ${name} */`, 'utf8');
  }
  const csPath = path.join(dir, 'Crash.cs');
  // Writes a marker if ever executed during prepare, and exits immediately with code 1 during handoff.
  const markerPath = path.join(dir, 'executed.marker').replace(/\\/g, '\\\\');
  fs.writeFileSync(csPath, `
using System;
using System.IO;
using System.Reflection;
[assembly: AssemblyInformationalVersion("${version}")]
static class Crash {
  static int Main() {
    try { File.WriteAllText("${markerPath}", "ran"); } catch {}
    return 1;
  }
}
`, 'utf8');
  const script = `
$csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe' }
& $csc /nologo /target:winexe "/out:${path.join(dir, '鱼来.exe')}" "${csPath}"
if ($LASTEXITCODE -ne 0) { throw 'compile crash exe failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path '${zipPath}') { Remove-Item '${zipPath}' -Force }
$ProgressPreference = 'SilentlyContinue'
Compress-Archive -LiteralPath '${path.join(dir, '鱼来.exe')}', '${path.join(dir, 'www')}' -DestinationPath '${zipPath}' -Force
`;
  execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'pipe' });
  return { markerPath: path.join(dir, 'executed.marker'), zipPath };
}

function startLauncher(exePath, port) {
  const child = spawn(exePath, ['--headless', '--loopback', '--port', String(port)], {
    cwd: path.dirname(exePath),
    windowsHide: true,
    stdio: 'ignore'
  });
  children.push(child);
  return child;
}

async function waitForHealth(port, expectedVersion = null, requireReady = true, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body.ok && (!expectedVersion || body.version === expectedVersion) && (!requireReady || body.handoffReady !== false)) {
          return body;
        }
      }
    } catch { }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`端口 ${port} 未能在超时内就绪${expectedVersion ? `（期望版本 ${expectedVersion}）` : ''}`);
}

async function postLocal(port, token, node, route, payload = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/local/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, node, ...payload })
  });
  return { status: res.status, body: await res.json() };
}

function rawHttpStatus(port, requestText) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => sock.write(requestText));
    let data = '';
    sock.on('data', chunk => { data += chunk.toString('utf8'); });
    sock.on('end', () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(data);
      resolve(m ? Number(m[1]) : 0);
    });
    sock.on('error', reject);
  });
}

function printVersion(exePath) {
  const out = execFileSync(exePath, ['--print-version'], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

function makeBrokenZip(targetZip, entries) {
  const script = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path '${targetZip}') { Remove-Item '${targetZip}' -Force }
$fs = [IO.File]::Open('${targetZip}', [IO.FileMode]::Create)
$zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create, $false)
${entries.map(([name, text]) => `
$e = $zip.CreateEntry('${name}')
$w = New-Object IO.StreamWriter($e.Open())
$w.Write('${text}')
$w.Dispose()
`).join('\n')}
$zip.Dispose()
$fs.Dispose()
`;
  execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'pipe' });
}

async function main() {
  fs.mkdirSync(archivesDir, { recursive: true });
  const v1 = buildVersion('0.1.1', path.join(scratchRoot, 'node-a'));
  const v2 = buildVersion('0.2.0', path.join(scratchRoot, 'node-b'));
  const v3 = buildVersion('0.2.1-beta.1', path.join(scratchRoot, 'node-c'));
  const crashPkg = buildCrashingUpdateZip('0.3.0', path.join(archivesDir, 'fishcome-0.3.0-windows.zip'));

  // 写入带自定义字段的 join.json，验证热更新前后字节 100% 一致
  const nodeAJoinPath = path.join(v1.dir, 'join.json');
  const originalJoinBytes = Buffer.from(JSON.stringify({ url: 'http://127.0.0.1:39999', custom: 'keep-me' }), 'utf8');
  fs.writeFileSync(nodeAJoinPath, originalJoinBytes);

  const portA = 39851;
  const portB = 39852;
  startLauncher(v1.exe, portA);
  startLauncher(v2.exe, portB);

  const healthA = await waitForHealth(portA, '0.1.1');
  const healthB = await waitForHealth(portB, '0.2.0');
  assert(healthA.rulesVersion && healthA.rules && healthA.rules.genesis === 1, '/health 必须暴露联机规则');
  assert.equal(healthA.rulesVersion, healthB.rulesVersion);

  // 验证非法 Host 头访问 /local/meta 被 403 拒绝
  const badHostStatus = await rawHttpStatus(portA, `GET /local/meta HTTP/1.1\r\nHost: evil.example:${portA}\r\nConnection: close\r\n\r\n`);
  assert.equal(badHostStatus, 403, '非法 Host 头访问本地管理接口必须返回 403');

  const metaA = await (await fetch(`http://127.0.0.1:${portA}/local/meta`)).json();
  const metaB = await (await fetch(`http://127.0.0.1:${portB}/local/meta`)).json();
  const statusB = await (await fetch(`http://127.0.0.1:${portB}/status`)).json();
  assert.equal(statusB.version, '0.2.0');
  assert.equal(statusB.rulesVersion, healthB.rulesVersion);

  // 重写 node-a 的 join.json 为原始旧格式字节，验证交接过程只读不改写
  fs.writeFileSync(nodeAJoinPath, originalJoinBytes);

  const nodeId = crypto.randomUUID();

  // 1. 同事局域网热更新：prepare -> apply -> 端口交接 -> 事务原地替换 -> join.json 字节级不变
  const prepPeer = await postLocal(portA, metaA.token, nodeId, 'update/prepare', {
    kind: 'peer', input: metaB.url
  });
  assert.equal(prepPeer.status, 200, JSON.stringify(prepPeer.body));
  assert.equal(prepPeer.body.update.phase, 'ready');
  assert.equal(prepPeer.body.update.targetVersion, '0.2.0');
  assert.equal(prepPeer.body.update.prerelease, false);

  const applyPeer = await postLocal(portA, metaA.token, nodeId, 'update/apply', { id: prepPeer.body.update.id });
  assert.equal(applyPeer.status, 200, JSON.stringify(applyPeer.body));

  // 等待磁盘交接完全就绪（handoffReady === true）
  const healthAfterPeer = await waitForHealth(portA, '0.2.0', true, 20000);
  assert.equal(healthAfterPeer.version, '0.2.0');
  assert.equal(healthAfterPeer.handoffReady, true);
  assert.equal(printVersion(v1.exe).version, '0.2.0', '原安装目录的 鱼来.exe 必须在 handoffReady 时已是 0.2.0');
  assert.deepEqual(fs.readFileSync(nodeAJoinPath), originalJoinBytes, '交接过程不得改写原安装目录的 join.json 字节');

  // 2. 边界校验 + 确认前不执行 + 失败回滚 + GitHub 302 升级测试版
  const slipZip = path.join(archivesDir, 'slip.zip');
  makeBrokenZip(slipZip, [['../evil.txt', 'bad'], ['鱼来.exe', 'MZfake'], ['www/index.html', 'hi']]);
  const dupZip = path.join(archivesDir, 'dup.zip');
  makeBrokenZip(dupZip, [['鱼来.exe', 'MZfake'], ['www/index.html', 'a'], ['www/Index.html', 'b']]);

  const mockServer = http.createServer((req, res) => {
    if (req.url === '/acme/fishcome/releases/download/v0.2.1-beta.1/fishcome-0.2.1-beta.1-windows.zip') {
      res.writeHead(302, { Location: '/cdn/v3.zip' });
      res.end();
      return;
    }
    if (req.url === '/cdn/v3.zip') {
      const data = fs.readFileSync(v3.zip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === '/acme/fishcome/releases/download/v0.9.0/fishcome-0.9.0-windows.zip') {
      const data = fs.readFileSync(slipZip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === '/acme/fishcome/releases/download/v0.8.5/fishcome-0.8.5-windows.zip') {
      const data = fs.readFileSync(dupZip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === '/acme/fishcome/releases/download/v0.8.0/fishcome-0.8.0-windows.zip') {
      const data = fs.readFileSync(v2.zip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === '/acme/fishcome/releases/download/v0.3.0/fishcome-0.3.0-windows.zip') {
      const data = fs.readFileSync(crashPkg.zipPath);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;

  try {
    const metaA2 = await (await fetch(`http://127.0.0.1:${portA}/local/meta`)).json();

    // 拒绝非 GitHub 外部 HTTPS 域名
    const badDomain = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: 'https://evil.example/acme/fishcome/releases/tag/v0.9.0'
    });
    assert.equal(badDomain.status, 400);
    assert.match(badDomain.body.error, /github\.com/);

    // 拒绝同版本
    const sameRes = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', { kind: 'peer', input: metaB.url });
    assert.equal(sameRes.status, 400);
    assert.match(sameRes.body.error, /不高于当前版本/);

    // 拒绝路径穿越 zip
    const slipRes = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.9.0`
    });
    assert.equal(slipRes.status, 400);
    assert.match(slipRes.body.error, /非法路径/);

    // 拒绝大小写冲突 zip
    const dupRes = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.8.5`
    });
    assert.equal(dupRes.status, 400);
    assert.match(dupRes.body.error, /重复或大小写冲突/);

    // 拒绝版本号冒充（静态元数据校验）
    const spoofRes = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.8.0`
    });
    assert.equal(spoofRes.status, 400);
    assert.match(spoofRes.body.error, /不一致/);

    // 3. 确认前绝不执行包内程序 + 交接崩溃后旧版真实回滚恢复
    const prepCrash = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.3.0`
    });
    assert.equal(prepCrash.status, 200, JSON.stringify(prepCrash.body));
    assert.equal(fs.existsSync(crashPkg.markerPath), false, '准备阶段绝不能执行更新包内的 鱼来.exe');

    const applyCrash = await postLocal(portA, metaA2.token, nodeId, 'update/apply', { id: prepCrash.body.update.id });
    assert.equal(applyCrash.status, 200);

    // 等待旧版 0.2.0 恢复监听并报告 failed
    let recovered = false;
    const recoverDeadline = Date.now() + 15000;
    while (Date.now() < recoverDeadline) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${portA}/health`, { cache: 'no-store' })).json();
        const st = await postLocal(portA, metaA2.token, nodeId, 'update/status');
        if (h.ok && h.version === '0.2.0' && st.body.update.phase === 'failed') {
          recovered = true;
          break;
        }
      } catch { }
      await new Promise(r => setTimeout(r, 250));
    }
    assert.equal(recovered, true, '新版启动崩溃时旧版必须重新接管端口并报告 failed');
    assert.equal(printVersion(v1.exe).version, '0.2.0', '回滚后原安装目录的程序必须保持 0.2.0');

    // 4. 回滚后仍可继续从合法 GitHub 链接升级到测试版 0.2.1-beta.1
    const prepGh = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.2.1-beta.1`
    });
    assert.equal(prepGh.status, 200, JSON.stringify(prepGh.body));
    assert.equal(prepGh.body.update.targetVersion, '0.2.1-beta.1');
    assert.equal(prepGh.body.update.prerelease, true);

    const cancelRes = await postLocal(portA, metaA2.token, nodeId, 'update/cancel');
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.update.phase, 'idle');

    const prepGh2 = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.2.1-beta.1`
    });
    assert.equal(prepGh2.status, 200);

    const applyGh = await postLocal(portA, metaA2.token, nodeId, 'update/apply', { id: prepGh2.body.update.id });
    assert.equal(applyGh.status, 200);
    const healthV3 = await waitForHealth(portA, '0.2.1-beta.1', true, 20000);
    assert.equal(healthV3.version, '0.2.1-beta.1');
  } finally {
    mockServer.close();
  }

  console.log('启动器热更新全流程实测通过：局域网升级、事务原地替换、join.json 字节不变、Host 校验、确认前零执行、崩溃回滚恢复、以及 GitHub 测试版升级全部验证成功。');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  for (const child of children) {
    try { child.kill(); } catch { }
  }
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${scratchRoot.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
  } catch { }
  try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { }
});
