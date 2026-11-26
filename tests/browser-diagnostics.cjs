const assert = require('node:assert/strict');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const origin = 'http://127.0.0.1:39671';
const assets = path.resolve(__dirname, '../www');

let browser;
before(async () => { browser = await chromium.launch({ executablePath: chromium.executablePath() }); });
after(() => browser?.close());

async function profile(t, { mobile = false, register } = {}) {
  const context = await browser.newContext(mobile ? { viewport: { width: 320, height: 568 }, hasTouch: true } : {});
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  context.on('weberror', event => errors.push(event.error().message));
  t.after(() => assert.deepEqual(errors, []));
  await page.context().route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<title>fixture</title>' });
    if (url.pathname === '/local/meta') return route.fulfill({ json: { token: 'fixture', url: origin, version: '1.0.0' } });
    if (url.pathname === '/local/register') await register?.();
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

async function exported(page, selector = '#diagExportBtn') {
  const download = page.waitForEvent('download');
  await page.locator(selector).click();
  const stream = await (await download).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('拒绝联机副本时保留运行世界、模拟和本地归档', async t => {
  const page = await profile(t);
  await page.route(origin + '/app.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { Network } from './network.js';
    const start = Network.prototype.start;
    Network.prototype.start = function (...args) {
      window.testNetwork = this;
      return start.apply(this, args);
    };
    await import('./app.js?application');
  ` }));
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  const result = await page.evaluate(async () => {
    const { ARCHIVE_FIELDS, encodeArchive } = await import('./archive.js');
    const { get } = await import('./storage.js');
    const { subscribeSimulationChanges } = await import('./simulation-changes.js');
    const { WORLD_RULES } = await import('./rules.js');
    const state = tide.world.data;
    const fish = Object.values(state.fishes)[0];
    const creator = fish.actor;
    fish.actor = '失配的创建者';
    const chunks = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
    const { manifest, encoded } = await encodeArchive(chunks, state.roots);
    const peer = { id: 'test-peer', node: 'test-peer', url: location.origin };
    const network = window.testNetwork;
    network.direct = (source, kind, body) => {
      if (kind !== 'archiveRequest' || body.id !== manifest.id) throw new Error('意外的归档请求');
      return network.onMessage({ kind: 'archiveChunk', from: peer.node, body: { id: body.id, encoded } }, peer);
    };
    const hello = () => network.onMessage({ kind: 'hello', from: peer.node, actor: '同事',
      body: { world: state, rules: WORLD_RULES, member: { id: peer.node, actor: '同事', nick: '伙伴' } } }, peer);
    const errors = [];
    let resets = 0;
    const unsubscribe = subscribeSimulationChanges((_, patch) => { if (!patch) resets++; });
    try {
      for (const withArchive of [false, true]) {
        if (withArchive) state.archives.chunks[manifest.id] = manifest;
        try { await hello(); } catch (error) { errors.push(error.message); }
      }
    } finally { unsubscribe(); }
    const chat = await network.makeEnvelope('chat', { nick: '同事', text: '当前世界的一段聊天', t: Date.now(), roots: Object.keys(state.roots) });
    const other = crypto.randomUUID();
    const card = { id: other, roots: [other], image: 'data:image/png;base64,AA==', chats: { [chat.id]: chat } };
    try { await network.onMessage({ kind: 'history', from: peer.node, body: { card } }, peer); }
    catch (error) { errors.push(error.message); }
    const rejected = { errors, resets, joined: Object.hasOwn(tide.world.data.participants, '同事'),
      history: Object.hasOwn(tide.histories, other), chat: Object.hasOwn(tide.world.data.chats, chat.id),
      stored: (await get('archive:' + manifest.id)) !== undefined };
    fish.actor = creator;
    await hello();
    return { rejected, joined: tide.world.data.participants['同事'], stored: await get('archive:' + manifest.id) === encoded };
  });
  assert.deepEqual(result, { rejected: { errors: ['鱼的创建者记录无效', '鱼的创建者记录无效', '历史世界无效'], resets: 0,
    joined: false, history: false, chat: false, stored: false }, joined: '伙伴', stored: true });
});

test('启动完成后已打开的诊断会从空存档切换到运行世界', async t => {
  let release;
  const register = new Promise(resolve => { release = resolve; });
  const page = await profile(t, { register: () => register });
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
  const pageReads = await page.evaluate(async () => {
    let reads = 0;
    const open = IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor = function(range, ...rest) {
      if (range?.lower?.[0] === 'checkpoint-page') reads++;
      return open.call(this, range, ...rest);
    };
    try {
      await document.querySelector('#diagScanBtn').onclick();
      return reads;
    } finally { IDBObjectStore.prototype.openCursor = open; }
  });
  assert.equal(pageReads, 0, '扫描运行世界时只需要磁盘版本，无需再读取全部记录页');
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

test('首次保存遇到另一页面更换存档，诊断与备份都读取更换后的身份和世界', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = await profile(t, { register: () => gate });
  const registering = page.waitForRequest(origin + '/local/register');
  let root;
  try {
    await page.goto(origin);
    await registering;
    const other = await page.context().newPage();
    await other.goto(origin + '/fixture');
    root = await other.evaluate(async () => {
      const { World } = await import('./engine.js');
      const { newIdentity, putMany } = await import('./storage.js');
      const owner = await newIdentity('另一页导入的身份');
      const world = new World();
      await putMany([['identity', owner], ['checkpoint', { world: world.serialize(), at: Date.now() }]],
        { generation: 0, replace: true });
      return world.id;
    });
  } finally { release(); }
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('#networkStatus').textContent.includes('其他页面'));
  await page.keyboard.press('Control+Shift+d');
  const scan = (await exported(page)).scan;
  assert.equal(scan.target, 'checkpoint');
  assert.equal(scan.verified, true);
  await page.locator('#closeDiagnostics').click();
  await page.locator('#connect').click();
  const backup = await exported(page, '#backup');
  assert.deepEqual(Object.keys(backup.checkpoint.world.roots), [root]);
  assert.equal(backup.identity.nick, '另一页导入的身份');
});

test('同一代存档在启动时被另一页面保存，交接会保留另一页的进度', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = await profile(t, { register: () => gate });
  await page.evaluate(async () => {
    const { World } = await import('./engine.js'), { set } = await import('./storage.js');
    await set('checkpoint', { world: new World().serialize(), at: Date.now() });
  });
  const registering = page.waitForRequest(origin + '/local/register');
  try {
    await page.goto(origin);
    await registering;
    const other = await page.context().newPage();
    await other.goto(origin + '/fixture');
    await other.evaluate(async () => {
      const { getMany, putMany } = await import('./storage.js');
      const [checkpoint, owner] = await getMany(['checkpoint', 'identity']);
      checkpoint.world.participants['other-player'] = '交接期间加入';
      owner.serial = 3;
      await putMany([['checkpoint', checkpoint], ['identity', owner]], { generation: 0 });
    });
  } finally { release(); }
  await page.waitForFunction(() => window.tide);
  assert.equal(await page.evaluate(() => tide.world.data.participants['other-player']), '交接期间加入');
  assert.deepEqual(await page.evaluate(async () => {
    const saved = await (await import('./storage.js')).readHandoffCheckpoint();
    return [saved.identity.serial, saved.generation, saved.checkpoint.world.participants['other-player']];
  }), [3, 0, '交接期间加入']);
});

test('旧格式身份备份保留当前世界，刷新和回退旧版都读取导入的身份', async t => {
  const page = await profile(t);
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  await page.locator('#connect').click();
  const backup = await exported(page, '#backup');
  const roots = Object.keys(backup.checkpoint.world.roots);
  delete backup.checkpoint;
  backup.identity.nick = '旧备份的昵称';
  await page.locator('#importBackup').setInputFiles({
    name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
  });
  await page.waitForFunction(() => window.tide?.identity.nick === '旧备份的昵称');
  assert.deepEqual(await page.evaluate(() => Object.keys(tide.world.data.roots)), roots);
  const legacy = await page.evaluate(async () => {
    const db = await (await import('./storage.js')).database();
    const tx = db.transaction('items'), store = tx.objectStore('items');
    const owner = store.get('identity'), checkpoint = store.get('checkpoint');
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    return { nick: owner.result.nick, roots: Object.keys(checkpoint.result.world.roots) };
  });
  assert.deepEqual(legacy, { nick: '旧备份的昵称', roots });
});

test('运行世界在分页修复写入期间收到新操作时，整笔修复回滚', async t => {
  const page = await profile(t);
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  await page.evaluate(async () => {
    const { World } = await import('./engine.js');
    const { worldEdited, setParticipantName } = await import('./simulation-changes.js');
    const serialize = World.prototype.serialize;
    World.prototype.serialize = function () {
      World.prototype.serialize = serialize;
      const live = this;
      worldEdited(live);
      Object.values(live.data.fishes)[0].actor = '待对齐';
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (key === 'saveGeneration' && value === 1) {
          IDBObjectStore.prototype.put = put;
          setParticipantName(live, 'new-player', '刚加入的伙伴');
        }
        return request;
      };
      return serialize.call(live);
    };
  });
  await page.keyboard.press('Control+Shift+d');
  await page.locator('#diagAlignBtn').click();
  await page.waitForFunction(() => document.querySelector('#diagRepairResult').textContent.includes('重新扫描') ||
    !document.querySelector('#diagnosticsDialog').open);
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), undefined);
  assert.equal(await page.evaluate(() => tide.world.data.participants['new-player']), '刚加入的伙伴');
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

test('启动失败时可以分别导出当前损坏存档和旧版独立进度', async t => {
  const page = await profile(t);
  await seedCheckpoint(page, 'orphan');
  await page.evaluate(async () => {
    const db = await (await import('./storage.js')).database();
    const tx = db.transaction('items', 'readwrite'), store = tx.objectStore('items');
    const checkpoint = store.get('checkpoint'), owner = store.get('identity');
    checkpoint.onsuccess = () => store.put({ ...checkpoint.result, at: checkpoint.result.at + 1 }, 'checkpoint');
    owner.onsuccess = () => store.put({ ...owner.result, nick: '旧版独立昵称' }, 'identity');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#networkStatus').textContent.includes('创建者'));
  await page.locator('#connect').click();
  const current = await exported(page, '#backup');
  const old = await exported(page, '[data-legacy-backup="live"]');
  assert.equal(current.identity.nick, '诊断专用昵称');
  assert(Object.values(current.checkpoint.world.fishes).some(fish => fish.actor === '孤儿鱼的身份'));
  assert.equal(old.identity.nick, '旧版独立昵称');
  assert.equal(old.checkpoint.at, current.checkpoint.at + 1);
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
  await upload({ ...backup, checkpoint: false });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('备份无效'));
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), undefined);
  await upload(backup);
  await page.waitForFunction(() => window.tide);
  assert.deepEqual(await page.evaluate(() => Object.keys(tide.world.data.roots)), [root]);
  assert.equal(await page.evaluate(async () => (await import('./storage.js')).get('saveGeneration')), 1);
});

test('导出从同一个读取事务取得存档和身份，跨页更换不会混入新身份', async t => {
  const page = await profile(t);
  const result = await page.evaluate(async () => {
    const { database, getMany, putMany } = await import('./storage.js');
    const checkpoint = { at: 1, world: { fishes: { a: { id: 'a' } } } };
    await putMany([['checkpoint', checkpoint], ['identity', '原身份']]);
    const db = await database(), original = IDBDatabase.prototype.transaction;
    let reads = 0, replaced;
    IDBDatabase.prototype.transaction = function(...args) {
      const tx = original.apply(this, args);
      if (this === db && args[1] !== 'readwrite' && ++reads === 1) {
        const writer = original.call(db, 'items', 'readwrite');
        writer.objectStore('items').put('新身份', ['checkpoint-meta', 'identity']);
        replaced = new Promise((resolve, reject) => { writer.oncomplete = resolve; writer.onabort = () => reject(writer.error); });
      }
      return tx;
    };
    try {
      const [saved, identity] = await getMany(['checkpoint', 'identity'], { observeCheckpoint: false });
      await replaced;
      return [saved.world.fishes.a.id, identity, reads];
    } finally { IDBDatabase.prototype.transaction = original; }
  });
  assert.deepEqual(result, ['a', '原身份', 1]);
});

test('损坏的分页行和重复编号都会令整批读取失败', async t => {
  const page = await profile(t);
  const errors = await page.evaluate(async () => {
    const { database, getMany, set } = await import('./storage.js');
    await set('checkpoint', { world: { fishes: { a: 1 } } });
    const db = await database(), errors = [];
    for (const rows of [[null], [['a', 1], ['a', 2]]]) {
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').put(rows, ['checkpoint-page', 'fishes', 0]);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      try { await getMany(['checkpoint', 'identity']); errors.push(null); }
      catch (error) { errors.push(error.message); }
    }
    return errors;
  });
  assert.deepEqual(errors, Array(2).fill('本地存档的记录页不完整'));
});

test('分页修复拒绝旧扫描和落后页面，提交或回滚覆盖存档、身份、镜像和代数', async t => {
  const page = await profile(t);
  const scan = await page.evaluateHandle(async () => {
    const { get, putMany } = await import('./storage.js');
    await putMany([['checkpoint', { at: 1, world: { tick: 1, fishes: { a: { tick: 1 } } } }], ['identity', '旧身份']], { generation: 0 });
    return get('checkpoint', { observeCheckpoint: false });
  });
  const other = await page.context().newPage();
  await other.goto(origin + '/fixture');
  await other.evaluate(async () => {
    const { get, putMany } = await import('./storage.js');
    await putMany([['checkpoint', await get('checkpoint')]], { generation: 0 });
  });
  const result = await page.evaluate(async scan => {
    const { database, get, getMany, putMany, replaceFromBackup, readHandoffCheckpoint } = await import('./storage.js');
    const db = await database();
    const checkpoint = tick => ({ at: tick, world: { tick, fishes: { a: { tick } } } });
    const errorFrom = async task => {
      try { await task; return null; }
      catch (error) { return { name: error.name, message: error.message }; }
    };
    const entries = [['checkpoint', checkpoint(2)], ['identity', '新身份']];
    const staleScan = await errorFrom(putMany(entries, { generation: 0, checkpoint: scan, replace: true }));
    const freshScan = await get('checkpoint', { observeCheckpoint: false });
    const stalePage = await errorFrom(putMany(entries, { generation: 0, checkpoint: freshScan, replace: true, requireObservedRevision: true }));
    const failedImport = await errorFrom(replaceFromBackup([...entries, ['known', () => {}]], { generation: 0, replace: true }));
    const before = await getMany(['checkpoint', 'identity', 'saveGeneration']);
    await putMany(entries, { generation: 0, checkpoint: freshScan, replace: true, mirrorLegacy: true });
    const staleSave = await errorFrom(putMany([['checkpoint', checkpoint(1)], ['identity', '旧身份']], { generation: 0 }));
    const handoff = await readHandoffCheckpoint();
    const legacy = await new Promise((resolve, reject) => {
      const tx = db.transaction('items'), store = tx.objectStore('items');
      const checkpoint = store.get('checkpoint'), owner = store.get('identity');
      tx.oncomplete = () => resolve([checkpoint.result.world.fishes.a.tick, owner.result]);
      tx.onabort = () => reject(tx.error);
    });
    await replaceFromBackup([['checkpoint', checkpoint(3)]], { generation: 1, replace: true });
    const afterImport = await errorFrom(putMany([['known', ['过时页面']]]));
    return { staleScan, stalePage, failedImport, staleSave, afterImport, before: [before[0].at, before[1], before[2] ?? 0],
      handoff: [handoff.checkpoint.world.fishes.a.tick, handoff.identity], handoffGeneration: handoff.generation, legacy, generation: await get('saveGeneration') };
  }, scan);
  await scan.dispose();
  assert.match(result.staleScan.message, /重新扫描/);
  assert.equal(result.stalePage.name, 'CheckpointConflictError');
  assert.equal(result.failedImport.name, 'DataCloneError');
  assert.deepEqual(result.before, [1, '旧身份', 0]);
  assert.match(result.staleSave.message, /刷新/);
  assert.deepEqual(result.handoff, [2, '新身份']);
  assert.deepEqual(result.legacy, result.handoff);
  assert.equal(result.handoffGeneration, 1);
  assert.match(result.afterImport.message, /载入备份/);
  assert.equal(result.generation, 2);
});

test('修复纯旧版存档后，旧页面改名不会改变新版身份和历史', async t => {
  const page = await profile(t);
  const result = await page.evaluate(async () => {
    const { database, get, putMany, readHandoffCheckpoint } = await import('./storage.js');
    const db = await database(), old = { at: 1, world: { fishes: { a: 1 } } };
    const write = callback => new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      callback(tx.objectStore('items'));
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    await write(store => {
      store.delete(['checkpoint-meta', 'identity']);
      store.put('迁移身份', 'identity'); store.put({ old: 1 }, 'histories'); store.put(['旧邀请'], 'known');
      store.put(old, 'checkpoint');
    });
    const scanned = await get('checkpoint');
    await putMany([['checkpoint', { ...old, at: 2 }]], { generation: 0, checkpoint: scanned, replace: true, mirrorLegacy: true });
    await write(store => {
      store.put('旧版改名', 'identity'); store.put({}, 'histories'); store.put([], 'known');
    });
    const handoff = await readHandoffCheckpoint();
    return [handoff.identity, handoff.histories, handoff.known, handoff.checkpoint.at];
  });
  assert.deepEqual(result, ['迁移身份', { old: 1 }, ['旧邀请'], 2]);
});

test('两个欢迎页同时注册时只有一个身份能够写入', async t => {
  const page = await profile(t);
  await page.evaluate(async () => {
    const db = await (await import('./storage.js')).database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').delete(['checkpoint-meta', 'identity']);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
  });
  const other = await page.context().newPage();
  await other.goto(origin + '/fixture');
  const register = (tab, nick) => tab.evaluate(async nick => {
    const { newIdentity } = await import('./storage.js');
    try { return { actor: (await newIdentity(nick, 0)).actor }; }
    catch (error) { return { error: error.message }; }
  }, nick);
  const attempts = await Promise.all([register(page, '甲'), register(other, '乙')]);
  assert.equal(attempts.filter(a => a.actor).length, 1);
  assert.match(attempts.find(a => a.error).error, /刷新/);
  const stored = await page.evaluate(async () => (await (await import('./storage.js')).get('identity')).actor);
  assert.equal(stored, attempts.find(a => a.actor).actor);
});

test('慢刷新显示恢复提示，旧版进度只提醒一次且仍可继续导出', async t => {
  let release, pending = false;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(release);
  const register = () => pending && blocked;
  const page = await profile(t, { register });
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  const roots = await page.evaluate(() => Object.keys(tide.world.data.roots));
  await page.goto(origin + '/fixture');
  await page.evaluate(async () => {
    const { database } = await import('./storage.js');
    const tx = (await database()).transaction('items', 'readwrite'), store = tx.objectStore('items');
    const saved = store.get('checkpoint');
    saved.onsuccess = () => store.put({ ...saved.result, at: saved.result.at + 1 }, 'checkpoint');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  });
  await page.addInitScript(() => {
    window.legacyToasts = 0;
    new MutationObserver(records => {
      if (records.some(({ target }) => target.id === 'toast' && target.textContent.includes('留着一份旧版进度'))) window.legacyToasts++;
    }).observe(document, { subtree: true, childList: true });
  });
  pending = true;
  const registering = page.waitForRequest(origin + '/local/register');
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await registering;
  await page.locator('#startupNotice').waitFor({ state: 'visible' });
  assert.match(await page.locator('#startupNotice').textContent(), /正在恢复这片海/);
  assert.equal(await page.evaluate(() => !!window.tide), false);
  pending = false;
  release();
  await page.waitForFunction(() => window.tide && legacyToasts === 1);
  await page.locator('#startupNotice').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => Object.keys(tide.world.data.roots)), roots);
  await page.reload();
  await page.waitForFunction(() => window.tide);
  assert.equal(await page.locator('[data-legacy-backup="live"]').count(), 0);
  await page.locator('#connect').click();
  const old = await exported(page, '[data-legacy-backup="live"]');
  assert.deepEqual(Object.keys(old.checkpoint.world.roots), roots);
  assert.equal(await page.evaluate(() => legacyToasts), 0);
});
