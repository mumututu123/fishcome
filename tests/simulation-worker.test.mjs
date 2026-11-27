import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, World, chooseClaim } from '../www/engine.js';
import { ARCHIVE_FIELDS, ArchiveStore, encodeArchive, prepareCompaction } from '../www/archive.js';
import { SimulationClient, subscribeSimulationChanges } from '../www/simulation-client.js';
import { WorkerSimulation } from '../www/simulation-worker.js';
import { applyInputRows, setParticipantName, subscribeBeforeSimulationPatch, worldEdited } from '../www/simulation-changes.js';
import { CONTACT_TIME, updateContacts } from '../www/breeding.js';

const start = Date.UTC(2025, 5, 15, 12, 17);
const root = '00000000-0000-4000-8000-000000000012';

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
    for (const change of sent) for (const [, fields] of change.tables.fishes.set) {
      assert.equal(Object.hasOwn(fields, 'actor'), false);
      assert.equal(Object.hasOwn(fields, 'id'), false);
    }
    const travel = sent.flatMap(change => change.tables.travel?.set || []);
    assert(travel.length > 0);
    for (const [, fields, , days] of travel) {
      assert.equal(Object.hasOwn(fields, 'since'), false);
      assert.equal(Object.hasOwn(days[0], '2025-06-14'), false);
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
