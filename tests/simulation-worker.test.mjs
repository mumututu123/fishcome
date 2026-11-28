import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, World, chooseClaim } from '../www/engine.js';
import { ARCHIVE_FIELDS, ArchiveStore, encodeArchive, prepareCompaction } from '../www/archive.js';
import { SimulationClient, startSimulationClock, subscribeSimulationChanges } from '../www/simulation-client.js';
import { WorkerSimulation } from '../www/simulation-worker.js';
import { expandSimulationPatch } from '../www/simulation-delta.js';
import { applyBondIntervals } from '../www/bond-interval.js';
import { lifeContext, updateLife } from '../www/life.js';
import { applyInputRows, setParticipantName, subscribeBeforeSimulationPatch, worldEdited } from '../www/simulation-changes.js';
import { CONTACT_TIME, updateContacts } from '../www/breeding.js';

const start = Date.UTC(2025, 5, 15, 12, 17);
const root = '00000000-0000-4000-8000-000000000012';

test('半秒时钟对齐存档步，提前醒来只等剩余时间，迟醒也不累积偏移', t => {
  let now = 1320, base = 1000, wake;
  const requested = [], updates = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { wake = callback; requested.push(delay); });
  startSimulationClock(() => base, () => updates.push(now));
  for (now of [1499, 1500, 2020, 2499, 2500]) wake();
  assert.deepEqual(updates, [1500, 2020, 2500]);
  assert.deepEqual(requested, [180, 1, 500, 480, 1, 500]);
  // A handoff can supply a future tick with a different phase. A clock jump
  // while suspended must also leave the next wake within one half-second.
  base = 3110;
  now = 3000; wake();
  assert.equal(requested.at(-1), 110);
  now = 1600; wake();
  assert.equal(requested.at(-1), 10);
  now = 7610; wake();
  assert.equal(requested.at(-1), 500);
});

test('连续八步的在途投喂按提交顺序入海，每步只计算一次', async () => {
  const world = new World(start, root, { populate: false, ambient: false });
  const worker = new WorkerSimulation(), operations = [];
  let requests = 0;
  const client = new SimulationClient(() => localWorker(async message => {
    if (message.kind !== 'step') return;
    const index = requests++;
    const op = { id: crypto.randomUUID(), kind: 'food', actor: 'visitor', nick: '喂鱼', x: index, y: 0, ch: '*', color: '#ace123', t: message.base, cost: 1 };
    operations.push(client.atStepBoundary(() => {
      assert.equal(world.data.tick, message.base + CONFIG.step);
      assert(world.apply(op).ok);
      return op.id;
    }));
  }, worker));
  try {
    await client.advance(world, start + 8 * CONFIG.step);
    const ids = await Promise.all(operations);
    assert.equal(requests, 8);
    assert.equal(world.data.tick, start + 8 * CONFIG.step);
    for (const id of ids) assert(world.data.chars[id]);
    for (const id of ids.slice(0, -1)) assert.deepEqual(world.data.chars[id], worker.world.data.chars[id]);
  } finally { client.close(); }
});
function localWorker(beforeReceive = () => {}, simulation = new WorkerSimulation()) {
  let closed = false;
  return {
    terminate() { closed = true; },
    postMessage(value) {
      const message = structuredClone(value);
      setImmediate(async () => {
        try {
          await beforeReceive(message);
          if (!closed) this.onmessage({ data: { result: structuredClone(simulation.receive(message)) } });
        }
        catch (error) { this.onmessage({ data: { error: error.message } }); }
      });
    }
  };
}

test('半秒结算把接触顺序完整交给页面，包括仍保留的旧配对', async () => {
  const world = new World(start, root, { populate: false, ambient: false });
  for (let i = 0; i < 4; i++) {
    const id = `00000000-0000-4000-8000-00000000000${i}`;
    const cells = [0, 1, 2].map(x => ({ x, y: 0, ch: 'Q', color: '#acaabc' }));
    assert(world.apply({ id, kind: 'fish', gender: i % 2 ? 'female' : 'male', actor: id, nick: '鱼',
      t: start, cost: 3, x: 20 + 20 * Math.floor(i / 2) + 3 * (i % 2), y: 20, cells }).ok);
  }
  updateContacts(world, start, world.fishGroups(), world.sceneryMap());
  const expected = Object.keys(world.data.contacts);
  assert.equal(expected.length, 2);
  world.data.contacts = Object.fromEntries(Object.entries(world.data.contacts).reverse());
  const worker = new WorkerSimulation(), client = new SimulationClient(() => localWorker(undefined, worker));
  try {
    // Use the normal contact decision while keeping the four bodies in place.
    await client.open(world, () => true);
    worker.world.step = now => {
      updateContacts(worker.world, now, worker.world.fishGroups(), worker.world.sceneryMap());
      worker.world.data.tick = now;
    };
    await client.advance(world, start + CONFIG.step);
    assert.deepEqual(Object.keys(world.data.contacts), expected);
    assert.deepEqual(world.data.contacts, worker.world.data.contacts);
  } finally { client.close(); }
});

test('追赶中在第一步交接真实归档，保留鱼的最后一餐并清除线程里的旧热行', async () => {
  const world = new World(start, root), store = new ArchiveStore(), worker = new WorkerSimulation();
  world.attachArchives(store);
  const fish = Object.keys(world.data.fishes)[0], at = start - 3600000;
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  records.chars.history = world.data.chars.history = { id: 'history', kind: 'burn', wild: { source: 'floor:1' },
    path: [{ reason: 'eat', target: fish, t: at }] };
  records.ops.edit = world.data.ops.edit = { id: 'edit', kind: 'sceneEdit', cell: 'history' };
  records.chats.old = { id: 'old', body: { t: at, roots: [root] } };
  delete world.data.chats;
  const chunk = await encodeArchive(records, world.data.roots);
  const issued = Promise.withResolvers(), resume = Promise.withResolvers();
  const client = new SimulationClient(() => localWorker(async message => {
    if (message.kind === 'step' && message.base === start) { issued.resolve(); await resume.promise; }
  }, worker));
  try {
    const run = client.advance(world, start + 20 * CONFIG.step);
    await issued.promise;
    const targets = new Set();
    await store.ingest(chunk, chooseClaim, targets);
    world.data.archives.chunks[chunk.manifest.id] = chunk.manifest;
    const compact = await prepareCompaction(world, store);
    let cut;
    const committed = client.archiveAtStepBoundary(world, () => {
      cut = world.data.tick;
      return { removed: compact(), meals: Array.from(targets, id => [id, store.summary.lastMeals.get(id), store.summary.grassMeals.has(id)]) };
    });
    assert(world.data.chars.history);
    resume.resolve();
    await committed;
    await run;
    assert.equal(cut, start + CONFIG.step);
    assert.equal(world.data.tick, start + 20 * CONFIG.step);
    for (const copy of [world, worker.world]) {
      assert.equal(copy.data.chars.history, undefined);
      assert.equal(copy.data.ops.edit, undefined);
      assert.equal(copy.archives.summary.lastMeals.get(fish), at);
      assert(copy.archives.summary.grassMeals.has(fish));
    }
    assert.equal(await store.get('chars', 'history').then(c => c.path[0].target), fish);
  } finally { resume.resolve(); client.close(); }
});

test('本地归档等待期间远端接手同一餐，下一步清除线程刚读到的旧进食记录', async () => {
  const world = new World(start, root, { populate: false, ambient: false });
  const worker = new WorkerSimulation(), client = new SimulationClient(() => localWorker(undefined, worker));
  const reading = Promise.withResolvers(), resume = Promise.withResolvers();
  async function meal(target, t) {
    const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
    records.chars.history = { id: 'history', kind: 'burn', wild: { source: 'floor:1' }, path: [{ reason: 'eat', target, t }] };
    return encodeArchive(records, world.data.roots);
  }
  const initial = await meal('A', start - 1), remote = await meal('B', start - 2), local = await meal('C', start - 3);
  const store = new ArchiveStore({ load: async () => {
    store.load = () => initial.encoded;
    reading.resolve();
    await resume.promise;
    return initial.encoded;
  } });
  world.attachArchives(store);
  try {
    await store.ingest(initial, chooseClaim);
    await client.advance(world, start + CONFIG.step);
    store.cache.clear();
    store.packs.clear();
    world.data.chars.history = local.raw.records.chars.history;
    const targets = new Set();
    const pending = store.ingest(local, chooseClaim, targets);
    await reading.promise;
    await store.ingest(remote, chooseClaim);
    worldEdited(world);
    await client.advance(world, start + 2 * CONFIG.step);
    assert.deepEqual([...worker.archive.summary.grassMeals], ['B']);
    resume.resolve();
    await pending;
    const compact = await prepareCompaction(world, store);
    await client.archiveAtStepBoundary(world, () => ({
      removed: compact(), meals: Array.from(targets, id => [id, store.summary.lastMeals.get(id), store.summary.grassMeals.has(id)])
    }));
    await client.advance(world, start + 3 * CONFIG.step);
    for (const summary of [store.summary, worker.archive.summary]) {
      assert.deepEqual([...summary.grassMeals], ['C']);
      assert.deepEqual([...summary.lastMeals], [['C', start - 3]]);
    }
  } finally { resume.resolve(); client.close(); }
});

test('后台模拟与同种子的前台基线逐步一致，已结束历史和创建凭据不进入线程', async () => {
  const a = new World(start, root), b = new World(start, root);
  for (const w of [a, b]) w.data.breeding.ended = { status: 'cancelled', at: start, id: 'ended' };
  const messages = [];
  const client = new SimulationClient(() => localWorker(message => {
    messages.push(message.kind);
    for (const [field, id, row] of message.rows || []) {
      assert(!(field === 'breeding' && id === 'ended'));
      assert(!(field === 'ops' && row.kind === 'fish'));
    }
  }));
  const stop = subscribeSimulationChanges((world, patch) => {
    if (world === b && patch) assert(!patch.tables.breeding?.set.some(([id]) => id === 'ended'));
  });
  try {
    for (let n = 1; n <= 35; n++) {
      a.step(start + n * CONFIG.step);
      await client.advance(b, start + n * CONFIG.step);
      assert.deepEqual(b.serialize(), a.serialize(), '第 ' + n + ' 步世界不同');
    }
    assert.equal(messages.filter(kind => kind === 'open').length, 1);
    assert.equal(messages.filter(kind => kind === 'step').length, 35);
  } finally { stop(); client.close(); }
});

test('玩家操作使正在计算的旧步骤失效，重算后保持操作和世界状态', async () => {
  const a = new World(start, root), b = new World(start, root);
  for (const world of [a, b]) world.data.life.at = start - 1000;
  let signal, resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const issued = new Promise(resolve => { signal = resolve; });
  const commands = [];
  const client = new SimulationClient(() => localWorker(async message => {
    commands.push(message.kind);
    if (message.kind === 'step') { signal(); await gate; }
  }));
  try {
    const pending = client.advance(b, start + CONFIG.step);
    await issued;
    const op = { id: crypto.randomUUID(), kind: 'food', actor: 'feed', nick: '玩家', x: 35, y: 0, ch: '*', color: '#ace123', t: start, cost: 1 };
    for (const w of [a, b]) assert(w.apply(op).ok);
    resume();
    await pending;
    assert.equal(b.data.tick, start);
    a.step(start + CONFIG.step);
    await client.advance(b, start + CONFIG.step);
    assert.deepEqual(b.serialize(), a.serialize());
    assert(commands.includes('restore'));
    assert.equal(commands.filter(kind => kind === 'open').length, 1);
  } finally { resume(); client.close(); }
});

test('后台只发送变化的鱼记录与当日行程，订阅者收到完整记录和有序鱼生关系', async () => {
  const expected = new World(start, root, { populate: false });
  const fishes = [1, 2, 3, 4].map(i => `10000000-0000-4000-8000-00000000000${i}`);
  for (const [i, id] of fishes.entries()) {
    const cells = Array.from({ length: 3 }, (_, x) => ({ x, y: 0, ch: 'Q', color: '#ace123' }));
    assert(expected.apply({ id, cells, actor: id, nick: '玩家', t: start, cost: 3, x: 20 + i * 5, y: 10, kind: 'fish' }).ok);
    expected.data.travel[id] = { since: start, days: { '2025-06-14': 41 } };
  }
  expected.data.life.at = start - 1000;
  const [a, b, c, d] = fishes;
  expected.data.life.bonds[`${c}|${d}`] = { run: 12, a: c, b: d, seconds: 12, at: start, lastNear: start };
  expected.data.life.bonds[`${a}|${d}`] = { a, b: d, seconds: 9, at: start, lastNear: start, run: 9 };
  const world = new World(start, root, { populate: false });
  world.data = expected.serialize();
  const sent = [], before = [], after = [];
  class ObservedWorker extends WorkerSimulation {
    receive(message) {
      const reply = super.receive(message);
      if (reply) sent.push(reply.patch);
      return reply;
    }
  }
  const client = new SimulationClient(() => localWorker(undefined, new ObservedWorker()));
  const stopBefore = subscribeBeforeSimulationPatch((target, patch) => {
    if (target === world) before.push({ tick: world.data.tick, life: world.data.life, patch });
  });
  const stopAfter = subscribeSimulationChanges((target, patch) => { if (target === world && patch) after.push(patch); });
  try {
    for (let i = 1; i <= 8; i++) {
      const now = start + i * CONFIG.step;
      const previous = world.data.life;
      expected.step(now);
      await client.advance(world, now);
      assert.deepEqual(world.serialize(), expected.serialize());
      assert.deepEqual(Object.keys(world.data.life.bonds), Object.keys(expected.data.life.bonds));
      for (const key of Object.keys(expected.data.life.bonds)) {
        assert.deepEqual(Object.keys(world.data.life.bonds[key]), Object.keys(expected.data.life.bonds[key]));
      }
      assert.equal(before.at(-1).tick, now - CONFIG.step);
      assert.equal(before.at(-1).life, previous);
      assert.equal(before.at(-1).patch, after.at(-1));
      for (const [id, fish] of after.at(-1).tables.fishes.set) assert.deepEqual(fish, world.data.fishes[id]);
    }
    for (const change of sent) for (const row of change.tables.fishes.set) {
      if (!Array.isArray(row)) { assert(change.tables.fishes.motion instanceof Float64Array); continue; }
      const [, fields] = row;
      assert.equal(Object.hasOwn(fields, 'actor'), false);
      assert.equal(Object.hasOwn(fields, 'id'), false);
    }
    const travel = sent.flatMap(change => change.tables.travel?.set || []);
    assert(travel.length > 0);
    for (const [, fields, , days] of travel) {
      if (typeof fields === 'string') assert.equal(fields, '2025-06-15');
      else {
        assert.equal(Object.hasOwn(fields, 'since'), false);
        assert.equal(Object.hasOwn(days[0], '2025-06-14'), false);
      }
    }
    const life = sent.find(change => change.life?.bonds);
    assert(life);
    assert.equal(Object.hasOwn(life.values, 'life'), false);
    assert(after.some(patch => patch.values.life?.bonds[`${a}|${b}`]));
  } finally { stopBefore(); stopAfter(); client.close(); }
});

test('初始化和推进期间频繁改名继续使用同一线程，下一次自然沉积取最新昵称', async () => {
  const w = new World(start, root, { populate: false, ambient: false });
  const op = { id: crypto.randomUUID(), kind: 'food', actor: 'visitor', nick: '旧名', x: 35, y: 0, ch: '*', color: '#ace123', t: start, cost: 1 };
  assert(w.apply(op).ok);
  Object.assign(w.data.chars[op.id], { y: w.floorAt(35) - 1, born: start - CONFIG.foodLife + CONFIG.step * 2 });
  const commands = [];
  const client = new SimulationClient(() => localWorker(message => {
    commands.push(message.kind);
    if (message.kind === 'ready') setParticipantName(w, op.actor, '初次连接');
    if (message.kind === 'step' && message.base === start) {
      assert(w.apply({ kind: 'earn', id: 'visitor:hour:1', serial: 1, actor: 'visitor', t: start, cost: 0 }).ok);
      assert(w.addChat({ kind: 'chat', actor: 'visitor', id: crypto.randomUUID(), body: { nick: '来客', roots: [root], t: start, text: '大家好' } }).ok);
      for (const nick of ['昵称甲', '昵称乙', '最后昵称']) setParticipantName(w, op.actor, nick);
    }
  }));
  try {
    await client.advance(w, start + 2 * CONFIG.step);
    assert.equal(w.data.tick, start + 2 * CONFIG.step);
    assert.equal(commands.filter(kind => kind === 'open').length, 1);
    assert.equal(w.data.scenes[w.data.chars[op.id].entity].nick, '最后昵称');
    assert.equal(w.wallet('visitor'), CONFIG.initial);
    assert.equal(Object.keys(w.data.chats).length, 1);
    assert.equal(setParticipantName(w, op.actor, '最后昵称'), false);
  } finally { client.close(); }
});

test('同一批前台变更公布所有人，重复更新同一个人只计算一次新增', () => {
  const world = new World(start, root, { populate: false });
  world.data.participants.c = '已有';
  const updates = [];
  const stop = subscribeSimulationChanges((w, patch) => { if (w === world) updates.push(patch); });
  try {
    applyInputRows(world, [['participants', 'a', '甲'], ['participants', 'b', '乙'], ['participants', 'a', '新甲'], ['participants', 'c', '新丙']]);
    const { set, addedCount } = updates[0].tables.participants;
    assert.deepEqual(set, [['a', '新甲'], ['b', '乙'], ['c', '新丙']]);
    assert.equal(addedCount, 2);
    assert.deepEqual(Object.fromEntries(set), world.data.participants);
  } finally { stop(); }
});

test('投喂使用单格候选并保留穿越边界的占用、重复投放和鱼元扣费规则', async () => {
  const w = new World(start, root, { populate: false, ambient: false });
  const cell = { kind: 'fish', entity: 'f', x: 1, y: -1 };
  w.data.fishes.f = { x: 0, y: 1, facing: -1 };
  w.data.chars.eye = cell;
  const food = { id: crypto.randomUUID(), kind: 'food', actor: 'visitor', nick: '玩家', x: CONFIG.width - 1, y: 0, ch: '*', color: '#ace123', t: start, cost: 1 };
  w.sceneryMap = w.fishMap = () => assert.fail('单格投喂不应构造全世界占用图');
  assert.equal(w.apply(food).ok, false);
  w.surfaceCandidates = x => x === CONFIG.width - 1 ? [cell] : [];
  assert.equal(w.apply(food).ok, false);
  food.x = 10;
  assert.equal(w.wallet('visitor'), CONFIG.initial);
  const updates = [];
  const stop = subscribeSimulationChanges((world, patch) => { if (world === w) updates.push(patch); });
  try {
    assert(w.apply(food).ok);
    assert(w.apply(food).duplicate);
    assert(w.apply({ ...food, id: crypto.randomUUID() }).ok);
    assert.equal(w.wallet('visitor'), CONFIG.initial - 2);
    assert.deepEqual(updates.map(patch => patch.tables.ops.addedCount), [1, 1]);
  } finally { stop(); }
});

test('后台接替先安置重叠鱼，再移动，并传回同一份几何修复结果', async () => {
  const a = new World(start, root), b = new World(start, root);
  for (const w of [a, b]) {
    const [first, second] = Object.values(w.data.fishes);
    Object.assign(second, { x: first.x, y: first.y });
  }
  const expected = a.reconcileGeometry(start + CONFIG.step);
  assert(expected.fishMoved > 0);
  a.step(start + CONFIG.step);
  const client = new SimulationClient(() => localWorker());
  try {
    let repaired;
    await client.advance(b, start + CONFIG.step, () => true, { geometry: true, done: result => { repaired = result; } });
    assert.deepEqual(repaired, expected);
    assert.deepEqual(b.serialize(), a.serialize());
  } finally { client.close(); }
});

test('后台出生完整保留新鱼、鱼元转移和家谱，并移除亲鱼当前配对', async () => {
  const a = new World(start, root, { populate: false, ambient: false });
  const ids = [];
  for (const [i, gender] of ['male', 'female'].entries()) {
    const id = crypto.randomUUID();
    ids.push(id);
    const cells = [0, 1, 2].map(x => ({ x, y: 0, ch: 'Q', color: '#acaabc' }));
    assert(a.apply({ id, gender, cells, actor: id, nick: '鱼', t: start, cost: 3, x: 20 + i * 3, y: 20, kind: 'fish' }).ok);
  }
  for (let i = 0; i <= CONTACT_TIME; i += CONFIG.step) updateContacts(a, start + i, a.fishGroups(), a.sceneryMap());
  const record = a.breedingState(ids[0]);
  a.data.tick = record.ends - CONFIG.step;
  const b = new World(start, root, { populate: false, ambient: false });
  b.data = a.serialize();
  assert(b.breedingState(ids[0]));
  const client = new SimulationClient(() => localWorker());
  try {
    a.step(record.ends);
    await client.advance(b, record.ends);
    assert.equal(b.data.breeding[record.id].status, 'born');
    assert.equal(b.breedingState(ids[0]), undefined);
    assert.deepEqual(b.serialize(), a.serialize());
  } finally { client.close(); }
});

test('线程故障保留已完成步骤并暂停，协调者重新接管后可恢复', async () => {
  const world = new World(start, root);
  let faulty, starts = 0;
  const client = new SimulationClient(() => {
    if (++starts > 1) return localWorker();
    faulty = { terminate() {}, postMessage() { setImmediate(() => this.onerror({ message: 'worker stopped' })); } };
    return faulty;
  });
  try {
    await assert.rejects(client.advance(world, start + CONFIG.step), /worker stopped/);
    for (let i = 0; i < 3; i++) await client.advance(world, start + CONFIG.step);
    assert.equal(world.data.tick, start);
    assert.equal(starts, 1);
    client.close();
    const resumed = client.advance(world, start + CONFIG.step);
    faulty.onerror({ message: 'previous worker' });
    await resumed;
    assert.equal(world.data.tick, start + CONFIG.step);
    assert.equal(starts, 2);
  } finally { client.close(); }
});

test('后台关系逐项修改、删除再加入和回滚都保留原始字段与顺序', () => {
  const world = new World(start, root, { populate: false }), worker = new WorkerSimulation();
  const bond = (a, b) => ({ a, b, seconds: 10, at: start, lastNear: start, run: 3 });
  const first = bond('a', 'b'), second = bond('c', 'd');
  world.data.life.bonds = { 'a|b': first, 'c|d': second };
  worker.receive({ kind: 'open', values: world.serialize(), tables: [], ambient: false });
  worker.receive({ kind: 'ready' });
  const table = worker.world.data.life.bonds;
  table['c|d'].seconds++;
  delete table['a|b'];
  table['a|b'] = { ...first, run: 4 };
  delete table['c|d'].run;
  const patch = worker.tracker.changes(), updated = expandSimulationPatch(world.data, patch).values.life;
  assert.deepEqual(Object.keys(updated.bonds), ['c|d', 'a|b']);
  assert.deepEqual(updated.bonds['c|d'], { a: 'c', b: 'd', seconds: 11, at: start, lastNear: start });
  assert.deepEqual(updated.bonds['a|b'], { ...first, run: 4 });
  worker.world.data.life.bonds = { 'a|b': { ...updated.bonds['a|b'], seconds: 30, legacy: true }, 'c|d': updated.bonds['c|d'] };
  worker.world.data.life.bonds['a|b'] = { ...worker.world.data.life.bonds['a|b'], run: 15 };
  const again = expandSimulationPatch({ life: updated }, worker.tracker.changes()).values.life;
  assert.deepEqual(Object.keys(again.bonds), ['a|b', 'c|d']);
  assert.deepEqual(again.bonds['a|b'], { ...first, seconds: 30, run: 15, legacy: true });
  worker.receive({ kind: 'restore', rows: [], previous: { life: structuredClone(world.data.life) }, foodRevision: 0 });
  assert.deepEqual(worker.world.readBonds(), world.data.life.bonds);
});

test('连续关系只交付进出名单，时间跳变、逐项编辑和回滚按实际版本复原', () => {
  const world = new World(start, root, { populate: false }), worker = new WorkerSimulation();
  const ids = Array.from({ length: 94 }, (_, i) => 'fish-' + String(i).padStart(3, '0'));
  for (const [i, id] of ids.entries()) {
    world.data.fishes[id] = { id, x: i % 5, y: 20, facing: 1 };
    world.data.chars[id] = { id, entity: id, kind: 'fish', x: 0, y: 0, path: [] };
  }
  worker.receive({ kind: 'open', values: world.serialize(), tables: [], ambient: false });
  worker.receive({ kind: 'ready' });
  let replica = { life: structuredClone(world.data.life) };
  function update(at, x) {
    worker.tracker.reset();
    for (const source of [world, worker.world]) {
      source.data.fishes[ids[0]].x = x;
      updateLife(source, at, lifeContext(source, at, source.sceneryMap(), source.fishGroups()));
    }
    const patch = worker.tracker.changes();
    replica = { life: expandSimulationPatch({ ...world.data, ...replica }, patch).values.life };
    assert.deepEqual(Object.keys(replica.life.bonds), Object.keys(world.data.life.bonds));
    assert.deepEqual(replica.life, world.data.life);
    return patch.life.bonds;
  }
  assert.equal(update(start + 1000, 1).intervals, undefined);
  const changed = update(start + 2000, 32);
  assert(changed.intervals && changed.keys.length > 0 && changed.keys.length < changed.intervals.length);
  assert.deepEqual(update(start + 3000, 32).keys, []);
  const key = Object.keys(replica.life.bonds)[100];
  assert.deepEqual(worker.world.data.life.bonds[key], replica.life.bonds[key]);
  worker.tracker.reset();
  worker.world.data.life.bonds[key].custom = true;
  world.data.life.bonds[key].custom = true;
  replica = { life: expandSimulationPatch(replica, worker.tracker.changes()).values.life };
  assert.deepEqual(replica.life, world.data.life);
  assert.equal(update(start + 4000, 32).intervals, undefined);
  assert(update(start + 5000, 32).intervals);
  assert.equal(update(start + 8000, 32).intervals, undefined);
  assert.equal(update(start + 6000, 32).intervals, undefined);
  worker.receive({ kind: 'restore', rows: [], previous: { life: structuredClone(replica.life) }, foodRevision: 0 });
  assert.equal(update(start + 7000, 32).intervals, undefined);
});

test('伙伴变更拒绝多余的位、不匹配的记录数、重复加入和中断的基准', () => {
  const at = start + 1000, previous = { 'a|b': { a: 'a', b: 'b', at: start, lastNear: start, seconds: 3599.25, run: 120 } };
  const change = { at, intervals: { before: 1, kept: [1], added: [2], length: 2 }, keys: ['b|c'] };
  assert.deepEqual(applyBondIntervals(previous, change), {
    'a|b': { a: 'a', b: 'b', seconds: 3600, at, lastNear: at, run: 120 },
    'b|c': { a: 'b', b: 'c', seconds: 1, at, lastNear: at, run: 0 }
  });
  for (const invalid of [
    { ...change, at: at + 1000 }, { ...change, keys: [] }, { ...change, keys: ['a|b'] },
    { ...change, intervals: { ...change.intervals, before: 2 } },
    { ...change, intervals: { ...change.intervals, kept: [2] } },
    { ...change, intervals: { ...change.intervals, kept: [0] } },
    { ...change, intervals: { before: 1, kept: [1], added: [], length: 0 }, keys: [] }
  ]) assert.throws(() => applyBondIntervals(previous, invalid));
});

test('长时间相处仍逐秒保留旧存档的小数舍入和熟鱼故事，旧表的编辑只影响旧表', () => {
  const world = new World(start, root, { populate: false }), worker = new WorkerSimulation(), key = 'a|b';
  for (const id of ['a', 'b', 'c']) {
    world.data.fishes[id] = { id, x: 3, y: 20, facing: 1 };
    world.data.chars[id] = { id, entity: id, kind: 'fish', x: 0, y: 0, path: [] };
  }
  world.data.life.bonds[key] = { a: 'a', b: 'b', seconds: 0.001, at: start, lastNear: start, run: 0.001 };
  worker.receive({ kind: 'open', values: world.serialize(), tables: [], ambient: false });
  worker.receive({ kind: 'ready' });
  let replica = { life: structuredClone(world.data.life) }, oldTable, oldRow;
  for (let i = 1; i <= 125; i++) {
    const at = start + 1000 * i;
    worker.tracker.reset();
    for (const source of [world, worker.world]) {
      updateLife(source, at, lifeContext(source, at, source.sceneryMap(), source.fishGroups()));
    }
    replica = { life: expandSimulationPatch(replica, worker.tracker.changes()).values.life };
    if (i === 1) { oldTable = worker.world.data.life.bonds; oldRow = oldTable['a|c']; }
    if (i === 3) { oldRow.seconds = 999; oldTable['b|c'].seconds = 888; }
    assert.deepEqual(replica.life, world.data.life);
    assert.deepEqual(worker.world.data.life.bonds[key], world.data.life.bonds[key]);
  }
  assert.equal(replica.life.stories['friend:a:b'].at, start + 45000);
});

test('游动同一步的进食、消亡和行程修订只交付一次，并保留其余鱼的位置', () => {
  const world = new World(start, root, { populate: false }), worker = new WorkerSimulation();
  const ids = ['gone', 'fed', 'swam'], day = '2025-06-15', now = start + CONFIG.step;
  for (const id of ids) {
    world.data.fishes[id] = { id, x: 0, y: 7, facing: 1, cx: 0, cy: 0, posAt: start };
    world.data.travel[id] = { since: start, days: { [day]: 3 } };
  }
  worker.receive({ kind: 'open', values: world.serialize(), tables: [], ambient: false });
  worker.receive({ kind: 'ready' });
  const sea = worker.world;
  sea.data.tick = now;
  for (const [i, id] of ids.entries()) {
    const fish = sea.readFish(id);
    fish.x = i + 1; fish.posAt = now;
    sea.journalSwim(sea.swimOrdinal(id), fish);
    sea.recordMovement(id, 1, now, day, sea.swimOrdinal(id));
  }
  delete sea.data.fishes.gone;
  delete sea.data.travel.gone;
  sea.data.fishes.fed.lastFed = now;
  sea.data.travel.fed.days[day] += 2;
  const patch = worker.tracker.changes(), expanded = expandSimulationPatch(world.data, patch, ids);
  for (const field of ['fishes', 'travel']) {
    const { set, remove } = expanded.tables[field];
    assert.deepEqual(remove, ['gone']);
    assert.deepEqual(set.map(([id]) => id).sort(), ['fed', 'swam']);
    for (const [id, record] of set) assert.deepEqual(record, sea.data[field][id]);
  }
  assert.equal(patch.tables.fishes.motion.length, 5);
  assert.equal(expanded.tables.travel.set.find(([id]) => id === 'fed')[1].days[day], 6);
});
