import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, World, chooseClaim } from '../www/engine.js';
import { ARCHIVE_FIELDS, ArchiveStore, encodeArchive, prepareCompaction } from '../www/archive.js';
import { SimulationClient, startSimulationClock, subscribeSimulationChanges } from '../www/simulation-client.js';
import { WorkerSimulation, simulationBuffers } from '../www/simulation-worker.js';
import { expandSimulationPatch } from '../www/simulation-delta.js';
import { applyBondIntervals, compareBondIntervals } from '../www/bond-interval.js';
import { LIFE, lifeContext, updateLife } from '../www/life.js';
import { applyInputRows, setParticipantName, subscribeBeforeSimulationPatch, worldEdited, worldRevision } from '../www/simulation-changes.js';
import { CONTACT_TIME, updateContacts } from '../www/breeding.js';
import { orderedCheckpoint } from '../www/ordered-session.js';
import { FishStepProof } from '../www/fish-step-proof.js';

const start = Date.UTC(2025, 5, 15, 12, 17);
const root = '00000000-0000-4000-8000-000000000012';

test('连续观察只提交按原次序留下、新增和离开的伙伴', () => {
  const names = Array.from({ length: 300 }, (_, i) => 'a|' + String(i).padStart(4, '0'));
  for (const [before, after] of [[[], names], [names, []], [names, names],
    [names.filter((_, i) => i % 3), names.filter((_, i) => i % 5)]]) {
    const { removed, patch } = compareBondIntervals(before, after, start);
    assert.deepEqual(removed, before.filter(key => !after.includes(key)));
    assert.deepEqual(patch.keys, after.filter(key => !before.includes(key)));
    const selected = (rows, bits) => rows.filter((_, i) => bits[i >>> 3] & (1 << (i & 7)));
    assert.deepEqual(selected(before, patch.intervals.kept), after.filter(key => before.includes(key)));
    assert.deepEqual(selected(after, patch.intervals.added), patch.keys);
  }
});

test('同一步从权威鱼行核对位置、字段顺序、旧档扩展和跨页鱼序', async () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({
    id: 'fish' + i, x: i, y: 20, facing: 1, cx: 0, cy: 0, posAt: start, lineage: { parents: ['甲'] }
  }));
  const refs = rows.map((_, i) => i), observer = new FishStepProof();
  const prove = (writer = observer) => writer.records(refs, i => 'f' + i, id => rows[Number(id.slice(1))]);
  let prior = await prove();
  const equalCold = async () => {
    const next = await prove();
    assert.deepEqual(next, await prove(new FishStepProof()));
    return next;
  };
  rows[129].x += 0.125;
  let next = await equalCold();
  assert.deepEqual(next.pages, prior.pages);
  assert.notEqual(next.positions, prior.positions);
  for (const edit of [
    () => { rows[129].lineage.parents[0] = '乙'; },
    () => { rows[129].extra = null; },
    () => { rows[129].extra = undefined; },
    () => { const { id } = rows[129]; delete rows[129].id; rows[129].id = id; },
    () => { rows[129].facing = '旧档值'; },
    () => { refs.reverse(); }
  ]) {
    prior = next;
    edit();
    next = await equalCold();
    assert.notDeepEqual(next.pages, prior.pages);
  }
});

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
          if (!closed) {
            const result = await simulation.receive(message);
            this.onmessage({ data: { result: structuredClone(result, { transfer: simulationBuffers(result?.patch) }) } });
          }
        }
        catch (error) { this.onmessage({ data: { error: error.message } }); }
      });
    }
  };
}

test('连续两次已核合流只更新热线程里变过的鱼元，保留旧字段、顺序和后续生态结果', async () => {
  const make = () => new World(start, root, { populate: false, ambient: false });
  const replica = make(), authority = make();
  const op = { id: crypto.randomUUID(), kind: 'food', actor: 'visitor', nick: '甲', x: 5, y: 0, ch: '鱼', color: '#ace123', t: start, cost: 1 };
  for (const world of [replica, authority]) {
    world.attachArchives(new ArchiveStore());
    assert.ok(world.apply(op).ok);
    world.data.chars[op.id].former = { words: ['旧记录'] };
  }
  const workers = [], sent = [], cold = new SimulationClient(() => localWorker());
  const client = new SimulationClient(() => {
    const simulation = new WorkerSimulation();
    workers.push(simulation);
    return localWorker(message => sent.push(message), simulation);
  });
  try {
    await client.prepareAgreed(replica, () => true);
    const revisionAtHello = worldRevision(replica);
    const hello = authority.serialize();
    hello.chars[op.id].ecoGraceAt = start + 500;
    replica.data.chars[op.id].ecoGraceAt = start + 1000;
    const unchanged = { ...op, id: crypto.randomUUID(), t: start };
    assert.ok(replica.apply(unchanged).ok);
    assert.ok(authority.apply(unchanged).ok);
    hello.chars[unchanged.id] = authority.data.chars[unchanged.id];
    hello.ops[unchanged.id] = authority.data.ops[unchanged.id];
    // A locally winning claim can still take the earlier grace time from its
    // peer. An equal new foreground operation remains in the client's input queue.
    const joined = replica.merge(hello, {}, undefined, 'join');
    assert.deepEqual([...joined.chars], [op.id]);
    await client.followVerifiedReplica(replica, start, revisionAtHello, joined, () => true);
    assert.equal(workers.length, 1);
    assert.equal(JSON.stringify(workers[0].world.data.chars), JSON.stringify(replica.data.chars));
    for (let n = 1; n <= 2; n++) {
      const prior = replica.data.tick, revision = worldRevision(replica);
      const input = { ...op, id: crypto.randomUUID(), t: prior };
      assert.ok(authority.apply(input).ok);
      const incoming = { ...authority.serialize(), chars: { [input.id]: authority.data.chars[input.id] }, tick: prior + CONFIG.step };
      const changes = replica.merge(incoming, {}, 'replica', true);
      assert.deepEqual([...changes.chars], [input.id]);
      sent.length = 0;
      await client.followVerifiedReplica(replica, prior, revision, changes, () => true);
      assert.ok(sent.find(message => message.kind === 'open').rebase);
      assert.deepEqual(sent.flatMap(message => (message.rows || []).filter(row => row[0] === 'chars').map(row => row[1])), [input.id]);
      assert.ok(sent.every(message => message.kind !== 'step'));
      assert.equal(workers.length, 1);
      assert.equal(JSON.stringify(workers[0].world.data.chars), JSON.stringify(replica.data.chars));
    }
    const copy = make();
    copy.data = replica.serialize();
    copy.attachArchives(new ArchiveStore());
    for (let n = 0; n < 3; n++) {
      const results = await Promise.all([[client, replica], [cold, copy]].map(async ([sim, world]) =>
        sim.advanceAgreed(world, world.data.tick + CONFIG.step, () => true, await sim.prepareAgreed(world, () => true))));
      assert.equal(results[0].changesDigest, results[1].changesDigest);
      assert.equal(JSON.stringify(replica.data), JSON.stringify(copy.data));
    }
    const revision = worldRevision(replica), prior = replica.data.tick;
    worldEdited(replica);
    await client.followVerifiedReplica(replica, prior - CONFIG.step, revision, { chars: new Set() }, () => true);
    assert.equal(workers.length, 1);
    await client.prepareAgreed(replica, () => true);
    assert.equal(workers.length, 2);
    assert.equal(sent.findLast(message => message.kind === 'open').rebase, undefined);
  } finally { client.close(); cold.close(); }
});

test('旧伙伴线程只复用逐页一致的鱼元，补齐换序、增删和未知字段，过期检查点重装', async () => {
  const world = new World(start, root, { populate: false, ambient: false });
  const store = new ArchiveStore();
  world.attachArchives(store);
  const make = id => ({ id, payer: 'a', kind: 'burn', entity: '', x: 1, y: 1, path: [], created: start, old: { nested: [id] } });
  const ids = Array.from({ length: 300 }, (_,i) => 'c' + i);
  world.data.chars = Object.fromEntries(ids.map(id => [id, make(id)]));
  const simulations = [], opens = [], sent = [];
  const client = new SimulationClient(() => {
    const worker = new WorkerSimulation();
    simulations.push(worker);
    return localWorker(message => {
      if (message.kind === 'open') opens.push(message);
      if (message.kind === 'rows') for (const [field, id] of message.rows) if (field === 'chars') sent.push(id);
    }, worker);
  });
  try {
    await client.prepareAgreed(world, () => true);
    await client.checkRetained(world);
    // The middle page is unchanged but now comes first. A revised legacy field
    // and a removed/replaced record require sending the two other pages.
    const reordered = [...ids.slice(128, 256), ...ids.slice(0,128), ...ids.slice(256, 299), 'new'];
    worldEdited(world);
    world.data.chars = Object.fromEntries(reordered.map(id => [id, world.data.chars[id] || make(id)]));
    world.data.chars.c3.old.nested.push('变更');
    const before = sent.length;
    const cut = await orderedCheckpoint(world, store);
    await client.prepareAgreed(world, () => true, cut.characterPages);
    assert.equal(simulations.length, 1);
    assert.equal(opens.at(-1).characters[0], 1);
    assert.deepEqual(sent.slice(before), reordered.slice(128));
    assert.equal(JSON.stringify(simulations[0].world.data.chars), JSON.stringify(world.data.chars));

    await client.checkRetained(world);
    worldEdited(world);
    const stale = await orderedCheckpoint(world, store);
    applyInputRows(world, [['chars', 'added', make('added')]]);
    await client.prepareAgreed(world, () => true, stale.characterPages);
    assert.equal(simulations.length, 2);
    assert.equal(opens.at(-1).characters, undefined);
    assert.equal(JSON.stringify(simulations[1].world.data.chars), JSON.stringify(world.data.chars));
  } finally { client.close(); }
});

test('尚未在本机计算过的伙伴提前装鱼元，沿途普通同步继续提交，到共同点只补差异', async () => {
  const world = new World(start, root, { populate: false, ambient: false });
  const store = new ArchiveStore();
  world.attachArchives(store);
  const ids = Array.from({length:640},(_,i)=>'id' + i);
  for (const id of ids) world.data.chars[id] = { id, kind:'burn', entity:'', created:start, path:[] };
  let inSeed = true, changed = false, steps = 0;
  const loads = [], workers = [];
  const client = new SimulationClient(() => {
    const worker = new WorkerSimulation();
    workers.push(worker);
    return localWorker(message => {
      if (message.kind === 'open') loads.push(message);
      if (message.kind === 'step') steps++;
      if (inSeed && message.kind === 'rows' && !changed) {
        changed = true;
        worldEdited(world);
        world.data.tick += CONFIG.step;
        world.data.chars[ids[0]] = { ...world.data.chars[ids[0]], olderField: 1 };
      }
    },worker);
  });
  try {
    await client.checkRetained(world);
    inSeed = false;
    assert.equal(changed,true);
    assert.equal(client.owner,null);
    assert.equal(client.hasSavedCharacters(world),true);
    const cut = await orderedCheckpoint(world,store);
    assert.ok(await client.prepareAgreed(world,()=>true,cut.characterPages));
    assert.equal(workers.length,1);
    assert.equal(steps,0);
    assert.deepEqual(loads.at(-1).characters[0],ids.slice(0,128));
    assert.deepEqual(loads.at(-1).characters.slice(1),[1,2,3,4]);
    assert.equal(JSON.stringify(workers[0].world.data.chars),JSON.stringify(world.data.chars));
  } finally { client.close(); }
});

test('靠前两条鱼元被移除导致各页整体移位，逐页验证真实目标顺序只重送实际改写的一页', async () => {
  const world = new World(start, root, {populate:false,ambient:false}), store = new ArchiveStore();
  world.attachArchives(store);
  const ids = Array.from({length:800},(_,i)=>'x' + i);
  for (const id of ids) world.data.chars[id] = { id,kind:'burn',entity:'',created:start,path:[] };
  const worker = new WorkerSimulation(), sent = [];
  let checking = false;
  const client = new SimulationClient(()=>localWorker(message => {
    if (checking && message.kind === 'rows') for (const [field,id] of message.rows) if (field === 'chars') sent.push(id);
  },worker));
  try {
    await client.checkRetained(world);
    worldEdited(world);
    delete world.data.chars[ids[0]]; delete world.data.chars[ids[5]];
    world.data.chars[ids[131]].former = { phase:1 };
    checking = true;
    const cut = await orderedCheckpoint(world,store);
    const handle = await client.prepareAgreed(world,()=>true,cut.characterPages);
    assert.ok(handle);
    assert.deepEqual(sent,Object.keys(world.data.chars).slice(128,256));
    assert.equal(JSON.stringify(worker.world.data.chars),JSON.stringify(world.data.chars));
  } finally { client.close(); }
});

test('已预装的鱼元继续上报真实下落，未知历史字段参与页面证明', async () => {
  const worlds = [new World(start,root,{populate:false,ambient:false}),new World(start,root,{populate:false,ambient:false})];
  const id = crypto.randomUUID();
  const food = { id,kind:'food',actor:'visitor',nick:'甲',x:5,y:0,ch:'鱼',color:'#ace123',t:start,cost:1 };
  for (const world of worlds) {
    world.attachArchives(new ArchiveStore());
    assert.equal(world.apply(food).ok,true);
    world.data.chars[id].legacy = { ['旧\n栏']: ['$', '"', null, true] };
  }
  const clients = worlds.map(()=>new SimulationClient(()=>localWorker()));
  try {
    await clients[0].checkRetained(worlds[0]);
    const cut = await orderedCheckpoint(worlds[0],worlds[0].archives);
    for (let i=1;i<=4;i++) {
      const outputs = await Promise.all(clients.map(async (client,n) => {
        const world = worlds[n], handle = await client.prepareAgreed(world,()=>true,n===0 && i===1 ? cut.characterPages : undefined);
        return client.advanceAgreed(world,start+i*CONFIG.step,()=>true,handle);
      }));
      assert.equal(outputs[0].changesDigest,outputs[1].changesDigest);
      assert.equal(JSON.stringify(worlds[0].data),JSON.stringify(worlds[1].data));
    }
    assert.ok(worlds[0].data.chars[id].y + worlds[0].data.chars[id].fall > 0);
  } finally { for (const client of clients) client.close(); }
});

test('同一权威基准中食物位置和下落实时量散在每页，只补送路径等其他内容真正不同的页', async () => {
  const world = new World(start,root,{populate:false,ambient:false}), store = new ArchiveStore();
  world.attachArchives(store);
  const ids = Array.from({length:512},(_,index)=>'food' + index);
  for (const [i,id] of ids.entries()) world.data.chars[id] = {
    id,kind:'food',entity:'',x:i,y:2,moveAt:start,fall:0.2,path:[],old:{unknown:i}
  };
  const worker = new WorkerSimulation(), sent = [];
  let loading = false;
  const client = new SimulationClient(()=>localWorker(message=>{
    if (loading && message.kind === 'rows') for (const [field,id] of message.rows) if (field === 'chars') sent.push(id);
  },worker));
  try {
    await client.checkRetained(world);
    worldEdited(world);
    for (const [i,id] of ids.entries()) {
      const cell = world.data.chars[id];
      cell.y++; cell.moveAt+=500; cell.fall=0; cell.x++;
      if (i%2===0) delete cell.fall;
    }
    world.data.chars[ids[134]].old.unknown++;
    world.data.chars[ids[204]].path.push({reason:'eat',target:'some fish',t:start});
    loading = true;
    const cut = await orderedCheckpoint(world,store);
    const handle = await client.prepareAgreed(world,()=>true,cut.characterPages);
    assert.ok(handle);
    assert.deepEqual(sent,ids.slice(128,256));
    assert.equal(JSON.stringify(worker.world.data.chars),JSON.stringify(world.data.chars));
  } finally { client.close(); }
});

test('确认输入只装载基准，到点双方各提交一个相同的生态步，过期约定无法再用', async () => {
  const makeWorld = () => new World(start, root, { populate: false, ambient: false });
  const worlds = [makeWorld(), makeWorld()];
  const requested = [];
  const clients = worlds.map(() => new SimulationClient(() => localWorker(message => {
    if (message.kind === 'step') requested.push(message.base);
  })));
  try {
    const ready = await Promise.all(clients.map((client, i) => client.prepareAgreed(worlds[i], () => true)));
    assert.deepEqual(requested, []);
    assert.equal(await clients[0].advanceAgreed(worlds[0], start + 2 * CONFIG.step, () => true, ready[0]), null);
    const advance = (i, time, base) => clients[i].advanceAgreed(worlds[i], time, () => true, base);
    const next = start + CONFIG.step;
    const result = await Promise.all(ready.map((base, i) => advance(i, next, base)));
    assert.deepEqual(requested, [start, start]);
    assert.equal(result[0].tick, next);
    assert.match(result[0].changesDigest, /^[0-9a-f]{64}$/);
    assert.equal(result[0].changesDigest, result[1].changesDigest);
    assert.deepEqual(worlds[0].serialize(), worlds[1].serialize());
    assert.equal(await advance(0, next, ready[0]), null);
    const stale = await clients[0].prepareAgreed(worlds[0], () => true);
    worldEdited(worlds[0]);
    assert.equal(await advance(0, next + CONFIG.step, stale), null);
    assert.equal(worlds[0].data.tick, next);
  } finally { for (const client of clients) client.close(); }
});

test('按实际鱼逐步确认结果，老线程保留已经离开的鱼的序号也能接入同一海洋', async () => {
  const worlds = [new World(start, root), new World(start, root)];
  worlds[1].data = structuredClone(worlds[0].data);
  const id = Object.keys(worlds[0].data.fishes)[0], gone = '已离开的鱼';
  const fishes = worlds[0].data.fishes;
  worlds[0].data.fishes = { [gone]: { ...fishes[id], id: gone }, ...fishes };
  const workers = worlds.map(() => new WorkerSimulation());
  const clients = workers.map(worker => new SimulationClient(() => localWorker(undefined, worker)));
  try {
    await clients[0].open(worlds[0], () => true);
    delete worlds[0].data.fishes[gone];
    workers[0].receive({ kind: 'restore', rows: [['fishes', gone, undefined]] });
    for (let i = 1; i <= 4; i++) {
      if (i === 4) workers[1].world.data.fishes[id].name = '同一步出现不同鱼名';
      const results = await Promise.all(clients.map(async (client, side) => {
        const world = worlds[side], ready = await client.prepareAgreed(world, () => true);
        return client.advanceAgreed(world, start + i * CONFIG.step, () => true, ready);
      }));
      assert.notEqual(clients[0].knownFish.indexOf(id), clients[1].knownFish.indexOf(id));
      if (i === 4) assert.notEqual(results[0].changesDigest, results[1].changesDigest);
      else {
        assert.equal(results[0].changesDigest, results[1].changesDigest);
        assert.deepEqual(worlds[0].serialize(), worlds[1].serialize());
      }
    }
  } finally { for (const client of clients) client.close(); }
});

test('同一基准同时归并伙伴历史和参与者顺序，旧约定失效、已有线程无需重装', async () => {
  const world = new World(start, root);
  setParticipantName(world, 'first', '甲');
  setParticipantName(world, 'second', '乙');
  const worker = new WorkerSimulation(), requests = [];
  const client = new SimulationClient(() => localWorker(msg => requests.push(msg.kind), worker));
  const replica = new World(start, root);
  const cold = new SimulationClient(() => localWorker());
  try {
    await client.advance(world, start + CONFIG.step);
    const old = await client.prepareAgreed(world, () => true);
    const [a,b] = Object.keys(world.data.fishes).sort();
    const bond = { a, b, seconds: 42, at: world.data.tick, lastNear: world.data.tick, run: 8 };
    const participants = Object.fromEntries(Object.entries(world.data.participants).reverse());
    client.installCheckedHistory(world, { participants, life: { ...world.data.life, bonds: { ...world.data.life.bonds, [a + '|' + b]: bond } } });
    const tick = world.data.tick + CONFIG.step;
    assert.equal(await client.advanceAgreed(world, tick, () => true, old), null);
    replica.data = structuredClone(world.data);
    const results = await Promise.all([[client, world], [cold, replica]].map(async ([c,w]) => {
      const base = await c.prepareAgreed(w, () => true);
      return c.advanceAgreed(w, tick, () => true, base);
    }));
    assert.equal(requests.filter(kind => kind === 'open').length, 1);
    assert.equal(requests.filter(kind => kind === 'history').length, 1);
    assert.deepEqual(Object.keys(worker.world.data.participants), Object.keys(participants));
    assert.equal(results[0].changesDigest, results[1].changesDigest);
    assert.deepEqual(world.serialize(), replica.serialize());
  } finally { client.close(); cold.close(); }
});

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
      if (reply?.patch) sent.push(structuredClone(reply.patch));
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
    const trips = sent.map(change => change.tables.travel).filter(Boolean);
    assert(trips.some(trip => trip.distances instanceof Float64Array && trip.distances.length > 0));
    for (const trip of trips) for (const row of trip.set) {
      if (typeof row === 'number') { assert.equal(trip.day, '2025-06-15'); continue; }
      const [, fields, , days] = row;
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

test('故事按上一版序号保留，替换、重排、删减和嵌套修改均可重放', () => {
  const world = new World(start, root, { populate: false }), worker = new WorkerSimulation();
  world.data.life.stories = { a: { id: 'a', old: { value: 1 } }, b: { id: 'b' }, c: { id: 'c' } };
  worker.receive({ kind: 'open', values: world.serialize(), tables: [], ambient: false });
  worker.receive({ kind: 'ready' });
  const src = worker.world.data.life;
  const apply = () => {
    const patch = worker.tracker.changes();
    world.data.life = expandSimulationPatch(world.data, patch).values.life;
    return patch.life;
  };
  src.stories = { c: src.stories.c, a: src.stories.a, d: { id: 'd', new: 2 } };
  const moved = apply();
  assert.deepEqual(moved.stories, [2, 0, ['d', { id: 'd', new: 2 }]]);
  assert.deepEqual(Object.keys(world.data.life.stories), ['c', 'a', 'd']);
  const old = world.data.life.stories;
  src.stories = { a: src.stories.a };
  src.stories.a.old.value = 3;
  assert.equal(apply().stories, undefined);
  assert.deepEqual(world.data.life.stories, { a: { id: 'a', old: { value: 3 } } });
  assert.equal(old.a.old.value, 1);
  src.stories = {};
  assert.deepEqual(apply().stories, []);
  assert.deepEqual(world.data.life.stories, {});
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

test('连续提交的故事沿用顺序，旧版本仍可独立改写字典', () => {
  const a = { id: 'a', kind: 'friend' }, b = { id: 'b', kind: 'friend' }, c = { id: 'c', kind: 'friend' };
  const data = { life: { stories: { a, b } } };
  function commit(stories) {
    const { values } = expandSimulationPatch(data, { values: {}, tables: {}, life: { properties: [{}], stories } }, [], true);
    return data.life = values.life;
  }
  const first = commit([1, ['c', c], 0]);
  const second = commit([2, 1]);
  assert.deepEqual(Object.keys(first.stories), ['b', 'c', 'a']);
  assert.deepEqual(Object.keys(second.stories), ['a', 'c']);
  assert.equal(second.stories.c, c);
  delete first.stories.c;
  assert.deepEqual(structuredClone(second).stories, { a, c });
  second.stories = { b };
  assert.equal(commit([0]).stories.b, b);
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

test('主端伙伴关系跨帧保持顺序、旧记录和存档值', () => {
  const world = new World(start, root, { populate: false });
  const row = (a, b, seconds, at, run) => ({ a, b, seconds, at, lastNear: at, run });
  const initial = world.data.life.bonds = {
    'a|b': row('a', 'b', 0.001, start, 0.001),
    'a|c': row('a', 'c', 7, start, 4)
  };
  const install = (at, bonds) => {
    const patch = { tables: {}, values: { tick: at }, life: { properties: [{ at }], bonds } };
    Object.assign(world.data, expandSimulationPatch(world.data, patch, [], true).values);
    return world.data.life;
  };
  const firstAt = start + 1000, secondAt = start + 2000, thirdAt = start + 3000;
  const first = install(firstAt, { at: firstAt, intervals: { before: 2, length: 3, kept: [3], added: [4] }, keys: ['b|c'] });
  const firstHalf = install(firstAt + 500);
  initial['a|b'].seconds = 30;
  initial['a|c'].seconds = 40;
  const second = install(secondAt, { at: secondAt, intervals: { before: 3, length: 3, kept: [5], added: [2] }, keys: ['a|d'] });

  assert.equal(first.bonds, firstHalf.bonds);
  assert.deepEqual(first.bonds, {
    'a|b': row('a', 'b', 1.001, firstAt, 1.001),
    'a|c': row('a', 'c', 8, firstAt, 5),
    'b|c': row('b', 'c', 1, firstAt, 0)
  });
  first.bonds['b|c'].seconds = 99;
  const checkpoint = structuredClone({ world: { ...world.data } });
  const expected = {
    'a|b': row('a', 'b', 2.001, secondAt, 2.001),
    'a|d': row('a', 'd', 1, secondAt, 0),
    'b|c': row('b', 'c', 2, secondAt, 1)
  };
  assert.equal(JSON.stringify(second.bonds), JSON.stringify(expected));
  assert.deepEqual(checkpoint.world.life.bonds, expected);
  assert.deepEqual(world.serialize().life.bonds, expected);

  second.bonds['a|d'].seconds = 8;
  const third = install(thirdAt, { at: thirdAt, intervals: { before: 3, length: 3, kept: [7], added: [0] }, keys: [] });
  assert.deepEqual(third.bonds['a|d'], row('a', 'd', 9, thirdAt, 1));
  assert.equal(second.bonds['a|d'].at, secondAt);
  assert.deepEqual(checkpoint.world.life.bonds, expected);
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
  for (const [i, id] of ids.entries()) {
    const facing = id === 'fed' ? -1 : 1, phase = id === 'fed' ? 3 : 2;
    world.data.fishes[id] = { id, x: 20 * (i + 1), y: 7, facing, cx: 0, cy: 0, posAt: start,
      created: start - phase * LIFE.wanderPeriod, hungerAt: now + CONFIG.hunger };
    world.data.travel[id] = { since: start, days: { [day]: 3 } };
    for (let x = 0; x < 2; x++) {
      const cellId = `${id}:${x}`;
      world.data.chars[cellId] = { id: cellId, kind: 'fish', entity: id, x, y: 0, ch: '鱼', path: [] };
    }
  }
  worker.receive({ kind: 'open', values: world.serialize(), tables: [], ambient: false });
  worker.receive({ kind: 'ready' });
  const sea = worker.world;
  const swims = [];
  sea.step(now, swims);
  assert.deepEqual(swims[3], ['fed']);
  assert.deepEqual(swims[5], ['gone', 'swam']);
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
  assert.deepEqual(Array.from(patch.tables.travel.distances), [4]);
  assert.equal(patch.tables.travel.set[0], ids.indexOf('swam'));
  assert.equal(expanded.tables.travel.set.find(([id]) => id === 'fed')[1].days[day], 6);

  worker.receive({ kind: 'restore', rows: [['travel', 'swam', { since: start, days: { [day]: 10 } }]] });
  worker.receive({ kind: 'step', base: now, names: [], foods: [] });
  assert.equal(sea.data.travel.swam.days[day], 11);
  sea.data.travel.swam.days = { [day]: 20 };
  worker.receive({ kind: 'step', base: now + CONFIG.step, names: [], foods: [] });
  assert.equal(sea.data.travel.swam.days[day], 21);
});
