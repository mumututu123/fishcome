import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, clone } from '../www/engine.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { LIFE, personality, personalityText, weatherAt, lifeContext, updateLife, idleMotion, fishLifeText, recordStory, mergeLife, newLife, validateLife, spawnPlankton, planktonSource, validPlankton, freshPlankton, pairKey, storiesFor, storyText, returnStory } from '../www/life.js';
import { fishCatalog } from '../www/fish-profile.js';
const t = Math.floor((Date.now() - 3600000) / 180000) * 180000 + 80000;
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
test('三条附近鱼会短暂同游，一分钟内自动散开，双鱼不组成鱼群', () => {
  const w = world(), ids = [fish(w, 20), fish(w, 25, 20, 'bob'), fish(w, 30, 20, 'carol')], at = Math.ceil(t / 60000) * 60000 + 1000;
  const group = context(w, at); assert.equal(group.school.size, 3);
  const motions = ids.map(id => idleMotion(w, w.data.fishes[id], at, group)); assert(motions.every(m => m.dx === motions[0].dx && m.dy === motions[0].dy));
  assert.equal(context(w, at + 20000).school.size, 0); delete w.data.fishes[ids[2]]; assert.equal(context(w, at).school.size, 0);
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
  const quiet = world(), time = weatherTime(quiet, 'plankton'); quiet.step(time + LIFE.weatherDuration); assert.equal(Object.keys(quiet.data.chars).length, 0);
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
  assert(w.apply({ id: crypto.randomUUID(), actor: 'maker', kind: 'sceneMove', scene: c.entity, x: 70, y: 20, cost: 0, t: w.data.tick }).ok);
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
