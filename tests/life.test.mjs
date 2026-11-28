import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { World, CONFIG, clone, hash } from '../www/engine.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { LIFE, personality, personalityText, weatherAt, lifeContext, updateLife, idleMotion, fishLifeText, recordStory, withStoryBatch, mergeLife, newLife, validateLife, spawnPlankton, planktonSource, validPlankton, freshPlankton, pairKey, storiesFor, storyText, returnStory } from '../www/life.js';
import { fishCatalog } from '../www/fish-profile.js';
const t = Math.floor((Date.now() - 3600000) / 180000) * 180000 + 80000;

test('一批故事中再次遇到已裁掉或保留的同一条，与逐条裁剪顺序一致', () => {
  const a = { data: { life: newLife(t) } }, b = { data: { life: newLife(t) } };
  const write = (id, at) => { recordStory(a, 'meal', id, at); recordStory(b, 'meal', id, at); };
  withStoryBatch(b, () => {
    for (let i = 0; i <= LIFE.storyLimit; i++) write(String(i), t + i);
    write('0', t + 2000);
    write('1', t);
    write('7', t + 2000);
    write('7', t);
    write('new', t);
  });
  assert.deepEqual(Object.entries(b.data.life.stories), Object.entries(a.data.life.stories));
});

test('密集鱼群只保留规定数量的关系，已熟悉的鱼即使最终被裁掉也能留下故事', () => {
  const at = Date.UTC(2025, 5, 15, 12, 17);
  const w = new World(at, 'stable', { populate: false });
  const points = new Map(Array.from({ length: 160 }, (_, i) => {
    const id = 'fish-' + String(159 - i).padStart(3, '0');
    w.data.fishes[id] = { id, x: i, y: 15 };
    return [id, w.data.fishes[id]];
  }));
  const neighbors = new Map(), allKeys = new Set();
  for (const [id] of points) {
    const others = [...points.values()].filter(f => f.id !== id);
    neighbors.set(id, others);
    for (const fish of others) allKeys.add(pairKey(id, fish.id));
  }
  const lastPair = pairKey('fish-158', 'fish-159');
  w.data.life.bonds[lastPair] = { a: 'fish-158', b: 'fish-159', at, seconds: LIFE.familiar - 1, lastNear: at, run: 0 };
  updateLife(w, at + 1000, { neighbors, points, scenes: new Map() });
  const expected = [...allKeys].sort((a, b) => a.localeCompare(b)).slice(0, LIFE.bondLimit);
  assert.deepEqual(Object.keys(w.data.life.bonds), expected);
  assert(!w.data.life.bonds[lastPair]);
  assert(w.data.life.stories['friend:fish-158:fish-159']);
});
const cell = (x, y, ch = 'o') => ({ x, y, ch, color: '#88aacc' });
function world() { return new World(t, crypto.randomUUID(), { populate: false }); }
function fish(w, x = 20, y = 20, actor = 'alice', id = crypto.randomUUID(), ch = 'o') {
  assert(w.apply({ id, actor, nick: actor, name: '小鱼', t, kind: 'fish', x, y, cells: [cell(0, 0, ch), cell(1, 0, ch)], cost: 2 }).ok); return id;
}
function scene(w, x, y) { const id = crypto.randomUUID(); assert(w.apply({ id, actor: 'maker', t, kind: 'scene', x, y, cells: [cell(0, 0, '#'), cell(0, 1, '#')], cost: 2 }).ok); return id; }
function context(w, now) { return lifeContext(w, now, w.sceneryMap(), w.fishGroups()); }
function track(w, seconds, start = t) { for (let i = 1; i <= seconds; i++) updateLife(w, start + i * 1000, context(w, start + i * 1000)); }
function source(w) { return { roots: w.data.roots, ops: w.data.ops, breeding: w.data.breeding }; }
function weatherTime(w, type) { let now = Math.ceil((t + 180000) / LIFE.weatherPeriod) * LIFE.weatherPeriod; while (weatherAt(w.data, now).type !== type) now += LIFE.weatherPeriod; return now; }

test('繁殖合体的虚拟鱼无需查找整海普通队形，实际游动方向保持一致', () => {
  const w = world(), at = Math.ceil(t / 60000) * 60000;
  for (const [index, x] of [10, 18, 26].entries()) fish(w, x, 20, 'school-' + index);
  const center = { x: 20, y: 23 }, pair = { ...center, id: 'breed:virtual', created: t, facing: 1 };
  const eager = context(w, at), expected = idleMotion(w, pair, at, eager, center);
  assert.equal(eager.school.size, 3);
  const groups = w.fishGroups(), working = lifeContext(w, at, w.sceneryMap(), groups, w.bodyLayout(groups));
  Object.defineProperty(working, 'school', { get() { throw new Error('虚拟鱼没有普通队形'); } });
  assert.deepEqual(idleMotion(w, pair, at, working, center), expected);
});

test('每条鱼的小性格稳定，创建、自然出生标识和旧鱼都有自然描述', () => {
  const w = world(), id = fish(w), saved = w.serialize();
  assert.equal(personality(id), personality(saved.fishes[id].id)); assert(personalityText(id));
  assert.equal(new Set(Array.from({ length: 100 }, (_, i) => personality(`born:${i}`))).size, 4);
  const restored = restoreCheckpoint({ world: saved, lastOnlineAt: t }, t + 1000).world;
  assert.equal(fishLifeText(restored.data, id).habit, fishLifeText(saved, id).habit);
});
test('真正相处45秒成为熟鱼，关系不靠重复快照增加，故事属于双方', () => {
  const w = world(), a = fish(w), b = fish(w, 25, 20, 'bob'); track(w, 44);
  assert.equal(w.data.life.bonds[pairKey(a, b)].seconds, 44); assert.equal(storiesFor(w.data, fishCatalog(w.data), 'bob').filter(r => r.kind === 'friend').length, 0);
  track(w, 1, t + 44000); const saved = w.serialize(); for (let i = 0; i < 4; i++) w.merge(saved);
  assert.equal(w.data.life.bonds[pairKey(a, b)].seconds, 45);
  for (const actor of ['alice', 'bob']) assert.equal(storiesFor(w.data, fishCatalog(w.data), actor).filter(r => r.kind === 'friend').length, 1);
});
test('熟鱼在实际分开后重逢，休眠和全员离线不冒充相处或重逢', () => {
  const w = world(), a = fish(w), b = fish(w, 25, 20, 'bob'); track(w, 45);
  const before = w.data.life.bonds[pairKey(a, b)].seconds;
  updateLife(w, t + 500000, context(w, t + 500000)); assert.equal(w.data.life.bonds[pairKey(a, b)].seconds, before); assert(!Object.values(w.data.life.stories).some(r => r.kind === 'reunion'));
  w.data.fishes[b].x = 80; track(w, 190, t + 500000); w.data.fishes[b].x = 25; track(w, 1, t + 690000);
  assert.equal(Object.values(w.data.life.stories).filter(r => r.kind === 'reunion').length, 1);
});
test('环形海两侧可以认识熟鱼，隔着造景不会积累关系', () => {
  const w = world(), a = fish(w, 997), b = fish(w, 2, 20, 'bob'); track(w, 45); assert.equal(w.data.life.bonds[pairKey(a, b)].seconds, 45);
  const blocked = world(), x = fish(blocked, 20), y = fish(blocked, 26, 20, 'bob'); scene(blocked, 24, 20); track(blocked, 60); assert(!blocked.data.life.bonds[pairKey(x, y)]);
});
test('环形边界的遮挡、等距邻居和常去造景在完整模拟中保持原有结果', () => {
  const start = 1749989820000, w = new World(start, 'life-neighbor-regression', { populate: false });
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  function add(n, x, y, kind, cells) {
    assert(w.apply({ id: id(n), actor: id(n), t: start, kind, gender: 'female', x, y, cells, cost: cells.length }).ok);
  }
  for (const [n, x, y] of [[1, 997, 20], [2, 991, 20], [3, 997, 26], [4, 3, 20], [5, 9, 14], [6, 9, 33], [7, 997, 38]]) {
    add(n, x, y, 'fish', [cell(0, 0, 'Q'), cell(1, 0, 'Q')]);
  }
  add(8, 0, 20, 'scene', [cell(0, 0, '#'), cell(0, 1, '#')]);
  add(9, 999, 32, 'scene', [cell(0, 0, '#'), cell(1, 0, '#')]);
  w.data.life.haunts[id(3)] = { scene: id(9), x: 0, y: 32, at: start, away: false, visited: false, found: false };

  const first = context(w, start);
  assert.deepEqual(first.neighbors.get(id(1)).map(p => p.id), [id(2), id(3), id(5)]);
  assert.deepEqual(first.scenes.get(id(7)), { id: id(9), x: 999, y: 32 });
  assert.deepEqual(first.memories.get(id(3)), { near: true, exists: true, spot: { id: id(9), x: 0, y: 32 } });

  for (let i = 1; i <= 120; i++) w.step(start + i * CONFIG.step);
  const { fishes, life } = w.serialize();
  const state = JSON.stringify({ fishes, life }, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  assert.equal(createHash('sha256').update(state).digest('hex'), '122247f3e711c3b2cad080a2f05e1a606440380e020d22db56d3f55f3b22c18d');
});
test('距离与标识排序都相等时保留跨海界的分桶和桶内顺序', () => {
  const w = world(), groups = new Map(), right = 'e\u0301', left = 'é', alsoLeft = 'é\u0001';
  assert.equal(right.localeCompare(left), 0);
  assert.equal(left.localeCompare(alsoLeft), 0);
  for (const [id, x] of [['center', 0], [right, 1], [alsoLeft, 999], [left, 999]]) {
    w.data.fishes[id] = { id, x, y: 20, facing: 1 };
    groups.set(id, [{ x: 0, y: 0 }]);
  }
  const ctx = lifeContext(w, t, new Map(), groups);
  assert.deepEqual(ctx.neighbors.get('center').map(p => p.id), [alsoLeft, left, right]);
  assert.equal(ctx.crowdedNeighbor(ctx.points.get('center')).id, alsoLeft);
});
test('避让时隔着环形边界的鱼与同侧鱼相距相同，按标识选择，再考虑遮挡', () => {
  const w = world(), groups = new Map();
  for (const [id, x, width] of [['center', 1, 2], ['first', 996, 4], ['second', 4, 2]]) {
    w.data.fishes[id] = { id, x, y: 20, facing: 1 };
    groups.set(id, Array.from({ length: width }, (_, x) => cell(x, 0)));
  }
  const open = lifeContext(w, t, w.sceneryMap(), groups);
  assert.equal(open.crowdedNeighbor(open.points.get('center')).id, 'first');
  scene(w, 0, 20);
  const blocked = lifeContext(w, t, w.sceneryMap(), groups);
  assert.equal(blocked.crowdedNeighbor(blocked.points.get('center')).id, 'second');
});
test('自然步移动和重建鱼群分区后，已打开的观察仍保留原来的鱼位与邻居', () => {
  const w = world(), groups = new Map();
  for (const [id, x] of [['center', 1], ['near', 999], ['far', 90]]) {
    w.data.fishes[id] = { id, x, y: 20, facing: 1 };
    groups.set(id, [cell(0, 0)]);
  }
  const layout = w.bodyLayout(groups), scenery = new Map();
  lifeContext(w, t, scenery, groups, layout);
  const observed = lifeContext(w, t, scenery, groups);
  w.data.fishes.near.x = 98;
  w.data.fishes.far.x = 2;
  const working = lifeContext(w, t + 500, scenery, groups, layout);
  for (const [ctx, id] of [[working, 'far'], [observed, 'near']]) {
    for (let i = 0; i < 5; i++) assert.equal(ctx.crowdedNeighbor(ctx.points.get('center')).id, id);
    assert.deepEqual(ctx.neighbors.get('center').map(p => p.id), [id]);
  }
  assert.equal(observed.points.get('near').x, 999);
});
test('旧存档的分数坐标保留距离边界上的单向视线', () => {
  const w = world(), a = fish(w, 7, 20), b = crypto.randomUUID();
  assert(w.apply({ id: b, actor: 'bob', t, kind: 'fish', x: 20, y: 9, cells: [cell(0, 0), cell(0, 1)], cost: 2 }).ok);
  const saved = w.serialize();
  saved.fishes[a].x = 7.4999999999999;
  saved.fishes[b].y = 9.499999999999998;
  const restored = restoreCheckpoint({ world: saved, lastOnlineAt: t }, t).world;
  assert.deepEqual(context(restored, t).neighbors.get(a).map(p => p.id), [b]);
  scene(restored, 17, 13);
  const blocked = context(restored, t);
  assert.deepEqual(blocked.neighbors.get(a), []);
  assert.deepEqual(blocked.neighbors.get(b).map(p => p.id), [a]);
});
test('三条附近鱼会短暂同游，一分钟内自动散开，双鱼不组成鱼群', () => {
  const w = world(), ids = [fish(w, 20), fish(w, 25, 20, 'bob'), fish(w, 30, 20, 'carol')], at = Math.ceil(t / 60000) * 60000 + 1000;
  const group = context(w, at); assert.equal(group.school.size, 3);
  const motions = ids.map(id => idleMotion(w, w.data.fishes[id], at, group)); assert(motions.every(m => m.dx === motions[0].dx && m.dy === motions[0].dy));
  assert.equal(context(w, at + 20000).school.size, 0); delete w.data.fishes[ids[2]]; assert.equal(context(w, at).school.size, 0);
});

test('熟鱼同游先留出鱼体间距，大鱼和环形边界也会主动分开', () => {
  for (const [x, otherX, width] of [[20, 22, 2], [998, 0, 2], [20, 30, 10]]) {
    const w = world(), ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    for (const [i, pos] of [x, otherX].entries()) assert(w.apply({ id: ids[i], actor: ids[i], t, kind: 'fish', x: pos, y: 20, gender: 'female', cells: Array.from({ length: width }, (_, j) => cell(j, 0, 'Q')), cost: width }).ok);
    track(w, 45);
    const at = Math.ceil((t + 45000) / 180000) * 180000 + 20000, group = context(w, at);
    const a = idleMotion(w, w.data.fishes[ids[0]], at, group), b = idleMotion(w, w.data.fishes[ids[1]], at, group);
    assert.equal(a.dx, -1); assert.equal(b.dx, 1); assert.equal(a.dy, 0); assert.equal(b.dy, 0);
  }
});

test('48条扎堆熟鱼持续游动并散开，完整模拟无重叠且快照顺序不影响结果', () => {
  const w = new World(t, 'crowded-regression', { populate: false }), ids = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
    const id = `00000000-0000-4000-8000-${String(row * 8 + col).padStart(12, '0')}`; ids.push(id);
    assert(w.apply({ id, actor: id, t, kind: 'fish', x: 20 + col * 2, y: 20 + row, gender: 'female', cells: [cell(0, 0, 'Q'), cell(1, 0, 'Q')], cost: 2 }).ok);
  }
  track(w, 45); assert(Object.values(w.data.life.bonds).every(b => b.seconds >= LIFE.familiar));
  w.data.tick = t + 45000;
  const replica = new World(t, 'replica', { populate: false }); replica.data = w.serialize();
  replica.data.fishes = Object.fromEntries(Object.entries(replica.data.fishes).reverse()); replica.data.chars = Object.fromEntries(Object.entries(replica.data.chars).reverse());
  for (let i = 1; i <= 240; i++) {
    const now = t + 45000 + i * CONFIG.step; w.step(now); replica.step(now);
    for (const owners of w.fishOccupants().values()) assert.equal(owners.size, 1);
    if (i === 60) for (const id of ids) assert(w.fishStatus(id, now).movement > 0, `${id} should escape the initial crowd`);
  }
  assert.equal(Object.keys(w.data.fishes).length, ids.length);
  for (const id of ids) { assert(w.fishStatus(id, w.data.tick).movement > 5, `${id} should keep swimming`); assert.deepEqual(w.data.fishes[id], replica.data.fishes[id]); }
});

test('熟鱼被邻鱼与造景夹住时选择空闲方向绕行', () => {
  const w = world(), a = '00000000-0000-4000-8000-000000000001';
  assert(w.apply({ id: a, actor: 'alice', t, kind: 'fish', x: 20, y: 20, gender: 'female', cells: [cell(0, 0, 'Q'), cell(0, 1, 'Q')], cost: 2 }).ok);
  fish(w, 21, 20, 'bob', '00000000-0000-4000-8000-000000000002', 'Q'); scene(w, 19, 20); track(w, 45); w.data.tick = t + 45000;
  w.step(t + 45000 + CONFIG.step);
  assert.notEqual(w.data.fishes[a].y, 20);
  for (const owners of w.fishOccupants().values()) assert.equal(owners.size, 1);
  for (const c of w.fishCells(a)) assert(!w.sceneryMap().has(`${(w.data.fishes[a].x + w.data.fishes[a].facing * c.x + 1000) % 1000},${w.data.fishes[a].y + c.y}`));
});
test('造景附近停留45秒形成常去之处，搬走或删除造景仍遵循现有操作', () => {
  const w = world(), id = fish(w), spot = scene(w, 24, 20); track(w, 45);
  assert(fishLifeText(w.data, id).haunt); assert.equal(w.data.life.places[id].scene, spot);
  assert(w.apply({ id: crypto.randomUUID(), actor: 'maker', kind: 'sceneMove', scene: spot, x: 80, y: 20, cost: 0, t: t + 46000 }).ok);
  assert(w.apply({ id: crypto.randomUUID(), actor: 'maker', kind: 'sceneDelete', scene: spot, cost: 0, t: t + 47000 }).ok);
  track(w, 1, t + 47000); assert(!fishLifeText(w.data, id).haunt); assert(!w.data.life.places[id]); assert.equal(w.wallet('maker'), 18);
});
test('水流、光带和浮游天气在同一世界同一时刻一致，55秒后恢复平静', () => {
  const w = world(); for (const type of ['current', 'light', 'plankton']) { const at = weatherTime(w, type); assert.deepEqual(weatherAt(w.data, at), weatherAt(clone(w.data), at)); assert.equal(weatherAt(w.data, at + LIFE.weatherDuration).type, 'calm'); }
});
test('免费浮游食物最多10颗，出生位置与来源固定，重复和旧快照不复活', () => {
  const w = world(), at = weatherTime(w, 'plankton'); w.data.tick = at; spawnPlankton(w, at); const ids = Object.keys(w.data.chars); assert.equal(ids.length, 10);
  assert(ids.every(id => validPlankton(w.data.chars[id], w.data.roots))); assert.equal(w.wallet('alice'), 20); const saved = w.serialize();
  w.step(at + LIFE.planktonLife); assert(ids.every(id => w.data.chars[id].kind === 'burn')); w.merge(saved); spawnPlankton(w, at + 1000); assert(ids.every(id => w.data.chars[id].kind === 'burn'));
  assert.equal(Object.keys(w.data.scenes).length, 0);
});
test('离线不会补造历史浮游食物，出生避开鱼与造景', () => {
  const w = world(), at = weatherTime(w, 'plankton'), weather = weatherAt(w.data, at), initial = planktonSource(w.data, weather.seed, weather.slot, 0);
  fish(w, initial.x, initial.y, 'alice'); spawnPlankton(w, at); assert(!w.data.chars[initial.id]);
  const quiet = world(), time = weatherTime(quiet, 'plankton'); quiet.step(time + LIFE.weatherDuration); assert.equal(Object.values(quiet.data.chars).filter(c => c.plankton).length, 0);
});
test('每种性格都优先吃可见食物，完整环境模拟不穿鱼和地形，消费不改变', () => {
  for (const trait of ['quiet', 'social', 'deep', 'curious']) {
    const w = world(); let id; do { id = crypto.randomUUID(); } while (personality(id) !== trait);
    fish(w, 20, 20, 'alice', id); scene(w, 22, 21);
    const meal = crypto.randomUUID(); assert(w.apply({ id: meal, actor: 'feed', t, kind: 'food', cost: 1, x: 21, y: 0, ch: '食', color: '#ffffff' }).ok); w.data.chars[meal].y = 19;
    w.step(t + 500); assert.equal(w.data.chars[meal].entity, id); assert.equal(w.wallet('alice'), 18); assert.equal(w.wallet('feed'), 19);
    for (let step = 2; step < 160; step++) w.step(t + step * 500);
    for (const owners of w.fishOccupants().values()) assert.equal(owners.size, 1);
    for (const c of w.fishCells(id)) { const f = w.data.fishes[id], x = f.x + f.facing * c.x, y = f.y + c.y; assert(w.waterAt(x, y)); assert(!w.sceneryMap().has(`${(x % 1000 + 1000) % 1000},${y}`)); }
  }
});
test('浮游食物被吃后正常增长，脱落重新计时并可沉积与付费复制', () => {
  const w = world(), at = weatherTime(w, 'plankton'); w.data.tick = at; spawnPlankton(w, at);
  const c = Object.values(w.data.chars)[0], id = fish(w, (c.x + 998) % 1000, c.y, 'alice'); w.step(at + 500); assert.equal(c.entity, id); assert(!freshPlankton(c)); assert(validPlankton(c, w.data.roots));
  const f = w.data.fishes[id]; c.kind = 'food'; c.entity = ''; c.x = f.x; c.y = w.floorAt(c.x) - 1; c.born = at + 1000; c.path.push({ id: 'shed-test', reason: 'shed', t: c.born, target: '', x: c.x, y: c.y });
  f.x = (f.x + 300) % 1000; f.y = 20; w.step(c.born + CONFIG.foodLife); assert.equal(c.kind, 'scene'); assert(validPlankton(c, w.data.roots));
  const scaled = crypto.randomUUID(); assert(w.apply({ id: scaled, actor: 'maker', kind: 'sceneScale', scene: c.entity, factor: 2, cost: 3, t: w.data.tick }).ok === false); // Cannot enlarge through the fixed seabed.
  assert.equal(w.wallet('maker'), 20);
  // The random sea can put the swimmer at the old fixed destination. Choose
  // open water for the move and its subsequent 2×2 expansion.
  const blocked = new Set([...w.fishMap().keys(), ...w.sceneryMap().keys()]);
  for (const row of Object.values(w.data.chars)) if (row.kind === 'seaweed') blocked.add(`${row.x},${row.y}`);
  const x = Array.from({ length: CONFIG.width - 1 }, (_, i) => i).find(i =>
    [i, i + 1].every(col => [20, 21].every(y => w.waterAt(col, y) && !blocked.has(`${col},${y}`))));
  assert.notEqual(x, undefined);
  assert(w.apply({ id: crypto.randomUUID(), actor: 'maker', kind: 'sceneMove', scene: c.entity, x, y: 20, cost: 0, t: w.data.tick }).ok);
  const grow = crypto.randomUUID(); assert(w.apply({ id: grow, actor: 'maker', kind: 'sceneScale', scene: c.entity, factor: 2, cost: 3, t: w.data.tick }).ok);
  assert.equal(w.wallet('maker'), 17); assert(validPlankton(c, w.data.roots));
  assert(Object.values(w.data.chars).filter(c => c.id.startsWith(grow)).every(c => !c.plankton && c.payer === 'maker'));
  assert(w.apply({ id: crypto.randomUUID(), actor: 'maker', kind: 'sceneEdit', scene: c.entity, cell: c.id, ch: '景', color: '#aabbcc', cost: 0, t: w.data.tick }).ok);
  assert(validPlankton(c, w.data.roots));
});
test('鱼生消息去重，选择一条值得看的回来消息，其他作者消息不混入', () => {
  const w = world(), a = fish(w), b = fish(w, 50, 20, 'bob'); recordStory(w, 'meal', a, t + 1000); recordStory(w, 'meal', a, t + 1000); recordStory(w, 'birth', b, t + 2000);
  const stories = storiesFor(w.data, fishCatalog(w.data), 'alice'); assert.equal(stories.filter(r => r.kind === 'meal').length, 1); assert(!stories.some(r => r.fish === b));
  assert.equal(returnStory(stories, t).kind, 'meal'); assert.equal(returnStory(stories, t + 2000), undefined);
  assert.equal(storyText(stories[0], () => '<脚本>'), '「<脚本>」第一次吃到了鱼食');
});
test('旧版检查点安全迁移，关系与故事随备份、合流和协调者接替保留', () => {
  const w = world(), a = fish(w), b = fish(w, 25, 20, 'bob'); track(w, 45); const saved = w.serialize(); saved.tick = t + 45000;
  const restored = restoreCheckpoint({ world: saved, lastOnlineAt: saved.tick }, saved.tick + 1000).world;
  assert.equal(restored.data.life.bonds[pairKey(a, b)].seconds, 45); restored.merge(saved); assert.equal(restored.data.life.bonds[pairKey(a, b)].seconds, 45);
  const legacy = clone(saved); delete legacy.life; const migrated = restoreCheckpoint({ world: legacy, lastOnlineAt: saved.tick }, saved.tick + 1000).world; assert(validateLife(migrated.data.life, source(migrated)));
  const expired = restoreCheckpoint({ world: saved, lastOnlineAt: saved.tick }, saved.tick + CONFIG.offlineLife).world; assert.equal(Object.keys(expired.data.life.bonds).length, 0);
});
test('分区关系与故事合流顺序无关，累计相处取最大值，历史片段有上限', () => {
  const w = world(), a = fish(w), b = fish(w, 25, 20, 'bob'); track(w, 45); const left = clone(w.data.life), right = clone(left), key = pairKey(a, b); right.bonds[key].at += 1000; right.bonds[key].seconds += 1;
  assert.deepEqual(mergeLife(left, right, w.data), mergeLife(right, left, w.data)); assert.equal(mergeLife(left, right, w.data).bonds[key].seconds, 46);
  for (let i = 0; i < 600; i++) recordStory(w, 'reunion', a, t + i * 600000, { other: b }); assert.equal(Object.keys(w.data.life.stories).length, LIFE.storyLimit);
});
test('无效时间、关系、来源和浮游凭据被拒绝，合法自然记录可以验证', () => {
  const w = world(), a = fish(w), b = fish(w, 25, 20, 'bob'); track(w, 45); assert(validateLife(w.data.life, source(w)));
  for (const mutate of [l => l.at = Infinity, l => l.bonds[pairKey(a, b)].seconds = -1, l => l.bonds[pairKey(a, b)].run = 999, l => l.stories[Object.keys(l.stories)[0]].fish = 'forged', l => l.bloomThrough.nope = 1]) { const bad = clone(w.data.life); mutate(bad); assert(!validateLife(bad, source(w))); const snapshot = w.serialize(); snapshot.life = bad; assert.throws(() => w.merge(snapshot), /鱼生记录/); }
  const at = weatherTime(w, 'plankton'); spawnPlankton(w, at); const c = Object.values(w.data.chars).find(c => c.plankton); assert(validPlankton(c, w.data.roots)); c.color = '#ffffff'; assert(!validPlankton(c, w.data.roots));
});

test('密集鱼群混有自然出生鱼时，关系上限和同一秒的熟鱼故事保留原有顺序', () => {
  const start = Date.UTC(2025, 5, 15, 12, 17);
  const actual = new World(start, 'mixed-school', { populate: false });
  const ids = Array.from({ length: 105 }, (_, i) => i % 19 === 0 ? 'born:breed:older:' + i
    : '00000000-0000-4000-8000-' + String(i).padStart(12, '0')).reverse();
  for (const [i, id] of ids.entries()) {
    actual.data.fishes[id] = { id, x: 997 + i % 5, y: 20 + i % 3, facing: 1 };
    actual.data.chars[id] = { id, entity: id, kind: 'fish', x: 0, y: 0, path: [] };
  }
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if ((i + j) % 7) continue;
    const [a, b] = [ids[i], ids[j]].sort(), key = a + '|' + b;
    actual.data.life.bonds[key] = { a, b, seconds: 44, at: start, lastNear: start, run: 9 };
    if ((i + j) % 3 === 0) recordStory(actual, 'friend', a, start - i, { other: b });
  }
  for (let i = 0; i < LIFE.storyLimit; i++) recordStory(actual, 'meal', 'older-' + i, start - i);
  const expected = new World(start, 'mixed-school', { populate: false });
  expected.data = actual.serialize();
  const now = start + 1000, c = context(actual, now), bonds = expected.data.life.bonds, seen = new Set();
  for (const [id, others] of c.neighbors) for (const q of others) {
    const [a, b] = [id, q.id].sort(), key = a + '|' + b;
    if (seen.has(key)) continue;
    seen.add(key);
    const old = bonds[key];
    if (old) recordStory(expected, 'friend', a, now, { other: b });
    bonds[key] = { a, b, seconds: (old?.seconds || 0) + 1, at: now, lastNear: now, run: old ? old.run + 1 : 0 };
  }
  const keys = Object.keys(bonds).sort((a, b) => a.localeCompare(b)).slice(0, LIFE.bondLimit);
  updateLife(actual, now, c);
  assert.deepEqual(Object.keys(actual.data.life.bonds), keys);
  assert.deepEqual(actual.data.life.bonds, Object.fromEntries(keys.map(key => [key, bonds[key]])));
  assert.deepEqual(Object.keys(actual.data.life.stories), Object.keys(expected.data.life.stories));
  assert.deepEqual(actual.data.life.stories, expected.data.life.stories);
});

test('时钟回退时，暂时分开的旧伙伴仍优先于新建立的关系', () => {
  const w = world(), now = t - 1000;
  const ids = Array.from({ length: 94 }, (_, i) => 'fish-' + String(i).padStart(3, '0'));
  for (const [i, id] of ids.entries()) {
    w.data.fishes[id] = { id, x: i === ids.length - 1 ? 200 : 10, y: 20, facing: 1 };
    w.data.chars[id] = { id, entity: id, kind: 'fish', x: 0, y: 0, path: [] };
  }
  const [a, b] = ids.slice(-2), old = { a, b, seconds: 8, at: t, lastNear: t, run: 7 };
  w.data.life.bonds[pairKey(a, b)] = old;
  const c = context(w, now), active = new Set();
  for (const [id, others] of c.neighbors) for (const q of others) active.add(pairKey(id, q.id));
  assert(active.size > LIFE.bondLimit);
  const expected = [pairKey(a, b), ...[...active].sort((a, b) => a.localeCompare(b)).slice(0, LIFE.bondLimit - 1)];
  updateLife(w, now, c);
  assert.deepEqual(Object.keys(w.data.life.bonds), expected);
  assert.deepEqual(w.data.life.bonds[pairKey(a, b)], old);
});

test('旧鱼名按语言规则排序并列时，保留已有伙伴的相对位置', () => {
  const w = world(), now = t + 1000, ids = ['a', '\u00e9', 'e\u0301'];
  for (const id of ids) {
    w.data.fishes[id] = { id, x: 10, y: 20, facing: 1 };
    w.data.chars[id] = { id, entity: id, kind: 'fish', x: 0, y: 0, path: [] };
  }
  const [a, fresh, b] = ids, oldKey = pairKey(a, b), freshKey = pairKey(a, fresh);
  assert.equal(oldKey.localeCompare(freshKey), 0);
  w.data.life.bonds[oldKey] = { a, b, seconds: 8, at: t, lastNear: t, run: 7 };
  updateLife(w, now, context(w, now));
  assert.deepEqual(Object.keys(w.data.life.bonds), [oldKey, freshKey, pairKey(fresh, b)]);
  assert.equal(w.data.life.bonds[oldKey].seconds, 9);
});

test('伙伴合流保留上限外的较新旧记录、同时间戳的并列顺序和原始字段胜者', () => {
  const left = newLife(t), right = newLife(t);
  for (let i = 0; i < LIFE.bondLimit; i++) {
    const a = 'a', b = 'fish-' + String(i).padStart(4, '0'), key = pairKey(a, b);
    right.bonds[key] = { a, b, seconds: 3, at: t, lastNear: t, run: 2 };
    if (i % 3) left.bonds[key] = { ...right.bonds[key], seconds: i % 7 };
  }
  function check() {
    const union = {};
    for (const key of new Set([...Object.keys(left.bonds), ...Object.keys(right.bonds)])) {
      const x = left.bonds[key], y = right.bonds[key];
      const fresh = !x ? y : !y ? x : x.at !== y.at ? x.at > y.at ? x : y : JSON.stringify(x) < JSON.stringify(y) ? x : y;
      union[key] = { ...fresh, seconds: Math.max(x?.seconds || 0, y?.seconds || 0) };
    }
    const expected = Object.fromEntries(Object.entries(union).sort(([a, x], [b, y]) => y.at - x.at || a.localeCompare(b)).slice(0, LIFE.bondLimit));
    assert.equal(JSON.stringify(mergeLife(left, right, { tick: t }).bonds), JSON.stringify(expected));
  }
  left.bonds['a|x'] = { a: 'a', b: 'x', seconds: 80, at: t - 1, lastNear: t - 1, run: 1 };
  check();
  left.bonds['a|x'].at = t + 1;
  const key = 'a|fish-0001';
  left.bonds[key] = { extra: { n: 2 }, ...left.bonds[key], seconds: 11 };
  right.bonds[key] = { ...right.bonds[key], extra: { n: 1 } };
  for (const b of ['\u00e9', 'e\u0301']) left.bonds[pairKey('a', b)] = { a: 'a', b, seconds: 0, at: t, lastNear: t, run: 0 };
  check();
});

test('关系验证核对整条键和真实创建凭据，旧字典的索引名可以与凭据标识不同', () => {
  const life = newLife(t), a = 'a|part', b = 'born:b', row = { a, b, seconds: 3, at: t, lastNear: t, run: 2 };
  const key = pairKey(a, b);
  life.bonds[key] = row;
  const legacy = { roots: {}, ops: { older: { kind: 'fish', id: a } }, breeding: { other: { status: 'born', baby: { id: b } } } };
  assert(validateLife(life, legacy));
  const indexed = { roots: {}, ops: { [a]: legacy.ops.older }, breeding: { b: legacy.breeding.other } };
  assert(validateLife(life, indexed));
  for (const bad of [key + 'x', key.replace('part|', 'part-'), key.replace('part', 'past'), key.replace('born', 'barn')]) {
    assert(!validateLife({ ...life, bonds: { [bad]: row } }, indexed));
  }
  assert(!validateLife(life, { ...indexed, ops: { [a]: { kind: 'fish', id: 'x' } } }));
});
test('饥饿游动换相按原鱼标识逐字计算，兼容改名标识和回退时间', () => {
  const fish = { id: '海🐟:甲', created: 100000, lastFed: -200000000 };
  for (const id of ['海🐟:甲', 'id:2', '海🐟:甲']) {
    fish.id = id;
    for (const at of [0, 99999, 100000, 111999, 112000, 232000, 123321, 123321]) {
      const phase = Math.floor((at - fish.created) / 12000);
      const value = hash(`${id}:${phase}`);
      assert.deepEqual(idleMotion({}, fish, at), { dx: value % 3 - 1, dy: Math.floor(value / 3) % 3 - 1 });
    }
  }
});
