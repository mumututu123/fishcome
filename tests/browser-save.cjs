const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');

const www = path.resolve(__dirname, '../www');
let origin, browser;
const server = http.createServer((request, response) => {
  const route = new URL(request.url, origin).pathname;
  if (route === '/local/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: origin } : { ok: true, clients: [], hints: [] }));
    return;
  }
  const file = path.join(www, route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(www + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  response.end(fs.readFileSync(file));
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.locator('#nickInput').fill('自动存档测试');
  await page.locator('#welcomeForm .primary').click();
  await page.waitForFunction(() => window.tide);

  const before = await page.evaluate(async () => {
    const { World } = await import('/engine.js');
    const { get } = await import('/storage.js');
    const initial = await get('checkpoint');
    const serialize = World.prototype.serialize;
    World.prototype.serialize = function () { throw new Error('定时存档重复复制世界'); };
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const checkpoint = await get('checkpoint');
        if (checkpoint.at > initial.at) return {
          initialRoots: Object.keys(initial.world.roots),
          roots: Object.keys(checkpoint.world.roots),
          pictureRoots: checkpoint.picture.roots,
        };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(document.getElementById('toast').textContent || '没有写入新的定时存档');
    } finally { World.prototype.serialize = serialize; }
  });
  assert.deepEqual(before.roots, before.initialRoots);
  assert.deepEqual(before.pictureRoots, before.roots);

  const batch = await page.evaluate(async () => {
    const { get, putMany } = await import('/storage.js');
    const next = { world: { version: 2 }, picture: { version: 2 }, lastOnlineAt: 2 };
    let state = { world: { version: 1 }, picture: { version: 1 }, lastOnlineAt: 1 };
    const writing = putMany(() => {
      queueMicrotask(() => { next.world.version = 3; });
      return [['test-checkpoint', state], ['test-identity', { version: 2 }]];
    });
    state = next;
    await writing;
    let errorName;
    try {
      await putMany([['test-identity', { version: 3 }], ['test-checkpoint', () => {}]]);
    } catch (error) { errorName = error.name; }
    return { checkpoint: await get('test-checkpoint'), identity: await get('test-identity'), errorName };
  });
  assert.deepEqual(batch, {
    checkpoint: { world: { version: 2 }, picture: { version: 2 }, lastOnlineAt: 2 },
    identity: { version: 2 },
    errorName: 'DataCloneError',
  });

  await page.locator('#connect').click();
  const downloading = page.waitForEvent('download');
  await page.locator('#backup').click();
  const download = await downloading;
  const stream = await download.createReadStream();
  const parts = [];
  for await (const part of stream) parts.push(part);
  const backup = JSON.parse(Buffer.concat(parts).toString('utf8'));
  assert.equal(backup.format, 'tide-backup-1');
  assert.deepEqual(Object.keys(backup.checkpoint.world.roots), before.roots);
  assert.deepEqual(backup.checkpoint.picture.roots, before.roots);

  await page.goto(origin + '/welcome.html');
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  assert.deepEqual(await page.evaluate(() => Object.keys(tide.world.data.roots)), before.roots);
  console.log('Chromium 验证通过：定时存档、同版本写入、失败回滚、下载备份、离开后重新打开');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.closeAllConnections();
  server.close();
});
