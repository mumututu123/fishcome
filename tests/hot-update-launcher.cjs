const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { assetName, launcherName, availablePort, waitForHealth, postLocal, printVersion, makeZip, withReleaseFixtures } = require('./release-fixtures.cjs');

function buildCrashingUpdateZip(version, root, archivesDir) {
  const source = path.join(root, launcherName);
  const zipPath = path.join(archivesDir, assetName(version));
  const markerPath = path.join(root, 'executed.marker');
  const stamp = `fishcome-release:${version}:`;
  execFileSync('go', ['build', '-ldflags', `-X main.version=${version} -X main.releaseStamp=${stamp}`, '-o', source, path.join(__dirname, 'fixtures', 'crash-launcher.go')], {
    stdio: 'inherit', windowsHide: true
  });
  const entries = ['index.html', 'app.js', 'rules.js', 'update.js', 'network.js', 'storage.js', 'style.css']
    .map(name => ({ name: `www/${name}`, text: `/* ${name} */` }));
  makeZip(zipPath, [{ name: launcherName, source }, ...entries]);
  return { markerPath, zipPath, marker: `${version}\n${stamp}` };
}

function rawHttpStatus(port, requestText) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => sock.write(requestText));
    sock.setTimeout(5000, () => sock.destroy(new Error(`读取端口 ${port} 的响应超时`)));
    let data = '';
    sock.on('data', chunk => { data += chunk.toString('utf8'); });
    sock.on('end', () => {
      const m = /^HTTP\/1\.1 (\d+)/.exec(data);
      resolve(m ? Number(m[1]) : 0);
    });
    sock.on('error', reject);
  });
}

async function main({ root, archivesDir, buildVersion, startLauncher }) {
  const v1 = buildVersion('0.1.1', 'node-a');
  const v2 = buildVersion('0.2.0', 'node-b');
  const v3 = buildVersion('0.2.1-beta.1', 'node-c');
  const crashPkg = buildCrashingUpdateZip('0.3.0', root, archivesDir);

  // 写入带自定义字段的 join.json，验证热更新前后字节 100% 一致
  const nodeAJoinPath = path.join(v1.dir, 'join.json');
  const originalJoinBytes = Buffer.from(JSON.stringify({ url: 'http://127.0.0.1:39999', custom: 'keep-me' }), 'utf8');
  fs.writeFileSync(nodeAJoinPath, originalJoinBytes);

  const portA = await availablePort();
  await startLauncher(v1.exe, portA, { TIDE_TEST_CRASH_MARKER: crashPkg.markerPath });
  const portB = await availablePort();
  await startLauncher(v2.exe, portB);

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
  await waitForHealth(portA, '0.2.0');
  assert.equal(printVersion(v1.exe).version, '0.2.0', '端口交接完成时，原安装目录的启动器必须已是 0.2.0');
  assert.deepEqual(fs.readFileSync(nodeAJoinPath), originalJoinBytes, '交接过程不得改写原安装目录的 join.json 字节');

  // 2. 边界校验 + 确认前不执行 + 失败回滚 + GitHub 302 升级测试版
  const slipZip = path.join(archivesDir, 'slip.zip');
  makeZip(slipZip, [{ name: '../evil.txt', text: 'bad' }, { name: launcherName, text: 'MZfake' }, { name: 'www/index.html', text: 'hi' }]);
  const dupZip = path.join(archivesDir, 'dup.zip');
  makeZip(dupZip, [{ name: launcherName, text: 'MZfake' }, { name: 'www/index.html', text: 'a' }, { name: 'www/Index.html', text: 'b' }]);

  const mockServer = http.createServer((req, res) => {
    if (req.url === `/acme/fishcome/releases/download/v0.2.1-beta.1/${assetName('0.2.1-beta.1')}`) {
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
    if (req.url === `/acme/fishcome/releases/download/v0.9.0/${assetName('0.9.0')}`) {
      const data = fs.readFileSync(slipZip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === `/acme/fishcome/releases/download/v0.8.5/${assetName('0.8.5')}`) {
      const data = fs.readFileSync(dupZip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === `/acme/fishcome/releases/download/v0.8.0/${assetName('0.8.0')}`) {
      const data = fs.readFileSync(v2.zip);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.url === `/acme/fishcome/releases/download/v0.3.0/${assetName('0.3.0')}`) {
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
    assert.equal(fs.existsSync(crashPkg.markerPath), false, '准备阶段不得运行更新包内的启动器');

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
    assert.equal(fs.readFileSync(crashPkg.markerPath, 'utf8'), crashPkg.marker, '确认更新后应实际运行崩溃版本');
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
    const healthV3 = await waitForHealth(portA, '0.2.1-beta.1');
    assert.equal(healthV3.version, '0.2.1-beta.1');
  } finally {
    mockServer.closeAllConnections();
    await new Promise(resolve => mockServer.close(resolve));
  }

  console.log('启动器热更新全流程实测通过：局域网升级、事务原地替换、join.json 字节不变、Host 校验、确认前零执行、崩溃回滚恢复、以及 GitHub 测试版升级全部验证成功。');
}

withReleaseFixtures(main).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
