import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG } from '../www/engine.js';
import { restoreCheckpoint } from '../www/lifecycle.js';

const at = Date.now() - 10000;
function savedWorld() {
  const world = new World(at), id = crypto.randomUUID();
  assert(world.apply({ id, actor: 'alice', t: at, kind: 'fish', x: 30, y: 20, cost: 2, cells: [{ x: 0, y: 0, ch: '鱼', color: '#8be7df' }, { x: 1, y: 0, ch: '口', color: '#8be7df' }] }).ok);
  return { world: world.serialize(), at, lastOnlineAt: at };
}

test('240小时内重开保留世界、作品和消费，不重新发放配额', () => {
  const checkpoint = savedWorld(), now = at + CONFIG.offlineLife - 1;
  const restored = restoreCheckpoint(checkpoint, now);
  assert.equal(CONFIG.offlineLife, 864000000);
  assert.equal(restored.expired, false);
  assert.equal(restored.world.id, Object.keys(checkpoint.world.roots)[0]);
  assert.equal(restored.world.counts().fish, 1);
  assert.equal(restored.world.wallet('alice'), 18);
  assert.deepEqual(restored.world.data.chars, checkpoint.world.chars);
  assert.equal(restored.world.data.tick, now);
  assert.equal(checkpoint.world.tick, at);
});
test('达到240小时及超过期限均湮灭，新世界余额20且不复活旧鱼', () => {
  const checkpoint = savedWorld();
  for (const now of [at + CONFIG.offlineLife, at + CONFIG.offlineLife + 1]) {
    const restored = restoreCheckpoint(checkpoint, now);
    assert.equal(restored.expired, true);
    assert.equal(restored.expiresAt, at + CONFIG.offlineLife);
    assert.notEqual(restored.world.id, Object.keys(checkpoint.world.roots)[0]);
    assert.equal(restored.world.counts().fish, 0);
    assert.equal(restored.world.wallet('alice'), 20);
  }
});
test('再次上线保存会重置离线期限；未在线期间的保存不延长期限', () => {
  const checkpoint = savedWorld(), returnedAt = at + CONFIG.offlineLife - 1;
  const restored = restoreCheckpoint(checkpoint, returnedAt);
  const next = { world: restored.world.serialize(), lastOnlineAt: returnedAt, at: returnedAt };
  assert.equal(restoreCheckpoint(next, returnedAt + CONFIG.offlineLife - 1).expired, false);
  assert.equal(restoreCheckpoint({ ...checkpoint, at: returnedAt }, at + CONFIG.offlineLife).expired, true);
});
test('旧版存档按保存时间迁移，缺少保存时间时使用模拟时间', () => {
  const checkpoint = savedWorld(); delete checkpoint.lastOnlineAt;
  assert.equal(restoreCheckpoint(checkpoint, at + CONFIG.offlineLife - 1).expired, false);
  assert.equal(restoreCheckpoint(checkpoint, at + CONFIG.offlineLife).expired, true);
  delete checkpoint.at;
  assert.equal(restoreCheckpoint(checkpoint, at + CONFIG.offlineLife - 1).expired, false);
  assert.equal(restoreCheckpoint(checkpoint, at + CONFIG.offlineLife).expired, true);
});
test('首次进入创建世界，时间未知的旧存档不能无限续存，时钟回拨不立即湮灭', () => {
  assert.equal(restoreCheckpoint(undefined, at).world.wallet('alice'), 20);
  const checkpoint = savedWorld();
  assert.equal(restoreCheckpoint(checkpoint, at - 1000).expired, false);
  delete checkpoint.at; delete checkpoint.lastOnlineAt; delete checkpoint.world.tick;
  assert.equal(restoreCheckpoint(checkpoint, at).expired, true);
});
