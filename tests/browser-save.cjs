const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');

const www = path.resolve(__dirname, '../www');
const oldArg = process.argv.find(value => value.startsWith('--legacy-ref='));
const oldCommit = oldArg && execFileSync('git', ['rev-parse', '--verify', oldArg.slice('--legacy-ref='.length) + '^{commit}'], { cwd: path.dirname(www), encoding: 'utf8' }).trim();
if (oldCommit) assert(/^[0-9a-f]{40}$/.test(oldCommit));
let origin, browser;
const server = http.createServer((request, response) => {
  const route = new URL(request.url, origin).pathname;
  if (route === '/local/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: origin } : { ok: true, clients: [], hints: [] }));
    return;
  }
  const legacy = oldCommit && route.startsWith('/legacy/');
  const asset = legacy ? route.slice('/legacy/'.length) || 'index.html' : route.slice(1) || 'index.html';
  const file = path.join(www, asset);
  if (!file.startsWith(www + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  if (legacy) {
    try { response.end(execFileSync('git', ['show', oldCommit + ':www/' + asset], { cwd: path.dirname(www) })); }
    catch { response.writeHead(404).end(); }
  } else response.end(fs.readFileSync(file));
});

async function exercisePages(page, count) {
  await page.goto(origin + '/welcome.html');
  const result = await page.evaluate(async count => {
    const { database, get, putMany, replaceFromBackup } = await import('./storage.js');
    const { noteCheckpointChanges } = await import('./checkpoint-pages.js');
    const db = await database();
    const legacy = { world: { tick: 1, breeding: { old: { status: 'born' } } } };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      tx.objectStore('items').put(legacy, 'checkpoint');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    if ((await get('checkpoint')).world.breeding.old.status !== 'born') throw new Error('无法读取旧版存档');

    const start = 1735689600000;
    const record = i => ({ id: 'r' + i, status: 'cancelled', male: 'm' + i, female: 'f' + i, started: start + i, at: start + i + 500, reason: 'parent-gone' });
    const world = { tick: 2, breeding: {} };
    for (let i = 0; i < count; i++) world.breeding['r' + i] = record(i);
    const save = () => putMany(() => [['known', [world.tick]], ['checkpoint', { at: world.tick, world }]], { simulationChanges: true });
    let pageWrites = 0, recordWrites = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (Array.isArray(key) && key[0] === 'checkpoint-page') { pageWrites++; recordWrites += value.length; }
      return originalPut.call(this, value, key);
    };
    const measure = async () => {
      pageWrites = recordWrites = 0;
      const frameTimes = [];
      let previous = await new Promise(requestAnimationFrame), frame;
      const observe = now => {
        frameTimes.push(now - previous);
        previous = now;
        frame = requestAnimationFrame(observe);
      };
      frame = requestAnimationFrame(observe);
      const t = performance.now();
      let ms;
      try {
        await save();
        ms = performance.now() - t;
        await new Promise(requestAnimationFrame);
      } finally { cancelAnimationFrame(frame); }
      return { ms, pageWrites, recordWrites, frames: frameTimes.length,
        maxFrameMs: Math.max(...frameTimes), framesOver50: frameTimes.filter(time => time > 50).length };
    };
    try {
      const initial = await measure();
      if (initial.recordWrites !== count) throw new Error('首次保存记录数不符');
      const mid = Math.floor(count / 2);
      world.tick++;
      world.breeding['r' + mid].reason = 'conflicting-pair';
      delete world.breeding.r0;
      world.breeding['r' + count] = record(count);
      noteCheckpointChanges(world, { tables: { breeding: { set: [['r' + mid, world.breeding['r' + mid]], ['r' + count, world.breeding['r' + count]]], remove: ['r0'] } } });
      const changed = await measure();
      const idle = await measure();
      if (changed.pageWrites !== 3 || changed.recordWrites > 768 || idle.pageWrites !== 0) throw new Error('少量更新或空闲保存重写了无关记录页');

      const t = performance.now();
      const saved = await get('checkpoint'), recoveryMs = performance.now() - t;
      if (saved.at !== 3 || saved.world.tick !== 3 || (await get('known'))[0] !== 3 || Object.hasOwn(saved.world.breeding, 'r0')) throw new Error('恢复版本或删除状态不一致');
      let n = 0;
      for (const id in saved.world.breeding) {
        n++;
        const row = saved.world.breeding[id];
        if (id !== 'r' + n || row.id !== id || row.male !== 'm' + n || row.female !== 'f' + n || row.status !== 'cancelled' ||
            row.started !== start + n || row.at !== start + n + 500 || row.reason !== (n === mid ? 'conflicting-pair' : 'parent-gone')) throw new Error('恢复内容或顺序错误 ' + id);
      }
      if (n !== count) throw new Error('恢复记录数量不符');
      // Foreground/import paths may mutate a row in place without sending individual record IDs.
      world.breeding.r1.reason = 'corrected';
      noteCheckpointChanges(world, null);
      const scanned = await measure();
      if (scanned.pageWrites !== 1 || scanned.recordWrites >= count) throw new Error('前台修改重写了无关记录页');
      if (count <= 2048) {
        if ((await get('checkpoint')).world.breeding.r1.reason !== 'corrected') throw new Error('前台修改未保存');
        const previous = world.tick;
        world.tick++;
        world.breeding.r1.reason = () => {};
        noteCheckpointChanges(world, { tables: { breeding: { set: [['r1', world.breeding.r1]], remove: [] } } });
        let failure;
        try { await save(); } catch (error) { failure = error.name; }
        if (failure !== 'DataCloneError' || (await get('known'))[0] !== previous || (await get('checkpoint')).at !== previous) throw new Error('失败写入未整笔回滚');
        world.breeding.r1.reason = 'retry';
        await save();
        if ((await get('checkpoint')).world.breeding.r1.reason !== 'retry') throw new Error('写入失败后的重试丢失改动');
        try { await replaceFromBackup([['known', () => {}]]); } catch (error) { if (error.name !== 'DataCloneError') throw error; }
        await replaceFromBackup([['checkpoint', { world: { fishes: { only: { x: 1 } } } }]]);
        let obsoleteWrite;
        try { await save(); } catch (error) { obsoleteWrite = error.message; }
        if (!obsoleteWrite) throw new Error('导入完成后旧页面仍能覆盖新存档');
        const imported = await get('checkpoint');
        if (imported.world.breeding || Object.keys(imported.world.fishes).join() !== 'only') throw new Error('导入后残留上一个世界的数据');
      }
      return { count, chromium: navigator.userAgent, initial, changed, idle, scanned, recoveryMs };
    } finally { IDBObjectStore.prototype.put = originalPut; }
  }, count);
  if (count > 2048) {
    await page.reload();
    result.coldRecoveryMs = await page.evaluate(async count => {
      const { get } = await import('./storage.js');
      const start = performance.now(), saved = await get('checkpoint'), elapsed = performance.now() - start;
      const rows = saved.world.breeding;
      if (Object.keys(rows).length !== count || rows.r1.reason !== 'corrected' || rows['r' + count].id !== 'r' + count || rows.r0) throw new Error('新页面恢复失败');
      return elapsed;
    }, count);
  }
  return result;
}

async function motionCheckpoint(page) {
  await page.goto(origin + '/welcome.html');
  await page.evaluate(async () => {
    const { get, putMany } = await import('./storage.js');
    const { beforeCheckpointPatch, noteCheckpointChanges } = await import('./checkpoint-pages.js');
    const { expandSimulationPatch } = await import('./simulation-delta.js');
    const ids = Array.from({ length: 768 }, (_, i) => 'fish-' + i);
    const world = { tick: 0, fishes: {}, travel: {} }, day = '2026-11-28';
    for (const id of ids) {
      world.fishes[id] = { id, x: 0, y: 0, facing: 1, cx: 0, cy: 0, posAt: 0 };
      world.travel[id] = { since: 0, days: { [day]: 0 } };
    }
    const save = () => putMany(() => [['checkpoint', { world }]], { simulationChanges: true });
    await save();
    function move(tick, indices) {
      const motion = new Float64Array(indices.length * 5);
      for (let i = 0; i < indices.length; i++) { motion[i * 5] = tick; motion[i * 5 + 2] = 1; }
      const patch = expandSimulationPatch(world, { values: { tick }, tables: {
        fishes: { set: indices, motion, remove: [] },
        travel: { set: indices, day, distances: Float64Array.from(indices, () => tick), remove: [] }
      } }, ids, true);
      beforeCheckpointPatch(world, patch);
      for (const [field, updates] of Object.entries(patch.tables)) updates.frame.commit(world[field]);
      world.tick = tick;
      noteCheckpointChanges(world, patch);
      if (Object.values(patch.tables).some(updates => updates.frame.pairs)) throw new Error('存档展开了额外的整批记录');
    }
    move(1, [0, 410]);
    const cut = JSON.stringify(world), original = IDBObjectStore.prototype.put, pages = [];
    let advanced = false;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = original.call(this, value, key);
      if (Array.isArray(key) && (key[1] === 'fishes' || key[1] === 'travel')) {
        pages.push([key[1], key[2]]);
        if (!advanced) { advanced = true; move(2, ids.map((_, i) => i)); }
      }
      return request;
    };
    try { await save(); } finally { IDBObjectStore.prototype.put = original; }
    if (!advanced || pages.length !== 4) throw new Error('稀疏运动没有只写入对应四页');
    if (JSON.stringify((await get('checkpoint', { observeCheckpoint: false })).world) !== cut) throw new Error('中途游动改变了正在写入的存档');
    await save();
    if (JSON.stringify((await get('checkpoint', { observeCheckpoint: false })).world) !== JSON.stringify(world)) throw new Error('下一次存档没有取得游动后的完整状态');
  });
}

async function replicaCheckpointJournal(page) {
  await page.goto(origin + '/welcome.html');
  const result = await page.evaluate(async () => {
    const { get, putMany } = await import('./storage.js');
    const { noteCheckpointChanges, noteCheckpointMerge } = await import('./checkpoint-pages.js');
    const world = { tick: 1, chars: Object.fromEntries(Array.from({ length: 9216 }, (_, n) => ['c' + n, { x: n }])), fishes: { f: { x: 1 } } };
    const save = () => putMany(() => [['checkpoint', { world }]], { simulationChanges: true });
    await save();
    const original = IDBObjectStore.prototype.get;
    let charReads = 0;
    IDBObjectStore.prototype.get = function (key) {
      if (Array.isArray(key) && key[1] === 'chars') charReads++;
      return original.call(this, key);
    };
    const merge = (ids, apply) => {
      const edit = {};
      noteCheckpointChanges(world, null, edit);
      apply();
      edit.chars = new Set(ids);
      noteCheckpointMerge(world, edit);
    };
    const check = async () => {
      charReads = 0;
      await save();
      const saved = await get('checkpoint', { observeCheckpoint: false });
      if (JSON.stringify(saved.world) !== JSON.stringify(world)) throw new Error('合流后的存档内容或字典顺序不一致');
      return charReads;
    };
    try {
      world.chars.c1 = { x: -1 };
      noteCheckpointChanges(world, { tables: { chars: { set: [['c1', world.chars.c1]], remove: [] } } });
      merge(['c400'], () => { world.chars.c400.x = 77; world.fishes.f.x = 99; });
      const precise = await check();
      merge(['c1'], () => { delete world.chars.c1; });
      merge(['c1'], () => { world.chars.c1 = { x: 11 }; });
      const reordered = await check();
      noteCheckpointChanges(world, null, {});
      world.chars.c600.x = -2;
      merge([], () => { world.fishes.f.x++; });
      const interrupted = await check();
      const put = IDBObjectStore.prototype.put;
      merge(['c600'], () => { world.chars.c600.x = -3; });
      let rejected;
      try {
        IDBObjectStore.prototype.put = function (value, key) {
          if (Array.isArray(key) && key[1] === 'chars') throw new Error('中断合流存档');
          return put.call(this, value, key);
        };
        await save();
      } catch (error) { rejected = error.message; }
      finally { IDBObjectStore.prototype.put = put; }
      const durable = await get('checkpoint', { observeCheckpoint: false });
      await check();
      const changed = Object.keys(world.chars).filter((_, n) => n % 256 === 0);
      merge(changed, () => { for (const id of changed) world.chars[id].x++; });
      await check();
      const packed = (await get(['checkpoint-page', 'chars', 0])).length;
      merge(['c8000'], () => { world.chars.c8000.path = Array.from({ length: 48 }, (_, n) => ({ reason: 'eat', t: n })); });
      await check();
      merge(changed, () => { for (const id of changed) world.chars[id].x++; });
      await check();
      const longHistory = (await get(['checkpoint-page', 'chars', 0])).length;
      return { precise, reordered, interrupted, rejected, beforeRetry: durable.world.chars.c600.x, packed, longHistory };
    } finally { IDBObjectStore.prototype.get = original; }
  });
  assert.equal(result.precise, 0);
  assert(result.reordered > 0 && result.interrupted > 0);
  assert.equal(result.rejected, '中断合流存档');
  assert.equal(result.beforeRetry, -2);
  assert.equal(result.packed, 1024);
  assert.equal(result.longHistory, 256);
}

async function detachedReplicaCheckpoint(page) {
  await page.goto(origin + '/welcome.html');
  await page.evaluate(async () => {
    const { get, putMany, atCheckpointBoundary } = await import('./storage.js');
    const { noteCheckpointChanges, noteCheckpointMerge } = await import('./checkpoint-pages.js');
    const world = {
      tick: 1, roots: { home: 1 }, participants: { local: '甲' }, chats: {}, chatSources: {},
      ops: { first: { id: 'first' }, old: { id: 'old' } },
      chars: Object.fromEntries(Array.from({ length: 800 }, (_, i) => ['c' + i, { kind: 'fish', path: [] }])),
      fishes: { f: { x: 1, parents: ['p'] } }, travel: { f: { days: { today: 1 } } },
      breeding: { pair: { status: 'active' } }, scenes: { s: { x: 1 } }, life: { history: [1] }
    };
    const save = (captureCheckpoint = false) => putMany(() => [
      ['checkpoint', { world, picture: { tick: world.tick } }], ['known', [world.tick]]
    ], { simulationChanges: true, captureCheckpoint });
    const edit = (incoming, archived, chars, act) => {
      const handle = {};
      noteCheckpointChanges(world, null, handle);
      act();
      handle.chars = new Set(chars);
      noteCheckpointMerge(world, handle, incoming, archived);
    };
    await save();
    edit({ ops: { new: {} }, roots: world.roots, chats: { m: { id: 'm', actor: 'guest' } } },
      { ops: { old: {} } }, ['c500', 'c700'], () => {
        world.tick++;
        delete world.ops.old;
        world.ops.new = { id: 'new' };
        world.chats.m = { id: 'm', actor: 'guest' };
        world.participants.guest = '乙';
        world.chars.c500.path.push({ reason: 'birth' });
        delete world.chars.c700;
        world.travel.f.days.today++;
      });
    const expected = JSON.stringify(world);
    const original = IDBObjectStore.prototype.get;
    let during = false, completed;
    IDBObjectStore.prototype.get = function (key) {
      const request = original.call(this, key);
      if (!during && Array.isArray(key) && key[1] === 'chars') {
        during = true;
        completed = atCheckpointBoundary(world, () => {
          edit({ ops: {}, participants: { guest: '丙' } }, {}, ['c100', 'c500'], () => {
            world.tick++;
            world.chars.c100.path.push({ reason: 'eat' });
            world.chars.c500.path.push({ reason: 'burn' });
            world.fishes.f.parents.push('q');
            world.travel.f.days.today++;
            delete world.scenes.s;
            world.breeding.pair.status = 'cancelled';
            world.life.history.push(2);
            world.participants.guest = '丙';
          });
        });
        if (world.tick !== 3) throw new Error('普通合流等待了独立存档的读盘');
      }
      return request;
    };
    let first;
    try { first = await save(true); } finally { IDBObjectStore.prototype.get = original; }
    await completed;
    if (!during || JSON.stringify(first.world) !== expected || first.picture.tick !== 2 ||
        (await get('known'))[0] !== 2) throw new Error('并发合流改变了已截取的版本或配套记录');
    const put = IDBObjectStore.prototype.put;
    let failed = false;
    IDBObjectStore.prototype.put = function (value, key) {
      if (Array.isArray(key) && key[1] === 'chars') throw new Error('中断独立存档');
      return put.call(this, value, key);
    };
    try { await save(); } catch (error) { failed = error.message === '中断独立存档'; }
    finally { IDBObjectStore.prototype.put = put; }
    if (!failed || JSON.stringify((await get('checkpoint', { observeCheckpoint: false })).world) !== expected ||
        (await get('known'))[0] !== 2) throw new Error('存档失败时未保留完整旧版本');
    await save();
    const last = await get('checkpoint', { observeCheckpoint: false });
    if (last.picture.tick !== 3 || (await get('known'))[0] !== 3 ||
        JSON.stringify(last.world) !== JSON.stringify(world)) throw new Error('重试后的记录或插入顺序错误');
  });
}

async function concurrentCheckpoints(context) {
  const writer = await context.newPage(), other = await context.newPage();
  await Promise.all([writer.goto(origin + '/welcome.html'), other.goto(origin + '/welcome.html')]);
  const snapshot = await writer.evaluate(async () => {
    const { atCheckpointBoundary, putMany } = await import('./storage.js');
    const { beforeCheckpointPatch, noteCheckpointChanges } = await import('./checkpoint-pages.js');
    const world = { tick: 1, fishes: {} };
    for (let i = 0; i < 16384; i++) world.fishes['f' + i] = { x: i };
    const save = (captureCheckpoint = true) => putMany(() => [['known', ['local']], ['checkpoint', { world, at: world.tick }]], { simulationChanges: true, captureCheckpoint });
    const original = IDBObjectStore.prototype.put;
    let edited = false, merged;
    IDBObjectStore.prototype.put = function(value, key) {
      if (!edited && Array.isArray(key)) {
        edited = true;
        queueMicrotask(() => {
          const patch = { tables: { fishes: { set: [['f12000', { x: -3 }], ['new', { x: -1 }]], remove: ['f15000'] } } };
          beforeCheckpointPatch(world, patch);
          delete world.fishes.f15000;
          for (const [id, row] of patch.tables.fishes.set) world.fishes[id] = row;
          world.tick++;
          noteCheckpointChanges(world, patch);
          merged = atCheckpointBoundary(world, () => {
            world.fishes.f10000.x = -10;
            noteCheckpointChanges(world, null);
          });
          if (world.fishes.f10000.x !== 10000) throw new Error('原地合流覆盖了正在读取的存档');
        });
      }
      return original.call(this, value, key);
    };
    try {
      const before = await save();
      await merged;
      const after = await save();
      window.persistWorld = save;
      return [before.at, before.world.fishes.f12000.x, before.world.fishes.f15000.x, !!before.world.fishes.new,
        after.at, after.world.fishes.f12000.x, !!after.world.fishes.f15000, after.world.fishes.new.x,
        before.world.fishes.f10000.x, after.world.fishes.f10000.x];
    } finally { IDBObjectStore.prototype.put = original; }
  });
  assert.deepEqual(snapshot, [1, 12000, 15000, false, 2, -3, false, -1, 10000, -10]);
  await other.evaluate(async () => {
    const { putMany } = await import('./storage.js');
    await putMany([['known', ['newer']], ['checkpoint', { at: 12, world: { tick: 12, fishes: { alien: { x: 9 } }, scenes: { scene: {} } } }]]);
  });
  const conflicts = await writer.evaluate(async () => {
    const errors = [];
    for (let i = 0; i < 2; i++) try { await window.persistWorld(false); } catch (error) { errors.push(error.message); }
    return errors;
  });
  assert.equal(conflicts.length, 2);
  assert(conflicts.every(message => message.includes('另一个页面已保存更新')));
  const replica = await writer.evaluate(async () => {
    const local = await window.persistWorld(true);
    return [local.at, Object.keys(local.world.fishes).length, local.world.fishes.new.x, !!local.world.fishes.alien];
  });
  assert.deepEqual(replica, [2, 16384, -1, false]);
  const restored = await other.evaluate(async () => {
    const { get } = await import('./storage.js'), { world } = await get('checkpoint');
    return [world.tick, Object.keys(world.fishes).length, world.fishes.alien.x, !!world.fishes.new, !!world.scenes, await get('known')];
  });
  assert.deepEqual(restored, [12, 1, 9, false, true, ['newer']]);
}

async function exerciseLegacy(page) {
  const old = await page.context().newPage();
  await old.goto(origin + '/welcome.html');
  const nick = '旧版独立身份', message = '旧版独立进度';
  if (oldCommit) {
    await old.evaluate(async nick => {
      const { get, set } = await import('/legacy/storage.js');
      const identity = await get('identity'); identity.nick = nick; await set('identity', identity);
    }, nick);
    await old.goto(origin + '/legacy/');
    await old.waitForFunction(nick => window.tide?.identity.nick === nick, nick);
    await old.locator('#chatInput').fill(message);
    await old.locator('#chatForm button').click();
    await old.waitForFunction(async text => {
      const { get } = await import('/legacy/storage.js');
      return Object.values((await get('checkpoint')).world.chats).some(chat => chat.body.text === text);
    }, message);
  } else {
    // v0.2.3 writes plain identity and world values to these original v1 keys.
    await old.evaluate(async nick => {
      const db = await (await import('/storage.js')).database();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('items', 'readwrite'), store = tx.objectStore('items');
        const cp = store.get('checkpoint'), me = store.get('identity');
        cp.onsuccess = () => { const { world, at, picture, lastOnlineAt } = cp.result; store.put({ world, at: at + 1, picture, lastOnlineAt }, 'checkpoint'); };
        me.onsuccess = () => store.put({ ...me.result, nick }, 'identity');
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
    }, nick);
  }
  await old.close();
  assert.notEqual(await page.evaluate(() => tide.identity.nick), nick);
  await page.locator('#closeConnection').click();
  await page.locator('#connect').click();
  const downloading = page.waitForEvent('download');
  await page.locator('[data-legacy-backup="live"]').click();
  const bytes = [];
  for await (const part of await (await downloading).createReadStream()) bytes.push(part);
  const backup = JSON.parse(Buffer.concat(bytes).toString('utf8'));
  assert.equal(backup.identity.nick, nick);
  assert.equal(backup.format, 'tide-backup-1');
  if (oldCommit) assert(Object.values(backup.checkpoint.world.chats).some(chat => chat.body.text === message));
  await page.evaluate(async () => {
    const { get, putMany } = await import('/storage.js');
    const checkpoint = await get('checkpoint');
    await putMany([['checkpoint', checkpoint]], { mirrorLegacy: true });
  });
  await page.locator('#closeConnection').click();
  await page.locator('#connect').click();
  await page.locator('[data-legacy-backup]:not([data-legacy-backup="live"])').first().waitFor();
  const legacy = await page.evaluate(async () => {
    const { getOldBranch } = await import('/storage.js');
    const id = document.querySelector('[data-legacy-backup]').dataset.legacyBackup;
    const archived = await getOldBranch(id);
    return [archived.identity.nick, !!archived.checkpoint.world];
  });
  assert.deepEqual(legacy, [nick, true]);
  if (oldCommit) {
    const rollback = await page.context().newPage();
    await rollback.goto(origin + '/legacy/');
    await rollback.waitForFunction(() => window.tide);
    assert.notEqual(await rollback.evaluate(() => tide.identity.nick), nick);
    assert.deepEqual(await rollback.evaluate(() => Object.keys(tide.world.data.roots)), await page.evaluate(() => Object.keys(tide.world.data.roots)));
    await rollback.close();
  }
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const countArg = process.argv.find(value => value.startsWith('--records='));
  const count = countArg ? Number(countArg.slice('--records='.length)) : 1537;
  assert(Number.isSafeInteger(count) && count >= 1024);
  const isolated = await browser.newContext();
  try {
    console.log(JSON.stringify(await exercisePages(await isolated.newPage(), count)));
    if (!countArg) {
      await motionCheckpoint(await isolated.newPage());
      await replicaCheckpointJournal(await isolated.newPage());
      await detachedReplicaCheckpoint(await isolated.newPage());
      await concurrentCheckpoints(isolated);
    }
  }
  finally { await isolated.close(); }
  if (countArg) return;
  const appContext = await browser.newContext();
  const page = await appContext.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    const { World } = await import('/engine.js');
    const { subscribeSimulationChanges } = await import('/simulation-client.js');
    World.prototype.step = () => { throw new Error('页面主线程执行了模拟步骤'); };
    window.completedSimulationSteps = 0;
    subscribeSimulationChanges((_, patch) => { if (patch?.values.tick) window.completedSimulationSteps++; });
  });
  await page.locator('#nickInput').fill('自动存档测试');
  await page.locator('#welcomeForm .primary').click();
  await page.waitForFunction(() => window.tide);
  await page.waitForFunction(() => window.completedSimulationSteps >= 2);
  assert(page.workers().some(worker => new URL(worker.url()).pathname === '/simulation-worker.js'));

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

  await exerciseLegacy(page);
  backup.identity.nick = '恢复存档测试';
  const imported = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.locator('#importBackup').setInputFiles({
    name: '测试备份.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup))
  });
  await imported;
  await page.waitForFunction(() => window.tide?.identity.nick === '恢复存档测试');
  await page.goto(origin + '/welcome.html');
  await page.goto(origin);
  await page.waitForFunction(() => window.tide);
  assert.deepEqual(await page.evaluate(() => Object.keys(tide.world.data.roots)), before.roots);
  console.log('Chromium 验证通过：增量存档、跨标签版本冲突、失败回滚、备份导出导入、重新打开');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.closeAllConnections();
  server.close();
});
