const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

const origin = 'http://127.0.0.1:39671';
const assets = path.resolve(__dirname, '../www');

// Serve the working tree and isolate launcher responses and IndexedDB for each profile.
async function profile(t, { mobile = false, register } = {}) {
  const browser = await chromium.launch({ executablePath: chromium.executablePath() });
  t.after(() => browser.close());
  const page = await browser.newPage(mobile ? { viewport: { width: 320, height: 568 }, hasTouch: true } : {});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<title>fixture</title>' });
    if (url.pathname === '/local/meta') return route.fulfill({ json: { token: 'fixture', url: origin, version: '1.0.0' } });
    if (url.pathname === '/local/register') await register;
    if (url.pathname === '/local/events') return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/local/')) return route.fulfill({ json: {} });
    return route.fulfill({ path: path.join(assets, url.pathname === '/' ? 'index.html' : url.pathname) });
  });
  await page.goto(origin + '/fixture');
  await page.evaluate(async () => { await (await import('./storage.js')).newIdentity('诊断专用昵称'); });
  return page;
}

async function seedCheckpoint(page, condition) {
  await page.evaluate(async condition => {
    const { World } = await import('./engine.js');
    const { set } = await import('./storage.js');
    const now = Date.now();
    const world = new World(now);
    if (condition === 'missing') {
      const { encodeArchive, ARCHIVE_FIELDS } = await import('./archive.js');
      const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
      const { manifest } = await encodeArchive(records, world.data.roots);
      world.data.archives.chunks[manifest.id] = manifest;
    } else {
      const id = crypto.randomUUID();
      world.data.fishes[id] = { id, created: now, actor: '孤儿鱼的身份' };
    }
    await set('checkpoint', { world: world.serialize(), at: now, lastOnlineAt: now });
  }, condition);
}

async function exported(page) {
  const download = page.waitForEvent('download');
  await page.locator('#diagExportBtn').click();
  const stream = await (await download).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('启动完成后已打开的诊断会从空存档切换到运行世界', async t => {
  let release;
  const register = new Promise(resolve => { release = resolve; });
  const page = await profile(t, { register });
  try {
    await page.goto(origin + '/?debug=1');
    await page.waitForFunction(() => document.querySelector('#diagSummary').textContent.includes('未检测到'));
    assert(await page.locator('#diagAlignBtn').isDisabled());
    assert.equal((await exported(page)).scan.state, 'empty');
  } finally { release(); }
  await page.waitForFunction(() => window.tide && document.querySelector('#diagSummary').textContent.includes('当前运行世界'));
  const result = (await exported(page)).scan;
  assert.equal(result.verified, true);
  assert.equal(result.totalFishes, await page.evaluate(() => tide.world.counts.fish));
});

test('手机端缺失归档可定位并导出，成功重扫之前不能修复', async t => {
  const page = await profile(t, { mobile: true });
  await seedCheckpoint(page, 'missing');
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#networkStatus').textContent.includes('缺少归档'));
  for (let tap = 0; tap < 5; tap++) await page.locator('#networkStatus').tap();
  await page.waitForFunction(() => document.querySelector('#diagSummary').textContent.includes('缺少归档'));
  assert(await page.locator('#diagPruneBtn').isDisabled());
  assert(await page.locator('#diagAlignBtn').isDisabled());
  assert(await page.locator('#diagnosticsDialog').evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth));
  const result = await exported(page);
  assert.deepEqual(result.scan, { state: 'archive_missing' });
  const serialized = JSON.stringify(result);
  const owner = await page.evaluate(async () => (await import('./storage.js')).get('identity'));
  for (const sensitive of [owner.secret.d, owner.pub.x, owner.actor, owner.nick, origin]) assert(!serialized.includes(sensitive));
});

test('启动失败后取消清理可重试，重复点击只提交一次，刷新恢复正常', async t => {
  const page = await profile(t);
  await seedCheckpoint(page, 'orphan');
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#networkStatus').textContent.includes('创建者'));
  await page.keyboard.press('Control+Shift+d');
  const prune = page.locator('#diagPruneBtn');
  let prompts = 0;
  page.on('dialog', async dialog => { if (++prompts === 1) await dialog.dismiss(); else await dialog.accept(); });
  await prune.click();
  await page.waitForFunction(() => !document.querySelector('#diagPruneBtn').disabled);
  const before = await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration'));
  assert.equal(before, undefined);
  await prune.evaluate(el => { el.click(); el.click(); });
  await page.waitForFunction(() => window.tide);
  assert.equal(prompts, 2);
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), 1);
  await page.keyboard.press('Control+Shift+d');
  await page.waitForFunction(() => document.querySelector('#diagSummary').textContent.includes('当前运行世界'));
  assert.equal((await exported(page)).scan.verified, true);
});

test('扫描后存档被改动时保留新存档，重新扫描后才允许再清理', async t => {
  const page = await profile(t);
  await seedCheckpoint(page, 'orphan');
  await page.goto(origin + '/?debug=1');
  await page.waitForFunction(() => document.querySelector('#networkStatus').textContent.includes('创建者') && !document.querySelector('#diagPruneBtn').disabled);
  await page.evaluate(async () => {
    const { get, set } = await import('./storage.js');
    const checkpoint = await get('checkpoint');
    checkpoint.at += 123;
    await set('checkpoint', checkpoint);
  });
  await page.locator('#diagPruneBtn').click();
  await page.waitForFunction(() => document.querySelector('#diagRepairResult').textContent.includes('重新扫描'));
  assert(await page.locator('#diagPruneBtn').isDisabled());
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), undefined);
  await page.locator('#diagScanBtn').click();
  await page.waitForFunction(() => !document.querySelector('#diagPruneBtn').disabled);
  assert(await page.locator('#diagRepairResult').isHidden());
});

test('启动失败时可从连接面板导入备份，损坏的历史卡不会覆盖原存档', async t => {
  const page = await profile(t);
  await seedCheckpoint(page, 'missing');
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#networkStatus').textContent.includes('缺少归档'));
  await page.locator('#connect').click();
  const backup = await page.evaluate(async () => {
    const { World } = await import('./engine.js');
    const { get } = await import('./storage.js');
    return { format: 'tide-backup-1', identity: await get('identity'), checkpoint: { at: Date.now(), world: new World().serialize() } };
  });
  const upload = data => page.locator('#importBackup').setInputFiles({
    name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))
  });
  const root = Object.keys(backup.checkpoint.world.roots)[0];
  await upload({ ...backup, histories: { [root]: { roots: [root] } } });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('历史世界无效'));
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), undefined);
  await upload(backup);
  await page.waitForFunction(() => window.tide);
  assert.deepEqual(await page.evaluate(() => Object.keys(tide.world.data.roots)), [root]);
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), 1);
});
