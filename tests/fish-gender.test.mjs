import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../www/engine.js';
import { restoreCheckpoint } from '../www/lifecycle.js';

test('公母性别随创建、恢复及合流保存，旧鱼仍可恢复', () => {
  const now = Date.now() - 1000, world = new World(now);
  const ids = new Map();
  for (const [index, gender] of ['male', 'female', undefined].entries()) {
    const id = crypto.randomUUID(), operation = { id, actor: 'alice', t: now, kind: 'fish', x: 20 + index * 10, y: 20, cells: [0, 1].map(x => ({ x, y: 0, ch: 'o', color: '#8be7df' })), cost: 2, ...(gender === undefined ? {} : { gender }) };
    assert.equal(world.apply(operation).ok, true); ids.set(id, gender);
  }
  const checkpoint = { world: world.serialize(), at: now, lastOnlineAt: now };
  const restored = restoreCheckpoint(checkpoint, now + 500).world;
  const peer = new World(now); peer.merge(restored.serialize()); peer.step(now + 500); restored.merge(peer.serialize());
  for (const [id, gender] of ids) {
    assert.equal(restored.data.fishes[id].gender, gender);
    assert.equal(restored.data.ops[id].gender, gender);
    assert.equal(peer.data.fishes[id].gender, gender);
  }
});

test('无效性别被拒绝且不扣鱼元、不创建鱼', () => {
  for (const gender of ['unknown', '', null, 0, {}]) {
    const world = new World(), id = crypto.randomUUID();
    const result = world.apply({ id, actor: 'alice', t: Date.now(), kind: 'fish', gender, x: 20, y: 20, cells: [0, 1].map(x => ({ x, y: 0, ch: 'o', color: '#8be7df' })), cost: 2 });
    assert.equal(result.ok, false); assert.equal(result.error, '鱼的性别无效');
    assert.equal(world.wallet('alice'), 20); assert.equal(world.counts().fish, 0);
  }
});
