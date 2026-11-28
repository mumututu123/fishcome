import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE, ArchiveStore, archiveChunks, archivePlan } from '../www/archive.js';
import { World } from '../www/engine.js';
import { mergeBonds } from '../www/life.js';
import { AdmissionJournal } from '../www/admission-journal.js';
import { WorldBroadcast } from '../www/world-broadcast.js';
import { actorId, signer } from '../www/storage.js';
import { prepareOrderedArchive } from '../www/ordered-archive.js';
import { OrderedSession, captureOrderedWorld, capturedOrderedRows, orderedCheckpoint } from '../www/ordered-session.js';
import { stepDigest } from '../www/step-digest.js';
import { capturedCharacterProof, prepareCharacterProof } from '../www/ordered-characters.js';
import { applyInputRows, simulationApplied, worldEdited } from '../www/simulation-changes.js';
import { jsonDigest } from '../www/step-digest.js';

test('鱼元页证明跨越已提交的新步，后到的签名输入、删除和旧字段修改仅影响新证明', async () => {
  const world = new World(Date.now(), crypto.randomUUID(), { populate: false, ambient: false });
  for (let i = 0; i < 385; i++) world.data.chars['k' + i] = { id: 'k' + i, kind: 'burn', path: [], former: { order: [i] } };
  const canonical = () => {
    const rows = Object.entries(world.data.chars);
    return Promise.all(Array.from({ length: Math.ceil(rows.length / 128) }, (_, i) => jsonDigest(rows.slice(i * 128, i * 128 + 128))));
  };
  await prepareCharacterProof(world);
  const first = capturedCharacterProof(world), original = canonical();
  const updated = { ...world.data.chars.k22, former: { order: [22, '旧字段'] } };
  applyInputRows(world, [['chars', 'k22', updated]]);
  delete world.data.chars.k0;
  simulationApplied(world, { values: {}, tables: { chars: { set: [], remove: ['k0'] } } });
  const second = capturedCharacterProof(world), after = canonical();
  const merge = {};
  worldEdited(world, 'replica', merge);
  world.data.chars.k14.former.order.push('归并');
  merge.chars = new Set(['k14']);
  const third = capturedCharacterProof(world), merged = canonical();
  assert.deepEqual(await first.hashes, await original);
  assert.deepEqual(await second.hashes, await after);
  assert.deepEqual(await third.hashes, await merged);
  worldEdited(world);
  assert.equal(capturedCharacterProof(world), undefined);
});

test('共同检查点保留签名操作的内容和次序，旧步的出生凭据仍可读取', async () => {
  const world = new World(Date.now(), crypto.randomUUID(), { populate: false }), store = new ArchiveStore();
  const op = i => ({ id: 'fish-' + i, kind: 'fish', cells: [{ x: i }], extension: { missing: undefined } });
  for (let i = 0; i < 256; i++) world.data.ops['fish-' + i] = op(i);
  world.data.chars.cell = { id: 'cell', kind: 'burn' };
  await Promise.all([prepareCharacterProof(world), prepareCharacterProof(world, 'ops')]);
  const captured = captureOrderedWorld(world, store);
  const old = structuredClone(world.data), reverse = Object.keys(old.ops).reverse();
  const expected = await orderedCheckpoint({ data: old, ambient: world.ambient }, store);
  applyInputRows(world, [['ops', 'fish-0', { ...op(0), cells: [] }]]);
  const changes = {};
  worldEdited(world, 'replica', changes);
  delete world.data.ops['fish-1'];
  world.data.ops['fish-257'] = op(257);
  changes.ops = new Set(['fish-1', 'fish-257']);
  changes.chars = new Set();
  const later = captureOrderedWorld(world, store);
  const pages = capturedOrderedRows(captured.world.data, 'ops');
  assert.deepEqual([...pages.encodedRows().values()], Object.entries(old.ops).map(entry => JSON.stringify(entry)));
  assert.equal((await orderedCheckpoint(captured.world, captured.store)).proof, expected.proof);
  assert.deepEqual(captured.world.data.ops, old.ops);
  assert.deepEqual(captured.world.data.chars, old.chars);
  const aligned = await orderedCheckpoint(captured.world, captured.store, { ops: reverse });
  assert.deepEqual(Object.keys(aligned.changes.ops), reverse);
  assert.deepEqual(aligned.changes.ops['fish-0'], old.ops['fish-0']);
  aligned.changes.ops['fish-0'].extension.extra = true;
  assert.deepEqual(captured.world.data.ops, old.ops);
  assert.deepEqual(later.world.data.ops, world.data.ops);
});

test('插入鱼食、删除操作和调整字典次序时，只重新编码实际修改的行，结果与整表一致', async () => {
  let reads = 0;
  const cell = { id: 'old', get kind() { reads++; return 'burn'; } };
  const world = { data: { tick: 1000, chars: { old: cell, second: { kind: 'food' } }, ops: { retired: {}, original: {} } } };
  const store = new ArchiveStore(), first = new AdmissionJournal(world.data), full = new AdmissionJournal(world.data);
  delete world.data.ops.retired;
  world.data.chars.added = { kind: 'food' };
  const second = world.data.chars.second;
  delete world.data.chars.second;
  world.data.chars.second = second;
  world.data.tick += 500;
  const patch = { tables: { chars: { set: [['added', world.data.chars.added]], remove: [] },
    ops: { set: [], remove: ['retired'] } }, values: { tick: world.data.tick } };
  first.changed(patch);
  const before = reads;
  first.capture(world);
  assert.equal(reads, before);
  full.changed(null);
  full.capture(world);
  assert(reads > before);
  assert.equal(await first.proof(world, store, 'anchor'), await full.proof(world, store, 'anchor'));
});

async function earn(world, serial) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = await crypto.subtle.exportKey('jwk', keys.publicKey), actor = await actorId(key);
  const sign = await signer({ secret: await crypto.subtle.exportKey('jwk', keys.privateKey) });
  const body = { id: actor + ':hour:' + serial, actor, nick: '鱼', roots: world.roots, kind: 'earn',
    t: world.data.tick - ARCHIVE.age - 10000, cost: 0, serial };
  const envelope = { id: crypto.randomUUID(), kind: 'op', actor, from: actor.slice(0, 16) + '-tab', key, body };
  return { ...envelope, signature: await sign(envelope) };
}
function pair(now) {
  const wires = [], packs = {}, sides = [];
  const root = crypto.randomUUID();
  for (const owner of [true, false]) {
    const inputs = [], applied = [], calls = [], stops = [], store = new ArchiveStore(), peer = {};
    const world = new World(now, root, { populate: false, ambient: false });
    world.attachArchives(store);
    const session = new OrderedSession({
      world: () => world, store: () => store, leader: () => 'leader', peer: () => peer, isLeader: () => owner,
      send: async (_, body) => { wires.push([owner ? 1 : 0, structuredClone(body)]); },
      inputs: () => inputs.splice(0), validOp: (_, op) => !world.validOp(op.body),
      apply: (_, op, archived) => { applied.push(op.body.id); return world.apply({ ...op.body, proof: op }, archived); },
      stopped: (_, reason) => stops.push(reason), inputsCommitted: async () => {}, archiveConfirmed() {},
      prepareArchive: (_, boundary) => prepareOrderedArchive(world, store, boundary, id => packs[id], async () => {}),
      archiveBoundary: (_, commit) => commit(), prepare: async () => ({}),
      bondHistory: (s, bonds) => mergeBonds(s.world.data.life.bonds, bonds),
      install: (_, changes, valid, wrap) => { if (valid()) wrap(() => Object.assign(world.data, changes)); },
      advance: async (_, tick) => { calls.push(tick); world.data.tick = tick; return { tick, changesDigest: await stepDigest({ tick }) }; }
    });
    sides.push({ world, peer, store, inputs, applied, session, calls, stops });
  }
  async function drain(drop) {
    for (let i = 0; i < 200; i++) {
      while (wires.length) {
        const [to, message] = wires.shift();
        if (drop?.(message)) continue;
        await sides[to].session.receive(sides[to].peer, message);
        // The normal world publication calls probe immediately after committing.
        if (message.action === 'available') await sides[to].session.probe();
      }
      if (!sides.some(s => s.session.current?.running)) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('两端未完成步结果签认');
  }
  return { sides, drain, packs };
}
test('双方持有已验证的包、确认归档后才同时移出原签名记录，并继续使用同一会话', async () => {
  const now = Date.now(), { sides: [a,b], drain, packs } = pair(now);
  const op = await earn(a.world, 17);
  a.inputs.push(op);
  await a.session.probe(); await drain();
  for (const side of [a,b]) {
    assert.deepEqual(side.applied, [op.body.id]); assert.ok(side.world.data.ops[op.body.id]);
    assert.equal(side.session.run(now + 499), false);
    assert.deepEqual(side.calls, []);
  }
  const chunks = await archiveChunks(archivePlan(a.world.data, now), a.world.data.roots);
  assert.equal(chunks.length, 1);
  const boundary = { version: 1, at: now, chunks: {} };
  for (const { manifest, encoded } of chunks) { boundary.chunks[manifest.id] = manifest; packs[manifest.id] = encoded; }
  const agreement = a.session.proposeArchive(boundary);
  while (!a.session.current.archive.plan) await new Promise(r => setTimeout(r, 1));
  await drain(message => message.action === 'archiveReady');
  assert.equal(a.session.current.archive.remote, undefined);
  for (const side of [a,b]) { assert.ok(side.world.data.ops[op.body.id]); assert.equal(side.store.ids.ops.size, 0); }
  for (const side of [a,b]) assert.equal(side.session.run(now + 500), true);
  await drain();
  assert.equal(await agreement, true);
  for (const side of [a,b]) {
    assert.deepEqual(side.stops, []);
    assert.equal(side.world.data.ops[op.body.id], undefined); assert.equal(side.world.data.archives.at, now);
    assert.deepEqual(await side.store.get('ops', op.body.id), { ...op.body, proof: op });
    assert.equal(side.world.wallet(op.actor), 21);
    assert.equal(side.session.run(now + 1000), true);
  }
  await drain();
  assert.deepEqual(a.calls, b.calls); assert.equal(a.calls.length, 2);
});
test('即使步号相同，不同的归档基准也无法开启会话', async () => {
  const { sides: [a,b], drain } = pair(Date.now());
  b.world.data.archives.at++;
  await a.session.probe(); await drain();
  assert.equal(a.session.current, null); assert.equal(b.session.current, null);
  assert.deepEqual(b.calls, []);
});
test('双方持有同一尚无伙伴表的旧基准时仍验证整个世界', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  for (const side of [a,b]) delete side.world.data.life.bonds;
  await a.session.probe(); await drain();
  assert.ok(a.session.current.steps); assert.ok(b.session.current.steps);
  assert.equal(a.session.current.steps.proof,b.session.current.steps.proof);
});
test('一批两份签名依业务编号各取自己的归档凭据', async () => {
  const { sides: [a,b], drain } = pair(Date.now());
  const first = await earn(a.world, 3), second = await earn(a.world, 5);
  for (const side of [a,b]) {
    const records = new Map([first, second].map(op => [op.body.id, { archived: op.body.id }]));
    side.store.get = (_, id) => records.get(id);
    side.session.io.apply = (_, op, archived) => {
      assert.strictEqual(archived, records.get(op.body.id));
      side.applied.push(op.body.id);
      return { ok: true };
    };
  }
  a.inputs.push(first, second);
  await a.session.probe(); await drain();
  for (const side of [a,b]) assert.deepEqual(side.applied, [first.body.id, second.body.id]);
});
test('起步到点仍缺签认时立即交还前一权威通道，重连后不执行旧步', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  let withheld;
  await a.session.probe();
  await drain(message => { if (message.action === 'seal') { withheld = message; return true; } });
  assert.ok(withheld);
  for (const side of [a,b]) {
    assert.equal(side.session.run(now + 500), false);
    assert.deepEqual(side.calls, []);
  }
  await drain();
  await b.session.receive(b.peer, withheld);
  assert.equal(b.session.current, null);
  a.session.retryAt = 0;
  await a.session.probe(); await drain();
  assert.notEqual(b.session.current.epoch, withheld.epoch);
  await b.session.receive(b.peer, withheld);
  assert.equal(b.session.run(now + 500), true);
  assert.equal(a.session.run(now + 500), true);
  await drain();
  assert.deepEqual(a.calls, b.calls);
});

function publishOrdinary(a, b, due, beforeMerge) {
  a.world.step(due);
  // A directly executed World.step has no worker patch. Its changed rows
  // must be discovered by comparing all rows against the captured anchor.
  a.session.changed(a.world);
  a.session.changed(a.world, { workerChanges: {}, values: { tick: due } });
  const incoming = a.world.serialize();
  beforeMerge?.();
  const changes = b.world.merge(incoming, {}, 'replica', true);
  b.session.changed(b.world, null, 'replica', changes);
  b.session.appliedReplica(b.world, changes, incoming, {});
}
test('权威完整鱼生记录沿用原次序，零行、局部键和本地胜出的内容保留原合流结果', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  await a.session.probe();
  await drain(message => message.action === 'open');
  const source = {}, life = b.world.data.life;
  for (const [name, table] of Object.entries(life)) {
    if (typeof table !== 'object') continue;
    const rows = { second: { old: 2 }, first: { old: 1 } };
    life[name] = { first: rows.first, second: rows.second };
    source[name] = structuredClone(rows);
  }
  source.stories.first.old = 10;
  delete source.haunts.second;
  source.places = {};
  b.session.appliedReplica(b.world, {}, { life: source }, {});
  for (const name of Object.keys(source)) {
    const locallyRetained = ['haunts','stories','places'].includes(name);
    assert.deepEqual(Object.keys(life[name]), locallyRetained ? ['first','second'] : ['second','first']);
    assert.deepEqual(life[name].first, { old: 1 });
  }
});
for (const diverged of [false, true]) test('每一份全态签认都跨过三个真实权威步，最新实际状态' + (diverged ? '不同时不能切换' : '相同时在同一会话接管下一步'), async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  let withheld;
  await a.session.probe();
  await drain(message => {
    if (message.action !== 'open') return false;
    withheld = message; return true;
  });
  assert.ok(withheld && a.session.current.cut && b.session.current.cut);
  const anchor = a.session.current.epoch;
  for (let i = 1; i <= 3; i++) {
    const due = now + i * 500;
    assert.equal(a.session.run(due), false);
    assert.equal(b.session.run(due), false);
    publishOrdinary(a,b,due, () => { if (diverged && i === 3) b.world.data.notices = ['未获同一基准签认的本地记录']; });
    await b.session.afterReplica();
    assert.equal(a.world.data.tick, due);
    assert.equal(b.world.data.tick, due);
  }
  await b.session.receive(b.peer, withheld);
  await drain();
  assert.deepEqual(a.calls, []);
  await a.session.probe(); await drain();
  if (diverged) {
    assert.equal(a.session.current, null);
    assert.equal(b.session.run(now + 2000), false);
    assert.deepEqual(b.calls, []);
  } else {
    assert.equal(a.session.current.epoch, anchor);
    assert.notEqual(a.session.current.steps.proof, withheld.proof);
    for (const side of [a,b]) assert.equal(side.session.run(now + 2000), true);
    await drain();
    assert.deepEqual(a.calls, [now + 2000]);
    assert.deepEqual(a.calls, b.calls);
  }
});
test('缺少起始步的接收端能释放旧会话，成员更换后没有旧步提交', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  const old = b.session.begin(b.peer, crypto.randomUUID(), now + 500);
  old.waiting = true; old.began = performance.now() - 2200;
  assert.equal(b.session.run(now + 1000), false); assert.equal(b.session.current, null);
  await a.session.probe(); await drain();
  const past = a.session.current;
  a.session.io.peer = () => ({});
  assert.equal(a.session.run(now + 500), false);
  assert.equal(a.session.current, null); assert.deepEqual(a.calls, []);
  assert.equal(a.session.valid(past), false);
});

for (const conflict of [false, true]) test('慢入场遇到真实签名归档和名册换序后，' + (conflict ? '不同的本地归档索引阻止接管' : '归档已落盘的同一世界继续接管'), async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  const signed = await earn(a.world, 9);
  for (const side of [a,b]) {
    side.world.data.ops[signed.body.id] = { ...signed.body, proof: signed };
    side.world.data.participants = side === a ? { first: '一', second: '二' } : { second: '二', first: '一' };
  }
  const chunks = await archiveChunks(archivePlan(a.world.data, now), a.world.data.roots);
  assert.equal(chunks.length, 1);
  let anchor;
  await a.session.probe();
  await drain(message => { if (message.action === 'open') { anchor = message; return true; } });
  const epoch = anchor.epoch;
  for (const side of [a,b]) {
    side.session.archiveChanging('归档');
    for (const chunk of chunks) {
      await side.store.ingest(chunk);
      side.world.data.archives.chunks[chunk.manifest.id] = chunk.manifest;
    }
    side.world.data.archives.at = now + 1;
    delete side.world.data.ops[signed.body.id];
    if (side === b && conflict) side.store.summary.serials[signed.actor]++;
  }
  publishOrdinary(a,b,now + 500);
  await b.session.receive(b.peer,anchor);
  await drain();
  if (conflict) {
    assert.ok(a.stops.includes('双方实际提交的增量结果不同'));
    assert.equal(b.session.run(now + 1000), false);
  } else {
    for (const side of [a,b]) {
      assert.equal(side.session.current?.epoch, epoch);
      assert.ok(await side.store.get('ops', signed.body.id));
      assert.equal(side.session.run(now + 1000), true);
    }
    await drain();
    assert.deepEqual(a.calls, b.calls);
  }
});

test('跟随端同一基准装载跨过半秒，旧端当步照常提交、下一步在追到的新基准共同结算', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  let loaded, installing;
  const started = new Promise(resolve => { installing = resolve; });
  const slow = new Promise(resolve => { loaded = resolve; });
  b.session.io.prepare = async (_world, valid) => {
    if (b.world.data.tick === now) { installing(); await slow; }
    return valid() ? {} : null;
  };
  await a.session.probe();
  const messages = drain();
  await started;
  const late = now + 500;
  assert.equal(a.session.run(late), false);
  assert.equal(b.session.run(late), false);
  publishOrdinary(a,b,late);
  loaded();
  await messages;
  assert.equal(a.session.current.followAnchor, true);
  await a.session.probe(); await drain();
  for (const side of [a,b]) assert.equal(side.session.run(late + 500), true);
  await drain();
  assert.deepEqual(a.calls, [late + 500]);
  assert.deepEqual(a.calls, b.calls);
});
test('首次共同基准和输入均已验、仅迟到一张就绪时，下一次权威发布即可重新会合', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  await a.session.probe();
  await drain(message => message.action === 'prepared');
  const epoch = a.session.current.epoch;
  assert.ok(a.session.current.localReady);
  assert.equal(a.session.current.remoteReady, undefined);
  assert.equal(a.session.run(now + 500), false);
  await drain();
  assert.deepEqual(a.calls, []);
  assert.equal(b.session.current, null);
  for (const side of [a,b]) side.world.data.tick += 500;
  await a.session.probe(); await drain();
  assert.notEqual(a.session.current.epoch, epoch);
  for (const side of [a,b]) assert.equal(side.session.run(now + 1000), true);
  await drain();
  assert.deepEqual(a.calls, [now + 1000]);
  assert.deepEqual(a.calls, b.calls);
});
test('同一步归并离线期间不同的伙伴成员与累计相处，随后共同执行', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  const bond = (first, second, seconds) => ({ a: first, b: second, seconds, at: now, lastNear: now, run: 1 });
  a.world.data.life.bonds = { 'a|b': bond('a','b',3) };
  b.world.data.life.bonds = { 'a|b': bond('a','b',8), 'a|c': bond('a','c',5) };
  await a.session.probe(); await drain();
  for (const side of [a,b]) {
    assert.deepEqual(side.stops, []);
    assert.equal(side.world.data.life.bonds['a|b'].seconds,8);
    assert.equal(side.world.data.life.bonds['a|c'].seconds,5);
    assert.equal(side.session.run(now+500),true);
  }
  await drain();
  assert.equal(a.session.current.steps.proof,b.session.current.steps.proof);
});
test('入场保留场景编辑和鱼名册的原遍历次序，只为不同的大表请求次序', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now), traffic = [];
  const tables = { scenes: { s2: {id:'s2'}, s1: {id:'s1'} }, fishes: { f2: {id:'f2'}, f1: {id:'f1'} } };
  for (const [field, table] of Object.entries(tables)) {
    a.world.data[field] = structuredClone(table);
    b.world.data[field] = Object.fromEntries(Object.entries(structuredClone(table)).reverse());
  }
  const before = a.session.io.send;
  a.session.io.send = async (peer, body) => { traffic.push(body); await before(peer,body); };
  await a.session.probe(); await drain();
  assert.ok(a.session.current?.steps); assert.ok(b.session.current?.steps);
  assert.deepEqual(Object.keys(b.world.data.scenes),['s2','s1']); assert.deepEqual(Object.keys(b.world.data.fishes),['f2','f1']);
  const opening = traffic.find(r=>r.action==='opening');
  for (const name of ['chars','fishes','ops','travel']) assert.equal(opening.order[name],undefined);
  assert.deepEqual(Object.keys(traffic.find(r=>r.action==='tableOrder').order), ['fishes']);
  assert.deepEqual(a.stops,[]); assert.deepEqual(b.stops,[]);
});
test('漏掉首次归档公告时继续确认鱼步，随后补发同一归档', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  await a.session.probe(); await drain();
  const boundary = { version: 1, at: now + 1, chunks: {} };
  const completed = a.session.proposeArchive(boundary);
  while (!a.session.current.archive.plan) await new Promise(r=>setTimeout(r,1));
  await drain(message => message.action === 'archive');
  assert.equal(b.session.current.archive, undefined);
  a.session.current.archive.announced = performance.now() - 1500;
  for (let index = 1; index <= 2; index++) {
    for (const side of [a,b]) assert.equal(side.session.run(now + index * 500), true);
    await drain();
  }
  assert.equal(await completed,true);
  for (const side of [a,b]) {
    assert.equal(side.world.data.archives.at, boundary.at);
    assert.deepEqual(side.stops,[]);
    assert.equal(side.calls.length,2);
  }
});

test('开启消息颠倒仍独立验证，较大名册和伙伴次序仅在双方不同的表上补送', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  const traffic = [];
  const ids = Array.from({ length: 140 }, (_,i) => 'id' + i);
  const bonds = Object.fromEntries(ids.map(id => ['a|' + id, { a:'a', b:id, seconds:1, at:now, lastNear:now, run:1 }]));
  for (const side of [a,b]) {
    side.world.data.participants = Object.fromEntries(ids.map(id => [id,id]));
    side.world.data.life.bonds = Object.fromEntries(side === a ? Object.entries(bonds) : Object.entries(bonds).reverse());
    const send = side.session.io.send;
    side.session.io.send = (peer,message) => { traffic.push(message); return send(peer,message); };
  }
  let opening;
  await a.session.probe();
  await drain(message => { if (message.action === 'opening') { opening = message; return true; } });
  assert.ok(b.session.current.proof);
  assert.equal(b.session.current.checking,undefined);
  await b.session.receive(b.peer,opening);
  await drain();
  assert.ok(a.session.current.steps); assert.ok(b.session.current.steps);
  assert.deepEqual(Object.keys(a.world.data.life.bonds),Object.keys(b.world.data.life.bonds));
  assert.equal(opening.order.participants,undefined);
  assert.equal(opening.order['life.bonds'],undefined);
  assert.equal(traffic.find(m=>m.action==='open').order,undefined);
  assert.deepEqual(Object.keys(traffic.find(m=>m.action==='tableOrder').order),['life.bonds']);
  assert.ok(traffic.every(m=>!m.bonds));
});
test('对方尚未完成首次加入时询问不占用时钟，迟到的回执不能锁定旧世界', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  await a.session.probe();
  let old;
  await drain(message => { if (message.action === 'available') { old = message; return true; } });
  assert.ok(old); assert.equal(a.session.current, undefined);
  assert.equal(a.session.run(now + 500), false);
  a.session.candidate.askedAt = performance.now() - 1100;
  await a.session.receive(a.peer,old);
  assert.equal(a.session.current,undefined);
  await a.session.probe(); await drain();
  assert.ok(a.session.current.steps); assert.ok(b.session.current.steps);
});
test('有效回复落在旧步中间时仍照常发布，下一次提交才选定新检查点', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  await a.session.probe();
  let reply;
  await drain(message => { if (message.action === 'available') { reply = message; return true; } });
  await a.session.receive(a.peer, reply);
  assert.equal(a.session.current, undefined);
  assert.equal(a.session.run(now + 500), false);
  a.world.data.tick = b.world.data.tick = now + 500;
  await a.session.probe();
  await drain();
  for (const side of [a,b]) {
    assert.equal(side.session.current.base,now + 500);
    assert.equal(side.session.run(now + 1000),true);
  }
  await drain();
  assert.deepEqual(a.calls,b.calls);
});
test('共同模式首步等待或取消时原广播仍发增量，实际提交后才重建发送基准', async () => {
  const now = Date.now(), { sides: [a,b], drain } = pair(now);
  const updates = [], broadcaster = new WorldBroadcast();
  const net = { live: () => [b.peer], broadcast: async (_, body) => { updates.push(body); } };
  a.session.io.firstCommit = () => broadcaster.reset();
  await broadcaster.send(net, a.world.data, now);
  assert.equal(updates.at(-1).delta,false);
  await a.session.probe();
  await drain(m => m.action === 'seal');
  assert.equal(a.session.run(now+500),false);
  await drain();
  a.world.data.tick = b.world.data.tick = now + 500;
  await broadcaster.send(net, a.world.data, now + 500);
  assert.equal(updates.at(-1).delta,true);
  a.session.retryAt=0;
  await a.session.probe(); await drain();
  const advance = a.session.io.advance;
  a.session.io.advance = async () => null;
  assert.equal(a.session.run(now+1000),true); await drain();
  await broadcaster.send(net,a.world.data,now+1000);
  assert.equal(updates.at(-1).delta,true);
  a.session.io.advance=advance;
  a.session.retryAt=0;
  await a.session.probe(); await drain();
  for(const side of [a,b]) assert.equal(side.session.run(now+1000),true);
  await drain();
  a.session.stop('模拟真实断联',false);
  await broadcaster.send(net,a.world.data,now+1000);
  assert.equal(updates.at(-1).delta,false);
});
