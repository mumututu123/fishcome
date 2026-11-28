import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE, ArchiveStore, archiveChunks, archivePlan } from '../www/archive.js';
import { World } from '../www/engine.js';
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
      install: (_, changes, valid, wrap) => { if (valid()) wrap(() => Object.assign(world.data, changes)); },
      advance: async (_, tick) => { calls.push(tick); world.data.tick = tick; return { tick, changesDigest: await stepDigest({ tick }) }; }
    });
    sides.push({ world, peer, store, inputs, applied, session, calls, stops });
  }
  async function drain() {
    for (let i = 0; i < 200; i++) {
      while (wires.length) { const [to, message] = wires.shift(); await sides[to].session.receive(sides[to].peer, message); }
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
  await drain();
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
