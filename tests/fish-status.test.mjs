import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from './empty-world.mjs';
import { DAY, shanghaiDay, mealIndex, fishStatus, mergeTravel, validTravel } from '../www/fish-status.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const t = Date.now() - 10000;
const cell = (x, y, ch = 'o') => ({ x, y, ch, color: '#8be7df' });
function fish(world, cells = [cell(0, 0), cell(1, 0)], actor = 'alice') {
  const id = crypto.randomUUID(); assert(world.apply({ id, actor, t, kind: 'fish', x: 20 + Object.keys(world.data.fishes).length * 16, y: 20, cells, cost: cells.length }).ok); return id;
}
function food(world, x, y) {
  const id = crypto.randomUUID(); assert(world.apply({ id, actor: 'giver', t, kind: 'food', x, y: 0, ch: '口', color: '#ff9933', cost: 1 }).ok); world.data.chars[id].y = y; return id;
}
test('成功水平、垂直和斜向游动累计实际距离', () => {
  for (const [cells, x, y, expected] of [[[cell(0, 0), cell(1, 0)], 25, 20, 1], [[cell(0, 0), cell(0, 1)], 20, 25, 1], [[cell(0, 0), cell(1, 1)], 25, 25, Math.SQRT2]]) {
    const world = new World(t), id = fish(world, cells); food(world, x, y); world.step(t + 500);
    assert(Math.abs(world.fishStatus(id, t + 500).movement - expected) < 1e-9);
  }
});
test('碰壁和原地转头不增加运动量', () => {
  const blocked = new World(t), blockedId = fish(blocked);
  assert(blocked.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 22, y: 20, cells: [cell(0, 0, '#'), cell(0, 1, '#')], cost: 2 }).ok);
  food(blocked, 25, 20); blocked.step(t + 500); assert.equal(blocked.fishStatus(blockedId, t + 500).movement, 0);
  const turned = new World(t), turnedId = fish(turned); food(turned, 15, 20); turned.data.fishes[turnedId].cx = -10; turned.step(t + 500);
  assert.equal(turned.data.fishes[turnedId].facing, -1); assert.equal(turned.data.fishes[turnedId].x, 21); assert.equal(turned.fishStatus(turnedId, t + 500).movement, 0);
});
test('北京时间午夜分开记账，跨日后今日运动从0开始', () => {
  const world = new World(t), id = fish(world), before = Date.parse('2026-11-23T15:59:59.999Z'), after = before + 1;
  assert.equal(shanghaiDay(before), '2026-11-23'); assert.equal(shanghaiDay(after), '2026-11-24');
  world.recordMovement(id, 3, before); assert.equal(world.fishStatus(id, after).movement, 0);
  world.recordMovement(id, 2, after); assert.equal(world.data.travel[id].days['2026-11-23'], 3); assert.equal(world.fishStatus(id, after).movement, 2);
});
test('24小时进食窗口严格过滤边界、未来记录，并去重脱落或烧毁鱼元的历史', () => {
  const events = [{ id: 'old', reason: 'eat', target: 'fish', t: t - DAY - 1 }, { id: 'boundary', reason: 'eat', target: 'fish', t: t - DAY }, { id: 'recent', reason: 'eat', target: 'fish', t: t - DAY + 1 }, { id: 'latest', reason: 'eat', target: 'fish', t }, { id: 'future', reason: 'eat', target: 'fish', t: t + 1000 }];
  const index = mealIndex({ a: { id: 'a', kind: 'burn', path: events }, b: { id: 'b', kind: 'food', path: [events[2]] } }, t);
  const f = { created: t - 2 * DAY, lastFed: t }; assert.equal(fishStatus(f, undefined, index.get('fish'), t).meals24, 2); assert.equal(fishStatus(f, undefined, index.get('fish'), t + 1000).meals24, 2);
});
test('连续24小时未进食即饥饿，饥饿退化不会解除饥饿状态', () => {
  const f = { created: t - 2 * DAY, lastFed: t - DAY, hungerAt: t + DAY };
  assert.equal(fishStatus(f, undefined, [], t - 1).hungry, false); assert.equal(fishStatus(f, undefined, [], t).hungry, true); assert.equal(fishStatus(f, undefined, [], t + 1).hungry, true);
  f.lastFed = t; assert.equal(fishStatus(f, undefined, [], t).hungry, false);
  assert.equal(fishStatus({ created: t - DAY }, undefined, [], t).hungry, true);
});
test('进食后统计缓存刷新，重复副本合并不会重复统计，过24小时自动移出', () => {
  const world = new World(t), id = fish(world, [cell(0, 0, 'Q'), cell(1, 0, '8')]); food(world, 19, 19);
  assert.equal(world.fishStatus(id, t).meals24, 0); const before = world.serialize(); world.step(t + 500);
  assert.equal(world.fishStatus(id, t + 500).meals24, 1); world.merge(before); world.merge(world.serialize()); assert.equal(world.fishStatus(id, t + 500).meals24, 1);
  assert.equal(world.fishStatus(id, t + 500 + DAY).meals24, 0);
});
test('日累计合并取较大值，协调者接替继续累计，不能叠加重复副本', () => {
  const world = new World(t), id = fish(world), day = shanghaiDay(t); world.recordMovement(id, 5, t);
  const other = world.serialize(); other.travel[id].days[day] = 8; world.merge(other); world.merge(other); assert.equal(world.fishStatus(id, t).movement, 8);
  const successor = new World(t); successor.merge(world.serialize()); successor.recordMovement(id, 2, t + 500); world.merge(successor.serialize()); assert.equal(world.fishStatus(id, t + 500).movement, 10);
});
test('旧存档运动量从恢复时记录，保留原有进食历史和饥饿时间', () => {
  const world = new World(t), id = fish(world); food(world, 19, 19); world.step(t + 500); const data = world.serialize(); delete data.travel;
  const restored = restoreCheckpoint({ world: data, at: t + 500 }, t + 1000).world, status = restored.fishStatus(id, t + 1000);
  assert.equal(status.movement, 0); assert.equal(status.trackedSince, t + 1000); assert.equal(status.partialMovement, true); assert.equal(status.meals24, 1); assert.equal(status.hungry, false);
});
test('我的鱼按合法创建者筛选，消失后移出列表', () => {
  const world = new World(t), own = fish(world), other = fish(world, [cell(0, 0), cell(1, 0)], 'bob'); world.data.fishes[other].actor = 'alice';
  assert.deepEqual(world.myFishes('alice').map(f => f.id), [own]); world.starve(own, t + DAY); assert.equal(world.myFishes('alice').length, 0); assert.equal(world.fishStatus(own), null);
});
test('无效运动日期、负数和无穷值被拒绝，合并不修改原始记录', () => {
  const original = { since: t, days: { '2026-11-23': 3 } }, other = { since: t + 1000, days: { '2026-11-23': 2, '2026-11-24': 4 } };
  assert.deepEqual(mergeTravel(original, other).days, { '2026-11-23': 3, '2026-11-24': 4 }); assert.equal(Object.keys(original.days).length, 1);
  for (const record of [{ since: t, days: 1 }, { since: t, days: { '2026-02-31': 1 } }, { since: t, days: { '2026-11-23': -1 } }, { since: t, days: { '2026-11-23': Infinity } }]) assert.equal(!!validTravel(record), false);
});
