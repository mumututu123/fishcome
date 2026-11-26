const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');

const origin = 'http://127.0.0.1:39672';
const assets = path.resolve(__dirname, '../www');

test('空归档保持后台模拟，有记录时继续归档和整理', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let workers = 0;
  page.on('worker', () => workers++);
  await context.route(origin + '/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<title>fixture</title>' });
    if (pathname === '/local/meta') return route.fulfill({ json: { token: 'fixture', url: origin } });
    if (pathname === '/local/events') return route.fulfill({ status: 204 });
    if (pathname.startsWith('/local/')) return route.fulfill({ json: {} });
    const asset = path.join(assets, pathname === '/' ? 'index.html' : pathname);
    if (pathname !== '/app.js') return route.fulfill({ path: asset });
    const fixture = `
      window.archiveFixture = () => ({
        world, archiveStore,
        holdArchiveSave() {
          const original = save;
          let entered, release;
          const saving = new Promise(resolve => { entered = resolve; });
          const hold = new Promise(resolve => { release = resolve; });
          save = async () => { save = original; entered(); await hold; return original(); };
          return { saving, release };
        },
        async earn(serial, t) {
          const id = identity.actor + ':hour:' + serial;
          const op = { id, actor: identity.actor, nick: identity.nick, roots: world.roots, kind: 'earn', t, cost: 0, serial };
          return { ...op, proof: await network.makeEnvelope('op', op) };
        },
        scan() {
          archiveCheckAt = 0;
          lastSave = Date.now();
          return archiveWorld();
        }
      });
    `;
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(asset, 'utf8') + fixture });
  });
  await page.goto(origin + '/fixture');
  await page.evaluate(async () => { await (await import('./storage.js')).newIdentity('归档测试'); });
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  const initialTick = await page.evaluate(() => archiveFixture().world.data.tick);
  await page.waitForFunction(tick => archiveFixture().world.data.tick > tick, initialTick);
  const workersBefore = workers;
  const { archiveTick, archiveId, savedArchive } = await page.evaluate(async () => {
    const { world, archiveStore, earn, scan } = archiveFixture();
    const { ARCHIVE, ARCHIVE_FIELDS, encodeArchive } = await import('./archive.js');
    const { chooseClaim } = await import('./engine.js');
    const { get, putMany } = await import('./storage.js');
    const now = Date.now(), records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
    const op = await earn(1, now);
    records.ops[op.id] = op;
    const { manifest, encoded, raw } = await encodeArchive(records, world.data.roots);
    await putMany([['archive:' + manifest.id, encoded]]);
    await archiveStore.ingest({ manifest, encoded, raw }, chooseClaim);
    world.data.archives.chunks[manifest.id] = manifest;
    world.data.ops.pressure = { kind: 'earn', t: now, note: '文'.repeat(Math.ceil(ARCHIVE.threshold / 3)) };
    await scan();
    const saved = await get('checkpoint', { observeCheckpoint: false });
    return { archiveTick: world.data.tick, archiveId: op.id, savedArchive: saved.world.archives.chunks[manifest.id] };
  });
  await page.waitForFunction(tick => archiveFixture().world.data.tick > tick, archiveTick);
  assert.equal(workers, workersBefore, '空归档后应继续使用正在推进模拟的线程');
  assert.equal(savedArchive, undefined, '空归档不应额外写入存档');

  const compacted = await page.evaluate(async id => {
    const { world, archiveStore, scan } = archiveFixture();
    const { get } = await import('./storage.js');
    world.data.ops[id] = await archiveStore.get('ops', id);
    await scan();
    const saved = await get('checkpoint', { observeCheckpoint: false });
    return { live: Object.hasOwn(world.data.ops, id), saved: Object.hasOwn(saved.world.ops, id),
      chunks: Object.keys(saved.world.archives.chunks).length };
  }, archiveId);
  assert.deepEqual(compacted, { live: false, saved: false, chunks: 1 });
  await page.waitForFunction(tick => archiveFixture().world.data.tick > tick, await page.evaluate(() => archiveFixture().world.data.tick));
  assert.equal(workers, workersBefore, '清理已有归档的热副本应保留模拟线程');

  await page.evaluate(async () => {
    const { world, earn, scan, holdArchiveSave } = archiveFixture();
    const { ARCHIVE } = await import('./archive.js');
    const op = await earn(2, Date.now() - 2 * ARCHIVE.period);
    world.data.ops[op.id] = op;
    const { saving, release } = holdArchiveSave();
    window.finishArchive = { scan: scan(), release, id: op.id };
    await saving;
    window.positionsAtSave = Object.values(world.data.fishes).map(f => [f.id, f.x, f.y]);
  });
  await page.waitForFunction(() => positionsAtSave.some(([id, x, y]) => {
    const fish = archiveFixture().world.data.fishes[id];
    return fish && (fish.x !== x || fish.y !== y);
  }), null, { timeout: 8000 });
  const archived = await page.evaluate(async () => {
    const { world, archiveStore } = archiveFixture();
    const { get } = await import('./storage.js');
    const { release, scan, id } = finishArchive;
    release();
    await scan;
    const saved = await get('checkpoint', { observeCheckpoint: false });
    const chunk = archiveStore.ids.ops.get(id);
    return { live: Object.hasOwn(world.data.ops, id), saved: Object.hasOwn(saved.world.ops, id),
      chunks: Object.keys(saved.world.archives.chunks).length, stored: !!(await get('archive:' + chunk)) };
  });
  assert.deepEqual(archived, { live: false, saved: false, chunks: 2, stored: true });
  assert.equal(workers, workersBefore, '写入非空归档期间继续使用同一模拟线程');
  assert.deepEqual(errors, []);
});
