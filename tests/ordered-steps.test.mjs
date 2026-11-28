import assert from 'node:assert/strict';
import test from 'node:test';
import { actorId, signer } from '../www/storage.js';
import { OrderedSteps, stepDigest } from '../www/ordered-steps.js';

async function operation() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', key.publicKey), actor = await actorId(pub);
  const sign = await signer({ secret: await crypto.subtle.exportKey('jwk', key.privateKey) });
  const envelope = { id: crypto.randomUUID(), kind: 'op', actor, from: actor.slice(0, 16) + '-tab', key: pub,
    body: { id: crypto.randomUUID(), actor, kind: 'food', ch: '鱼' } };
  return { ...envelope, signature: await sign(envelope) };
}
function pair() {
  const messages = [], config = { tick: 1000, proof: 'initial', epoch: crypto.randomUUID(), validOp: () => true };
  const a = new OrderedSteps({ ...config, leader: true, send: async body => { messages.push(body); } });
  const b = new OrderedSteps({ ...config, leader: false, send: async body => { messages.push(body); } });
  return { a, b, messages };
}
test('同一权威前态和有序签名输入经双方确认后只能执行一次', async () => {
  const { a, b, messages } = pair(), ops = [await operation(), await operation()];
  await a.offer(ops);
  assert.equal(a.take(1000), undefined);
  await b.receive(messages.shift());
  assert.equal(b.take(1000), undefined);
  await a.receive(messages.shift());
  await b.receive(messages.shift());
  const left = a.take(1000), right = b.take(1000);
  assert.deepEqual(right.inputs, ops);
  assert.equal(left.digest, right.digest);
  assert.equal(a.take(1000), undefined);
  const changesDigest = await stepDigest({ fish: Float64Array.of(2, 3) });
  const result = { tick: 1500, changesDigest, outcomes: [{ ok: true }, { ok: false }] };
  await assert.rejects(a.complete(left, { ...result, changesDigest: undefined }), /摘要/);
  assert.equal(await a.complete(left, result), await b.complete(right, structuredClone(result)));
  await a.offer([]);
  await b.receive(messages.shift()); await a.receive(messages.shift()); await b.receive(messages.shift());
  assert.equal(a.take(1500).tick, b.take(1500).tick);
});
test('被换过的用户签名、输入顺序、基准与重连前的消息不能确认新一步', async () => {
  const { a, b, messages } = pair(), inputs = [await operation(), await operation()];
  await a.offer(inputs);
  const offer = messages.shift();
  const stale = { ...offer, epoch: crypto.randomUUID() };
  await b.receive(stale); await b.receive({ ...offer, previous: 'other' });
  assert.equal(messages.length, 0);
  await b.receive({ ...offer, inputs: inputs.toReversed() });
  await a.receive(messages.shift());
  assert.equal(a.take(1000), undefined);
  const c = pair().b; c.epoch = a.epoch;
  const altered = structuredClone(offer); altered.inputs[0].body.ch = '改';
  await assert.rejects(c.receive(altered), /签名/);
  b.close(); await b.receive({ ...offer, action: 'seal', digest: b.next.digest });
  assert.equal(b.take(1000), undefined);
  assert.notEqual(await stepDigest([Float64Array.of(1, 2)]), await stepDigest([Float64Array.of(2, 1)]));
});
