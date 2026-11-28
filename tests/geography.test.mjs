import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, hash, cellPosition, canSee, displayNick } from './empty-world.mjs';
import { wrapX, worldKey, deltaX, makeTerrain, validTerrain } from '../www/geography.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { motionUnits, commitUnit, updateContacts, finishBreeding, validBreedingRecord } from '../www/breeding.js';
import { fishCatalog } from '../www/fish-profile.js';
const t = Date.now() - 1000, cell = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
function directed(dx, dy = 0) { while (true) { const id = crypto.randomUUID(), value = hash(`${id}:0`); if ([-1, 0, 1][value % 3] === dx && [-1, 0, 1][Math.floor(value / 3) % 3] === dy) return id; } }
function fish(world, x, y, cells = [cell(0, 0), cell(0, 1)], gender, id = crypto.randomUUID(), nick = '完整昵称') { assert(world.apply({ id, actor: id, nick, kind: 'fish', x, y, cells, gender, cost: cells.length, t }).ok); return id; }
function food(world, x, y) { const id = crypto.randomUUID(); assert(world.apply({ id, actor: 'feeder', kind: 'food', cost: 1, x, y: 0, ch: '.', color: '#88aacc', t }).ok); world.data.chars[id].y = y; return id; }
function unique(world) { for (const owners of world.fishOccupants().values()) assert.equal(owners.size, 1); }

test('海底生成1000列固定周期折线，深度80到100且接缝连续', () => {
  const world = new World(t), terrain = world.data.terrain; assert.equal(CONFIG.width, 1000); assert.equal(terrain.depths.length, 1000); assert(validTerrain(terrain, world.data.roots));
  assert(terrain.depths.every(depth => Number.isInteger(depth) && depth >= 80 && depth <= 100)); assert(new Set(terrain.depths).size > 1);
  for (let x = 0; x < 1000; x++) assert(Math.abs(world.floorAt(x) - world.floorAt(x + 1)) <= 1);
  assert.deepEqual(makeTerrain(terrain.seed, t), terrain); assert.equal(world.floorAt(-1), world.floorAt(999)); assert.equal(world.floorAt(1000), world.floorAt(0));
});
test('地形随保存恢复而固定，合流选现有地形稳定收敛，篡改地形拒绝', () => {
  const a = new World(t), b = new World(t + 1), first = structuredClone(a.data.terrain), aa = a.serialize(), bb = b.serialize();
  a.merge(bb); b.merge(aa); assert.deepEqual(a.data.terrain, first); assert.deepEqual(b.data.terrain, first);
  for (let i = 1; i <= 3; i++) a.step(t + i * 500); assert.deepEqual(a.data.terrain, first);
  assert.deepEqual(restoreCheckpoint({ world: a.serialize(), lastOnlineAt: t }, t + 1000).world.data.terrain, first);
  const broken = a.serialize(); broken.terrain.depths[0]++; assert.throws(() => b.merge(broken), /地形/);
  const legacy = a.serialize(); delete legacy.terrain; const restored = restoreCheckpoint({ world: legacy, lastOnlineAt: t }, t + 1000); assert(validTerrain(restored.world.data.terrain, legacy.roots));
});
test('真实海底阻挡造鱼造景，鱼食在本列曲线海底停止并沉积', () => {
  const world = new World(t), x = 30, depth = world.floorAt(x);
  assert.equal(world.apply({ id: crypto.randomUUID(), actor: 'bad', t, kind: 'fish', cost: 2, x, y: depth, cells: [cell(0, 0), cell(0, 1)] }).ok, false); assert.equal(world.wallet('bad'), 20);
  assert.equal(world.apply({ id: crypto.randomUUID(), actor: 'bad', t, kind: 'scene', cost: 2, x, y: depth - 1, cells: [cell(0, 0), cell(0, 1)] }).ok, false);
  const id = food(world, x, depth - 1); world.step(t + CONFIG.foodLife); assert.equal(world.data.chars[id].kind, 'scene'); const scene = world.data.scenes[world.data.chars[id].entity]; assert.equal(scene.y + world.data.chars[id].y, depth - 1);
});
test('鱼向左右跨边界各移动一格，身体连续且运动统计只增加一格', () => {
  for (const [x, dx, expected] of [[999, 1, 0], [0, -1, 999]]) { const world = new World(t), id = fish(world, x, 20, undefined, undefined, directed(dx)); world.step(t + 1000); assert.equal(world.data.fishes[id].x, expected); assert.equal(world.fishStatus(id, t + 1000).movement, 1); unique(world); }
  assert.equal(wrapX(-1), 999); assert.equal(worldKey(1000, 20), worldKey(0, 20)); assert.equal(deltaX(0, 999), 1);
});
test('跨接缝的鱼体、碰撞、寻食和吃食使用同一周期坐标', () => {
  const world = new World(t), id = fish(world, 998, 20, [cell(0, 0), cell(1, 0)], undefined, directed(0)); const meal = food(world, 0, 20); world.step(t + 500);
  assert.equal(world.data.chars[meal].entity, id); assert.equal(world.data.chars[meal].x, 2); assert.equal(world.fishCells(id).length, 3); unique(world);
  const blocked = new World(t), moving = fish(blocked, 999, 20, undefined, undefined, directed(1)); fish(blocked, 0, 20, undefined, undefined, directed(0)); blocked.step(t + 1000); assert.equal(blocked.data.fishes[moving].x, 999); assert.equal(blocked.fishStatus(moving, t + 1000).movement, 0); unique(blocked);
  assert(canSee({ x: 999, y: 20, facing: 1 }, [cell(0, 0, 'o')], { x: 2, y: 20 }));
  const chase = new World(t), hunter = fish(chase, 998, 20, [cell(0, 0, 'o'), cell(0, 1)]); food(chase, 2, 20); chase.step(t + 1000); assert.equal(chase.data.fishes[hunter].x, 999);
});
test('接缝处鱼食附着造景保留紧凑局部坐标，缩放不会拉成千格', () => {
  const world = new World(t), scene = crypto.randomUUID(); assert(world.apply({ id: scene, actor: 'builder', nick: '完整昵称', t, kind: 'scene', x: 999, y: 20, cells: [cell(0, 0), cell(1, 0)], cost: 2 }).ok);
  const meal = food(world, 0, 19); world.step(t + CONFIG.foodLife); assert.equal(world.data.chars[meal].entity, scene); assert.equal(world.data.chars[meal].x, 1); assert.equal(world.sceneCells(scene).length, 3);
  assert(world.apply({ id: crypto.randomUUID(), actor: 'builder', t, kind: 'sceneScale', scene, factor: 2, cost: 9 }).ok); assert.equal(world.sceneryMap().size, 12);
});
test('接缝处繁殖维持紧凑合体速度，翻转和出生不拉成千格鱼', () => {
  const world = new World(t), male = fish(world, 997, 20, [cell(0, 0), cell(1, 0), cell(2, 0)], 'male'), female = fish(world, 0, 20, [cell(0, 0), cell(1, 0), cell(2, 0)], 'female');
  for (let elapsed = 0; elapsed <= 5000; elapsed += 500) updateContacts(world, t + elapsed, world.fishGroups(), world.sceneryMap());
  const record = Object.values(world.data.breeding)[0]; assert(record); const unit = motionUnits(world, world.fishGroups())[0]; assert.equal(Math.max(...unit.cells.map(c => c.x)) + 1, 6); assert.equal(world.swimVelocities(male).x, 2);
  assert(world.turn(unit.fish, unit.cells)); commitUnit(unit, t + 5500); assert(validBreedingRecord(record, world.data)); assert.equal(Math.abs(deltaX(world.data.fishes[male].x, world.data.fishes[female].x)), 3); unique(world);
  finishBreeding(world, record.ends, (c, next, event) => { Object.assign(c, next); c.path.push({ ...event, target: next.entity || '' }); }); assert.equal(record.status, 'born'); assert.equal(world.fishCells(record.baby.id).length, 2); unique(world); assert(world.data.fishes[record.baby.id].x >= 0 && world.data.fishes[record.baby.id].x < 1000);
});
test('昵称完整写入作品及鱼谱，旧打码显示可由已知完整昵称更新而不改签名源', () => {
  assert.equal(displayNick(' 小鱼老师 '), '小鱼老师'); const world = new World(t), id = fish(world, 20, 20, undefined, undefined, undefined, '小鱼老师'); assert.equal(world.data.fishes[id].nick, '小鱼老师'); assert.equal(fishCatalog(world.data).get(id).nick, '小鱼老师');
  world.data.ops[id].nick = '小＊＊师'; world.data.participants[id] = '小鱼老师'; assert.equal(fishCatalog(world.data).get(id).nick, '小鱼老师'); assert.equal(world.data.ops[id].nick, '小＊＊师');
});

test('邻近海域与远处旧坐标沿用相同的循环边界和小数舍入', () => {
  for (const x of [NaN, Infinity, -Infinity, -0, '12.5', undefined,
    ...[-3000, -1000, -500, 0, 500, 1000, 2000, 5000].flatMap(edge =>
      [-1, -.5, -1e-13, -Number.EPSILON, 0, Number.EPSILON, 1e-13, .5, 1].map(offset => edge + offset))]) {
    assert(Object.is(wrapX(x), ((x % CONFIG.width) + CONFIG.width) % CONFIG.width));
  }
});
