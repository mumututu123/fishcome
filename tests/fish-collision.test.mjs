import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, hash, cellPosition } from './empty-world.mjs';
import { motionUnits, updateContacts, finishBreeding } from '../www/breeding.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const t = Date.now() - 10000;
const cell = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
function fish(world, x, y, cells = [cell(0, 0), cell(1, 0)], gender, id = crypto.randomUUID()) {
  const op = { id, actor: id, t, kind: 'fish', x, y, cells, gender, cost: cells.length }; assert(world.apply(op).ok); return id;
}
function direction(dx, dy) { while (true) { const id = crypto.randomUUID(), r = hash(`${id}:0`); if ([-1, 0, 1][r % 3] === dx && [-1, 0, 1][Math.floor(r / 3) % 3] === dy) return id; } }
function unique(world) { for (const owners of world.fishOccupants().values()) assert.equal(owners.size, 1); }
function food(world, x, y) { const id = crypto.randomUUID(); assert(world.apply({ id, actor: 'feeder', t, kind: 'food', x, y: 0, ch: '.', color: '#ffeeaa', cost: 1 }).ok); world.data.chars[id].y = y; return id; }
function pair(ch = 'Q') { const world = new World(t), male = fish(world, 20, 20, [cell(0, 0, ch), cell(1, 0, ch), cell(2, 0, ch)], 'male'), female = fish(world, 23, 20, [cell(0, 0, ch), cell(1, 0, ch), cell(2, 0, ch)], 'female'); for (let i = 0; i <= 5000; i += CONFIG.step) updateContacts(world, t + i, world.fishGroups(), world.sceneryMap()); return { world, male, female }; }

test('鱼体按实际鱼元占格，投放重叠拒绝且不消费，外接框中的空格允许使用', () => {
  const world = new World(t), id = fish(world, 20, 20, [cell(0, 0), cell(1, 1), cell(2, 2)]);
  const op = { id: crypto.randomUUID(), actor: 'new', t, kind: 'fish', x: 20, y: 20, cells: [cell(0, 0), cell(1, 0)], cost: 2 };
  assert.equal(world.apply(op).ok, false); assert.equal(world.wallet('new'), 20); assert.equal(world.counts().fish, 1);
  fish(world, 22, 20, [cell(0, 0), cell(0, 1)]); unique(world); assert(world.canOccupy(world.data.fishes[id], world.fishCells(id)));
});
test('水平迎面游动不能穿透、交换或重复占格，受阻不累计运动', () => {
  const world = new World(t), left = fish(world, 20, 20, undefined, undefined, direction(1, 0)), right = fish(world, 23, 20, undefined, undefined, direction(-1, 0));
  for (let i = 1; i <= 18; i++) { world.step(t + i * 500); unique(world); }
  const a = world.fishCells(left).map(c => cellPosition(world.data.fishes[left], c).x), b = world.fishCells(right).map(c => cellPosition(world.data.fishes[right], c).x); assert(Math.max(...a) < Math.min(...b));
  assert.equal(world.fishStatus(left, t + 9000).movement + world.fishStatus(right, t + 9000).movement, 1);
});
test('垂直及横竖组合移动逐轴检查其他鱼，不能挤进被占用的格子', () => {
  const world = new World(t), upper = fish(world, 20, 20, undefined, undefined, direction(0, 1)), lower = fish(world, 20, 22, undefined, undefined, direction(0, -1));
  for (let i = 1; i <= 18; i++) { world.step(t + i * 500); unique(world); }
  assert(world.data.fishes[upper].y < world.data.fishes[lower].y);
  const diagonal = new World(t), moving = fish(diagonal, 30, 30, undefined, undefined, direction(1, 1)); fish(diagonal, 32, 30, [cell(0, 0), cell(0, 1)], undefined, direction(0, 0));
  diagonal.step(t + 1000); unique(diagonal); assert.equal(diagonal.data.fishes[moving].x, 30); assert.equal(diagonal.data.fishes[moving].y, 31);
});
test('转头扫描完整路径，目标空位但中途扫过其他鱼时也不能翻转', () => {
  const world = new World(t), id = fish(world, 20, 20, [cell(0, 0), cell(1, 1), cell(2, 2)]); fish(world, 21, 19, [cell(0, 0), cell(0, 1)]);
  assert.equal(world.turn(world.data.fishes[id], world.fishCells(id)), false); assert.equal(world.data.fishes[id].facing, 1); unique(world);
  const alone = new World(t), own = fish(alone, 20, 20); assert(alone.turn(alone.data.fishes[own], alone.fishCells(own))); unique(alone);
});
test('繁殖合体把双亲视作一个碰撞体，排除自身并阻挡第三条鱼', () => {
  const { world } = pair(), unit = motionUnits(world, world.fishGroups())[0]; assert.equal(unit.members.length, 2); assert(world.canOccupy(unit.fish, unit.cells)); assert(world.turn(unit.fish, unit.cells));
  // Check against the unchanged parent's world positions using a fresh synthetic unit.
  const fresh = motionUnits(world, world.fishGroups())[0]; fish(world, 26, 20); assert.equal(world.canOccupy({ ...fresh.fish, x: fresh.fish.x + 1 }, fresh.cells), false);
});
test('进食不能长入另一条鱼，堆叠食物只能在空格中长出一个身体鱼元', () => {
  const world = new World(t); const one = fish(world, 20, 20, undefined, undefined, direction(0, 0)); fish(world, 22, 20, undefined, undefined, direction(0, 0));
  const covered = food(world, 22, 20); world.step(t + 500); assert.equal(world.data.chars[covered].kind, 'food'); unique(world);
  const first = food(world, 20, 19), second = food(world, 20, 19); world.step(t + 1000); unique(world);
  assert.equal([first, second].filter(id => world.data.chars[id].kind === 'fish').length, 1); assert.equal(world.fishCells(one).length, 3);
});
test('同一步中实时释放和占用位置，顺序不依赖快照的鱼记录插入顺序', () => {
  const a = new World(t); fish(a, 20, 20, undefined, undefined, direction(1, 0)); fish(a, 23, 20, undefined, undefined, direction(-1, 0));
  const b = new World(t); b.data = a.serialize(); b.data.fishes = Object.fromEntries(Object.entries(b.data.fishes).reverse()); b.data.chars = Object.fromEntries(Object.entries(b.data.chars).reverse());
  for (let i = 1; i <= 10; i++) { a.step(t + i * 500); b.step(t + i * 500); unique(a); unique(b); }
  for (const id of Object.keys(a.data.fishes)) assert.deepEqual(a.data.fishes[id], b.data.fishes[id]);
});
test('同格过期的食物依次沉积，移开的食物仍占住新格', () => {
  const world = new World(t);
  const x = 30, y = world.floorAt(x) - 1;
  const ids = Array.from({ length: 3 }, () => food(world, x, y));
  for (const id of ids) world.data.chars[id].born = t - CONFIG.foodLife;
  world.step(t + CONFIG.step);
  const positions = ids.map(id => {
    const cell = world.data.chars[id], scene = world.data.scenes[cell.entity];
    assert.equal(cell.kind, 'scene');
    return [scene.x + cell.x, scene.y + cell.y];
  });
  const occupied = new Set(positions.map(([x,y]) => x + ',' + y));
  assert.equal(occupied.size, ids.length);
  assert(occupied.has(x + ',' + y));
  for (const [col, row] of positions) {
    assert(world.waterAt(col, row));
    assert(row === world.floorAt(col) - 1 || occupied.has(col + ',' + (row + 1)));
  }
});
test('旧存档和独立世界合流重叠自动整体分开，保留作品、额度、运动统计并稳定去重', () => {
  const a = new World(t), b = new World(t); fish(a, 20, 20); fish(b, 20, 20);
  const aa = a.serialize(), bb = b.serialize(); a.merge(bb); b.merge(aa);
  assert.equal(a.reconcileGeometry(t + 1000).fishMoved, 1); assert.equal(b.reconcileGeometry(t + 1000).fishMoved, 1); unique(a); unique(b);
  for (const id of Object.keys(a.data.fishes)) { assert.deepEqual(a.data.fishes[id], b.data.fishes[id]); assert.equal(a.wallet(id), 18); assert.equal(a.fishStatus(id, t + 1000).movement, 0); }
  assert.equal(a.counts().characters, 4); const positions = JSON.stringify(a.data.fishes); assert.equal(a.reconcileGeometry(t + 2000).fishMoved, 0); assert.equal(JSON.stringify(a.data.fishes), positions);
  const legacy = new World(t); legacy.merge(aa); legacy.merge(bb); const restored = restoreCheckpoint({ world: legacy.serialize(), lastOnlineAt: t }, t + 1000); restored.world.reconcileGeometry(t + 1000); unique(restored.world);
});
test('分开繁殖中的重叠鱼保持双亲相对位置，修正位置不计为运动', () => {
  const { world, male, female } = pair(); const third = fish(world, 40, 20); world.data.fishes[third].x = 21;
  const before = { x: world.data.fishes[male].x - world.data.fishes[female].x, y: world.data.fishes[male].y - world.data.fishes[female].y };
  assert.equal(world.reconcileGeometry(t + 5500).fishMoved, 1); unique(world); assert.equal(world.data.fishes[male].x - world.data.fishes[female].x, before.x); assert.equal(world.data.fishes[male].y - world.data.fishes[female].y, before.y);
  assert.equal(Object.values(world.data.breeding)[0].status, 'active'); for (const id of [male, female, third]) assert.equal(world.fishStatus(id, t + 5500).movement, 0);
});
test('合体实际游动遇到第三条鱼时停住，保持孕期和亲鱼相对位置', () => {
  const { world, male, female } = pair('o'); fish(world, 26, 20, undefined, undefined, direction(0, 0)); food(world, 28, 20);
  const record = Object.values(world.data.breeding)[0]; record.motion.cx = 2; world.data.tick = t + 5000;
  world.step(t + 5500); unique(world); assert.equal(world.data.fishes[male].x, 20); assert.equal(world.data.fishes[female].x, 23); assert.equal(record.status, 'active');
  assert.equal(world.fishStatus(male, t + 5500).movement, 0); assert.equal(world.fishStatus(female, t + 5500).movement, 0);
});
test('出生候选位置已被第三条鱼占用时取消出生，不复制或丢失鱼元', () => {
  const { world } = pair(), other = fish(world, 40, 20); world.data.fishes[other].x = 23;
  const record = Object.values(world.data.breeding)[0], before = world.counts().characters;
  finishBreeding(world, record.ends, (cell, next, event) => { Object.assign(cell, next); cell.path.push(event); });
  assert.equal(record.status, 'cancelled'); assert.equal(world.counts().fish, 3); assert.equal(world.counts().characters, before);
});
