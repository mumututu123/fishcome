import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE, ArchiveStore, archiveChunks, archivePlan } from '../www/archive.js';
import { World } from '../www/engine.js';
import { mergeBonds } from '../www/life.js';
import { WorldBroadcast } from '../www/world-broadcast.js';
import { actorId, signer } from '../www/storage.js';
import { prepareOrderedArchive } from '../www/ordered-archive.js';
import { OrderedSession } from '../www/ordered-session.js';
import { stepDigest } from '../www/step-digest.js';

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
      bondHistory: (_, bonds) => mergeBonds(world.data.life.bonds, bonds),
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
