const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');

const project = path.resolve(__dirname, '..');
const scratchRoot = path.join(project, 'dist', '.hot-update-test-' + Date.now());
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

function startLauncher(exePath, port, extraArgs = []) {
  const child = spawn(exePath, ['--headless', '--loopback', '--port', String(port), ...extraArgs], {
    cwd: path.dirname(exePath),
    windowsHide: true,
    stdio: 'ignore'
  });
  children.push(child);
  return child;
}

async function waitForHealth(port, expectedVersion = null, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body.ok && (!expectedVersion || body.version === expectedVersion)) return body;
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

function printVersion(exePath) {
  const out = execFileSync(exePath, ['--print-version'], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

async function main() {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const v1 = buildVersion('0.1.1', path.join(scratchRoot, 'node-a'));
  const v2 = buildVersion('0.2.0', path.join(scratchRoot, 'node-b'));
  const v3 = buildVersion('0.2.1-beta.1', path.join(scratchRoot, 'node-c'));

  // 写入 node-a 自己的 join.json，验证热更新后不被覆盖
  const preservedInvite = 'http://127.0.0.1:39999';
  const nodeAJoinPath = path.join(v1.dir, 'join.json');
  fs.writeFileSync(nodeAJoinPath, JSON.stringify({ url: preservedInvite }), 'utf8');

  const portA = 39841;
  const portB = 39842;
  startLauncher(v1.exe, portA);
  startLauncher(v2.exe, portB);

  const healthA = await waitForHealth(portA, '0.1.1');
  const healthB = await waitForHealth(portB, '0.2.0');
  assert(healthA.rulesVersion && healthA.rules, '/health 必须返回联机规则版本');
  assert.equal(healthA.rulesVersion, healthB.rulesVersion);

  const metaA = await (await fetch(`http://127.0.0.1:${portA}/local/meta`)).json();
  const metaB = await (await fetch(`http://127.0.0.1:${portB}/local/meta`)).json();
  const statusB = await (await fetch(`http://127.0.0.1:${portB}/status`)).json();
  assert.equal(statusB.version, '0.2.0');
  assert(statusB.rules && statusB.rules.genesis === 1, '/status 必须暴露联机规则');

  // 1. 浏览器实测：进入 node-a 创建一条鱼 -> 用同事邀请码从 node-b 热更新 -> 自动刷新 -> 存档保留且版本升至 0.2.0
  const browser = await chromium.launch({ headless: true, ...(process.env.TIDE_TEST_BROWSER_PATH ? { executablePath: process.env.TIDE_TEST_BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.stack));
    await page.goto(`http://127.0.0.1:${portA}/`);
    await page.locator('#nickInput').fill('热更新验证');
    await page.locator('#welcomeForm .primary').click();
    await page.waitForFunction(() => window.tide && tide.balance() === 20);

    // 使用拼豆画板创建一条两字鱼，确认余额 20 -> 18
    await page.locator('#makeFish').click();
    await page.locator('#glyphInput').fill('鱼o');
    await page.locator('#prepareBeads').click();
    const clickCell = async (gx, gy) => {
      await page.locator('#gridCanvas').scrollIntoViewIfNeeded();
      const box = await page.locator('#gridCanvas').boundingBox();
      await page.mouse.click(box.x + (gx + 0.5) * box.width / 15, box.y + (gy + 0.5) * box.height / 15);
    };
    await page.locator('#beadTray button').first().click();
    await clickCell(5, 5);
    await page.locator('#beadTray button').first().click();
    await clickCell(6, 5);
    assert.equal(await page.locator('#drawingCount').textContent(), '2', '拼豆画板应已放入 2 颗鱼元');
    await page.locator('#fishNameInput').fill('升鱼');
    await page.locator('#placeDrawing').click();
    const point = await page.evaluate(() => {
      const data = tide.world.data, view = tide.view, size = 18 * view.scale, wrap = x => (x % 1000 + 1000) % 1000;
      for (let sy = 260; sy <= 500; sy += 36) for (let sx = 400; sx <= 850; sx += 36) {
        const x = wrap(Math.floor(view.camera.x + (sx - innerWidth / 2) / size)), y = Math.floor(view.camera.y + (sy - innerHeight / 2) / size);
        if (y >= 4 && y < data.terrain.depths[x] - 3) return { x: sx, y: sy };
      }
      return { x: 520, y: 320 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => tide.balance() === 18);

    // 打开连接同事窗口，使用同事邀请码检查并下载更新（自动识别来源，无需切换 Tab）
    await page.locator('#connect').click();
    await page.locator('#currentVersion').waitFor({ state: 'visible' });
    assert.match(await page.locator('#currentVersion').textContent(), /0\.1\.1/);
    await page.locator('#updateSourceInput').fill(metaB.url);
    await page.locator('#checkUpdateBtn').click();
    await page.locator('#updateConfirmCard').waitFor({ state: 'visible', timeout: 20000 });
    const confirmSource = await page.locator('#updateConfirmSource').textContent();
    assert(!confirmSource.includes('127.0.0.1'), `确认来源不应暴露明文 IP，实际为：${confirmSource}`);
    assert.match(confirmSource, /局域网同事.*码尾 …/);
    assert(confirmSource.includes(metaB.url.slice(-6)), `确认来源应包含邀请码短尾码便于核对，实际为：${confirmSource}`);
    assert.match(await page.locator('#updateConfirmVersions').textContent(), /0\.1\.1.*0\.2\.0/);
    assert.equal(await page.locator('#updatePrereleaseBadge').isVisible(), false);

    // 关闭弹窗后，工具栏应显示「待重启」角标
    await page.locator('#closeConnection').click();
    await page.locator('#updateBadgeDot').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#updateBadgeDot').textContent(), '待重启');

    // 打开第二个标签页并在画板画 1 个未投放字符，验证跨标签页草稿保护不会丢弃已准备的更新包
    const page2 = await context.newPage();
    page2.on('pageerror', err => errors.push(err.stack));
    await page2.goto(`http://127.0.0.1:${portA}/`);
    await page2.waitForFunction(() => window.tide && tide.balance() === 18);
    await page2.locator('#makeFish').click();
    await page2.locator('#glyphInput').fill('草');
    await page2.locator('#prepareBeads').click();
    await page2.locator('#beadTray button').first().click();
    const box2 = await page2.locator('#gridCanvas').boundingBox();
    await page2.mouse.click(box2.x + 5.5 * box2.width / 15, box2.y + 5.5 * box2.height / 15);
    assert.equal(await page2.locator('#drawingCount').textContent(), '1');

    // 回到第一个标签页点更新并重启，应被未投放草稿拦截且保留确认卡
    await page.bringToFront();
    await page.locator('#connect').click();
    await page.locator('#updateConfirmCard').waitFor({ state: 'visible' });
    await page.locator('#applyUpdateBtn').click();
    await page.locator('#updatePendingWarn').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.locator('#updatePendingWarn').textContent(), /画的鱼或造景尚未投放/);
    assert.equal(await page.locator('#updateConfirmCard').isVisible(), true, '拦截后必须保留更新确认卡');
    assert.equal(await page.locator('#forceApplyUpdateBtn').isVisible(), true);
    assert.equal(await page2.locator('#creatorDialog').isVisible(), true, '拦截后另一标签页的画板草稿必须保持打开');

    // 点击仍要更新并重启，等待页面自动刷新并进入 0.2.0
    const navPromise = page.waitForNavigation({ timeout: 25000 });
    await page.locator('#forceApplyUpdateBtn').click();
    await navPromise;
    await page.waitForFunction(() => window.tide && document.getElementById('currentVersion')?.textContent?.includes('0.2.0'), { timeout: 15000 });
    assert.equal(await page.evaluate(() => tide.balance()), 18, '更新重启后余额必须保持 18');
    assert(await page.evaluate(() => Object.values(tide.world.data.fishes).some(f => f.name === '升鱼')), '更新重启后创建的鱼必须保留');

    // 实测慢速下载：展示进度条并在下载中取消下载
    let slowTimer = null;
    const slowServer = http.createServer((req, res) => {
      if (req.url === '/acme/fishcome/releases/download/v0.2.1-beta.1/fishcome-0.2.1-beta.1-windows.zip') {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(200000) });
        res.write(Buffer.alloc(32768, 0x50));
        slowTimer = setInterval(() => {
          if (!res.writableEnded) res.write(Buffer.alloc(8192, 0x41));
        }, 500);
        req.on('close', () => { if (slowTimer) { clearInterval(slowTimer); slowTimer = null; } });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve));
    const slowPort = slowServer.address().port;
    try {
      await page.locator('#connect').click();
      await page.locator('#updateSourceInput').fill(`http://127.0.0.1:${slowPort}/acme/fishcome/releases/tag/v0.2.1-beta.1`);
      await page.locator('#checkUpdateBtn').click();
      await page.locator('#updateProgressWrap').waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForFunction(() => {
        const metaText = document.getElementById('updateProgressMeta')?.textContent || '';
        return metaText.includes('KB') || metaText.includes('%');
      }, { timeout: 10000 });
      await page.locator('#cancelDownloadingBtn').click();
      await page.locator('#updateProgressWrap').waitFor({ state: 'hidden', timeout: 10000 });
      assert.equal(await page.locator('#checkUpdateBtn').isDisabled(), false, '取消下载后检查按钮应恢复可用');
    } finally {
      if (slowTimer) clearInterval(slowTimer);
      slowServer.close();
    }
    await page2.close();
    assert.deepEqual(errors, [], '浏览器更新过程不应出现脚本异常');
  } finally {
    await browser.close();
  }

  // 等待后台原地替换完成，验证原目录的 鱼来.exe 已是 0.2.0 且 join.json 未被覆盖
  const replaceDeadline = Date.now() + 15000;
  let diskVersion = '';
  while (Date.now() < replaceDeadline) {
    try {
      const info = printVersion(v1.exe);
      diskVersion = info.version;
      if (diskVersion === '0.2.0') break;
    } catch { }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(diskVersion, '0.2.0', '原安装目录的 鱼来.exe 必须被原地替换为 0.2.0');
  const joinAfter = JSON.parse(fs.readFileSync(nodeAJoinPath, 'utf8'));
  assert(joinAfter.invite && joinAfter.invite.startsWith('YL1.'), '原 join.json 必须沿用本机配置');
  assert.notEqual(joinAfter.invite, metaB.url, '不得被发包方的 join.json 覆盖');

  // 2. GitHub Release 链接热更新验证（含 302 重定向 + 测试版标记 + 0.2.0 -> 0.2.1-beta.1）
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
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  try {
    const metaA2 = await (await fetch(`http://127.0.0.1:${portA}/local/meta`)).json();
    const nodeId = crypto.randomUUID();
    // 拒绝同版本或降级
    const sameRes = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'peer', input: metaB.url
    });
    assert.equal(sameRes.status, 400);
    assert.match(sameRes.body.error, /不高于当前版本/);

    // 粘贴 Release 页面链接，验证自动推导资产链接、跟随 302、识别 prerelease 并完成升级
    const prep = await postLocal(portA, metaA2.token, nodeId, 'update/prepare', {
      kind: 'github', input: `http://127.0.0.1:${mockPort}/acme/fishcome/releases/tag/v0.2.1-beta.1`
    });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.equal(prep.body.update.targetVersion, '0.2.1-beta.1');
    assert.equal(prep.body.update.prerelease, true);

    const applied = await postLocal(portA, metaA2.token, nodeId, 'update/apply', { id: prep.body.update.id });
    assert.equal(applied.status, 200);
    const healthV3 = await waitForHealth(portA, '0.2.1-beta.1', 20000);
    assert.equal(healthV3.version, '0.2.1-beta.1');
  } finally {
    mockServer.close();
  }

  console.log('热更新全流程实测通过：同事局域网升级、浏览器自动刷新保留存档、join.json 保留、原地替换、GitHub 链接重定向升级测试版均验证成功。');
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
