import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, hash, cellPosition, canSee } from '../www/engine.js';
import { HOUR, GREENS, growthRoll, weedId, validWildCell, updateSeaweed } from '../www/seaweed.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const now = Math.floor((Date.now() - HOUR) / HOUR) * HOUR + HOUR / 2;
const glyph = (x, y, ch = 'o') => ({ x, y, ch, color: '#8be7df' });
function addFish(world, x, y, chars = [glyph(0, 0), glyph(1, 0)], actor = 'alice') {
  const id = crypto.randomUUID(); assert(world.apply({ id, actor, kind: 'fish', t: now, x, y, cells: chars, cost: chars.length }).ok); return id;
}
function stem(world, x, length = 1) {
  let source = `floor:${x}`, hour = Math.floor(now / HOUR) - 10000, plant;
  const cells = [];
  for (let index = 0; index < length; index++) {
    while (!growthRoll(source, ++hour, hash)) {}
    const id = weedId(source, hour, hash); plant ||= id;
    const cell = { id, kind: 'seaweed', entity: plant, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x, y: world.floorAt(x) - 1 - index, created: hour * HOUR, path: [], moveAt: now, wild: { source, hour, plant, index, x, y: world.floorAt(x) - 1 - index } };
    world.data.chars[id] = cell; cells.push(cell); source = `tip:${id}`;
  }
  return cells;
}
const tiny = { ...CONFIG, width: 8, depth: 8 }, noMonument = { x: 100, y: 100, rows: [] };
const alwaysGrow = text => text.startsWith('seaweed-roll:') ? 0 : hash(text);
const transition = (cell, next, event) => { Object.assign(cell, next); cell.path.push({ ...event, target: next.entity || '' }); };

test('每个来源每小时约1%的独立试验，不在每帧重复抽签', () => {
  let successes = 0; for (let i = 0; i < 100000; i++) if (growthRoll(`floor:${i}`, 123456, hash)) successes++;
  assert(successes > 800 && successes < 1200, `rate ${successes / 100000}`);
  const world = new World(now), startHour = world.data.seaweedHour;
  updateSeaweed(world, (startHour + 1) * HOUR - 1, tiny, noMonument, alwaysGrow, transition);
  assert.equal(Object.keys(world.data.chars).length, 0);
  updateSeaweed(world, (startHour + 1) * HOUR, tiny, noMonument, alwaysGrow, transition);
  const count = Object.keys(world.data.chars).length; assert(count > 0 && count <= tiny.width);
  updateSeaweed(world, (startHour + 1) * HOUR + 500, tiny, noMonument, alwaysGrow, transition);
  assert.equal(Object.keys(world.data.chars).length, count);
});
test('海底和造景八方向的空格才发芽，排除鱼、食物、地形、海草和纪念碑', () => {
  const world = new World(now), sceneId = crypto.randomUUID();
  assert(world.apply({ id: sceneId, actor: 'builder', kind: 'scene', t: now - HOUR, x: 3, y: 3, cells: [glyph(0, 0, '#'), glyph(1, 0, '#')], cost: 2 }).ok);
  addFish(world, 0, 7);
  world.data.chars.food = { id: 'food', kind: 'food', x: 2, y: 7 };
  const before = new Set(['0,7', '1,7', '2,7', '3,3', '4,3', '7,7']);
  const hour = world.data.seaweedHour + 1;
  updateSeaweed(world, hour * HOUR, tiny, { x: 7, y: 7, rows: ['碑'] }, alwaysGrow, transition);
  const weeds = Object.values(world.data.chars).filter(c => c.kind === 'seaweed'), positions = weeds.map(c => `${c.x},${c.y}`);
  assert.equal(new Set(positions).size, positions.length);
  for (const cell of weeds) {
    assert(!before.has(`${cell.x},${cell.y}`)); assert(cell.x >= 0 && cell.x < 8 && cell.y >= 0 && cell.y < 8);
    assert.equal(cell.ch, '草'); assert(GREENS.includes(cell.color));
    if (cell.wild.source.startsWith('cell:')) { const base = world.data.chars[cell.wild.source.slice(5)]; assert.equal(Math.max(Math.abs(cell.x - 3 - base.x), Math.abs(cell.y - 3 - base.y)), 1); }
    else assert.equal(cell.y, 7);
  }
  assert(weeds.some(c => c.wild.source.startsWith('cell:')));
});
test('顶端长出连续草茎，短海草不摆动，三字以上根部固定且不穿地形', () => {
  const world = new World(now), cells = stem(world, 40, 3), root = { x: cells[0].x, y: cells[0].y };
  const wall = crypto.randomUUID(); assert(world.apply({ id: wall, actor: 'wall', t: now, kind: 'scene', x: 41, y: Math.min(world.floorAt(40), world.floorAt(41)) - 4, cells: [glyph(0, 0, '#'), glyph(0, 1, '#'), glyph(0, 2, '#')], cost: 3 }).ok);
  const poses = new Set();
  for (let i = 0; i < 40; i++) {
    updateSeaweed(world, now + i * 2000, CONFIG, noMonument, hash, transition);
    assert.deepEqual({ x: cells[0].x, y: cells[0].y }, root);
    for (const cell of cells) assert(!world.sceneryMap().has(`${cell.x},${cell.y}`));
    for (let index = 1; index < cells.length; index++) assert.equal(Math.max(Math.abs(cells[index].x - cells[index - 1].x), Math.abs(cells[index].y - cells[index - 1].y)), 1);
    poses.add(cells.map(c => c.x).join(','));
  }
  assert(poses.size > 1, '长草应出现不同摆动姿态');
  const short = new World(now), shortCells = stem(short, 30, 2), initial = shortCells.map(c => c.x);
  for (let i = 0; i < 8; i++) updateSeaweed(short, now + i * 2000, CONFIG, noMonument, hash, transition);
  assert.deepEqual(shortCells.map(c => c.x), initial);
  const growth = new World(now), existing = stem(growth, 3), hour = growth.data.seaweedHour + 1;
  updateSeaweed(growth, hour * HOUR, CONFIG, noMonument, alwaysGrow, transition);
  const tip = Object.values(growth.data.chars).find(c => c.wild?.source === `tip:${existing[0].id}`);
  assert(tip); assert.equal(tip.entity, existing[0].entity); assert.equal(tip.wild.index, 1); assert.equal(tip.y, existing[0].y - 1);
});
test('鱼眼海草视距与食物一致，浅水10格、深水5格，盲鱼只能碰到后吃', () => {
  for (const y of [20, 80]) {
    const fish = { x: 20, y, facing: 1 }, radius = y < CONFIG.shallow ? 10 : 5;
    for (const distance of [radius, radius + 1]) assert.equal(canSee(fish, [glyph(0, 0)], { x: 20 + distance, y, kind: 'seaweed' }), distance === radius);
    assert.equal(canSee(fish, [glyph(0, 0, 'Q')], { x: 21, y, kind: 'seaweed' }), false);
  }
  const world = new World(now), weed = stem(world, 30)[0], fishId = addFish(world, 28, world.floorAt(30) - 2, [glyph(0, 0, 'Q'), glyph(1, 0, '8')]);
  world.step(now + 500);
  assert.equal(weed.kind, 'fish'); assert.equal(weed.entity, fishId); assert.equal(weed.ch, '草'); assert.equal(world.data.fishes[fishId].lastFed, now + 500); assert.equal(world.fishStatus(fishId, now + 500).meals24, 1);
  assert.deepEqual(cellPosition(world.data.fishes[fishId], weed), { x: 30, y: world.floorAt(30) - 1 });
});
test('鱼主动追寻可见海草，海草不会五分钟后沉积，大鱼争食只吃一次', () => {
  const chase = new World(now), target = stem(chase, 30)[0], fishId = addFish(chase, 25, Math.min(chase.floorAt(25), chase.floorAt(30)) - 1);
  chase.step(now + 500); assert.equal(chase.data.fishes[fishId].x, 26); assert.equal(target.kind, 'seaweed');
  const growing = new World(now), plant = stem(growing, 30)[0]; growing.step(now + CONFIG.foodLife + 1); assert.equal(plant.kind, 'seaweed');
  const contest = new World(now), food = stem(contest, 30)[0]; addFish(contest, 28, contest.floorAt(30) - 2, [glyph(0, 0, 'Q'), glyph(1, 0, '8')]);
  const large = addFish(contest, 31, Math.min(contest.floorAt(30), contest.floorAt(31)) - 3, [glyph(0, 0, 'Q'), glyph(0, 1, '8'), glyph(0, 2, '8')], 'bob');
  contest.step(now + 500); assert.equal(food.entity, large); assert.equal(food.path.filter(p => p.reason === 'eat').length, 1);
});
test('吃掉根部或中间草茎后，上方断开的海草脱落为鱼食', () => {
  const world = new World(now), cells = stem(world, 30, 3); addFish(world, 28, Math.min(world.floorAt(28), world.floorAt(30)) - 1, [glyph(0, 0, 'Q'), glyph(1, 0, '8')]);
  world.step(now + 500); assert.equal(cells[0].kind, 'fish');
  world.step(now + 1000); assert(cells.slice(1).every(c => c.kind !== 'seaweed'));
});
test('生长时钟、海草、随机绿色与进食来源跨存档、合流和重复快照保留', () => {
  const world = new World(now), cells = stem(world, 30, 3);
  assert(cells.every(c => validWildCell(c, CONFIG, hash)));
  const saved = world.serialize(), peer = new World(now); peer.merge(saved); peer.merge(saved);
  assert.equal(Object.keys(peer.data.chars).length, 3); assert.equal(peer.data.seaweedHour, world.data.seaweedHour);
  const restored = restoreCheckpoint({ world: saved, at: now, lastOnlineAt: now }, now + 500).world;
  assert.deepEqual(restored.data.chars, saved.chars);
  for (const bad of [{ ...cells[0], ch: '鱼' }, { ...cells[0], payer: 'alice' }, { ...cells[0], color: '#ff0000' }, { ...cells[0], id: 'fake' }]) assert(!validWildCell(bad, CONFIG, hash));
});
test('不能通过投放、搬动或缩放造景覆盖海草，也不扣鱼元', () => {
  const world = new World(now), weed = stem(world, 30)[0];
  const sceneId = crypto.randomUUID(); assert(world.apply({ id: sceneId, actor: 'builder', t: now, kind: 'scene', x: 32, y: Math.min(world.floorAt(30), world.floorAt(32)) - 2, cells: [glyph(0, 0, '#'), glyph(0, 1, '#')], cost: 2 }).ok);
  const move = world.apply({ id: crypto.randomUUID(), actor: 'builder', t: now, kind: 'sceneMove', scene: sceneId, x: 30, y: world.floorAt(30) - 2, cost: 0 }); assert.equal(move.ok, false);
  const spawn = world.apply({ id: crypto.randomUUID(), actor: 'alice', t: now, kind: 'scene', x: weed.x, y: weed.y, cells: [glyph(0, 0, '#'), glyph(1, 0, '#')], cost: 2 }); assert.equal(spawn.ok, false); assert.equal(world.wallet('alice'), 20);
  const scaleWorld = new World(now); stem(scaleWorld, 30);
  const scaleId = crypto.randomUUID(); assert(scaleWorld.apply({ id: scaleId, actor: 'builder', t: now, kind: 'scene', x: 29, y: scaleWorld.floorAt(30) - 2, cells: [glyph(0, 0, '#'), glyph(1, 0, '#')], cost: 2 }).ok);
  assert.equal(scaleWorld.apply({ id: crypto.randomUUID(), actor: 'builder', t: now, kind: 'sceneScale', scene: scaleId, factor: 2, cost: 6 }).ok, false);
  assert.equal(scaleWorld.wallet('builder'), 18);
});

test('脱落海草沉积、编辑和付费造景复制后仍有有效来源', () => {
  const world = new World(now), cell = stem(world, 30)[0];
  // Natural grass that has detached uses the existing food-to-sediment path.
  transition(cell, { kind: 'food', entity: '', born: now - CONFIG.foodLife, fall: 0 }, { id: 'detach', t: now - CONFIG.foodLife, reason: 'uproot' });
  world.step(now + 500); assert.equal(cell.kind, 'scene'); assert(validWildCell(cell, CONFIG, hash));
  const actor = 'builder', edit = { id: crypto.randomUUID(), actor, t: now + 500, kind: 'sceneEdit', scene: cell.entity, cell: cell.id, ch: '木', color: '#aabbcc', cost: 0 };
  assert(world.apply(edit).ok); assert(validWildCell(cell, CONFIG, hash));
  const move = { id: crypto.randomUUID(), actor, t: now + 500, kind: 'sceneMove', scene: cell.entity, x: 30, y: Math.min(world.floorAt(30), world.floorAt(31)) - 4, cost: 0 }; assert(world.apply(move).ok);
  assert(world.apply({ id: crypto.randomUUID(), actor, t: now + 500, kind: 'sceneScale', scene: cell.entity, factor: 2, cost: 3 }).ok);
  assert(world.sceneCells(cell.entity).filter(c => c.id !== cell.id).every(c => !c.wild && c.payer === actor));
});
