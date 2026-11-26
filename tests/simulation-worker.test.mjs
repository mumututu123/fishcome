import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, World } from '../www/engine.js';
import { SimulationClient, subscribeSimulationChanges } from '../www/simulation-client.js';
import { WorkerSimulation } from '../www/simulation-worker.js';
import { applyInputRows, setParticipantName } from '../www/simulation-changes.js';
import { CONTACT_TIME, updateContacts } from '../www/breeding.js';

const start = Date.UTC(2025, 5, 15, 12, 17);
const root = '00000000-0000-4000-8000-000000000012';
function localWorker(beforeReceive = () => {}) {
  const simulation = new WorkerSimulation();
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
