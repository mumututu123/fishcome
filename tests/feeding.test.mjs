import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, hash, cellPosition } from './empty-world.mjs';
import { MEAL_INTERVAL, feedingStatus } from '../www/fish-status.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { updateContacts, finishBreeding } from '../www/breeding.js';
import { planktonSource, weatherAt, LIFE } from '../www/life.js';
import { growthRoll, weedId, GREENS, HOUR } from '../www/seaweed.js';
const t = Date.now() - 2 * MEAL_INTERVAL;
const cell = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
function fish(w, x = 20, y = 20, actor = 'alice', cells = [cell(0, 0), cell(1, 0)], gender) {
  const id = crypto.randomUUID(); assert(w.apply({ id, actor, kind: 'fish', cells, gender, x, y, t, cost: cells.length }).ok); return id;
}
function food(w, x, y, at = t, ch = '食') {
  const id = crypto.randomUUID(); assert(w.apply({ id, actor: id, kind: 'food', x, y: 0, ch, color: '#ffffff', cost: 1, t: at }).ok); w.data.chars[id].y = y; return id;
}
function spot(w, id) { const p = w.fishCells(id).map(c => cellPosition(w.data.fishes[id], c)).sort((a, b) => a.y - b.y || a.x - b.x)[0]; return { x: (p.x + 1000) % 1000, y: p.y - 1 }; }
function nearby(w, id, at) { const p = spot(w, id); return food(w, p.x, p.y, at); }
function hold(w) { for (const f of Object.values(w.data.fishes)) { f.cx = f.cy = -10; } }
test('两只眼睛跨越深浅水界线时，患病鱼仍能优先追到环绕边界的药食', () => {
  for (const [depth, ill, expected] of [[59, true, 4], [60, true, 6], [59, false, 6]]) {
    const w = new World(t), id = fish(w, 5, depth, 'alice', [cell(0, 0, 'o'), cell(0, 1, 'o')]);
    Object.assign(w.data.fishes[id], { facing: 1, cx: 1 });
    if (ill) w.data.population.illnesses[id] = { at: t, nextLossAt: t + HOUR, curedAt: 0 };
    food(w, 987, depth, t, '乐');
    food(w, 13, depth, t, '食');
    w.step(t + 500);
    assert.equal(w.data.fishes[id].x, expected);
  }
});
function eat(w, id, at) { const meal = nearby(w, id, at); hold(w); w.step(at); assert.equal(w.data.chars[meal].entity, id); return meal; }

test('第一餐可立即吃，同一结算步多颗食物也只吃一颗', () => {
  const w = new World(t), id = fish(w); const meals = [food(w, 19, 19), food(w, 19, 20), food(w, 20, 19)]; hold(w); w.step(t);
  assert.equal(meals.filter(key => w.data.chars[key].entity === id).length, 1); assert.equal(w.fishCells(id).length, 3); assert.equal(w.fishStatus(id, t).meals24, 1); assert(!w.fishStatus(id, t).canEat); assert.equal(w.data.fishes[id].lastMealAt, t);
});
test('按成功进食后连续60分钟计时，59分59秒拒绝，满60分钟允许', () => {
  const w = new World(t), id = fish(w); eat(w, id, t + 500);
  const before = t + 500 + MEAL_INTERVAL - 1, second = nearby(w, id, before); hold(w); w.step(before); assert.equal(w.data.chars[second].kind, 'food'); assert.equal(w.fishCells(id).length, 3);
  // Refresh the position around the fish after its idle step; the food is still unconsumed.
  Object.assign(w.data.chars[second], spot(w, id));
  hold(w); w.step(before + 1); assert.equal(w.data.chars[second].entity, id); assert.equal(w.fishStatus(id, before + 1).meals24, 2);
});
test('跨整点不会重置额度，回拨时钟不会提前解除冷却', () => {
  const at = Date.UTC(2026, 10, 24, 2, 59, 59), f = { created: at - 10000, lastFed: at, lastMealAt: at };
  assert(!feedingStatus(f, at + 1000).canEat); assert(!feedingStatus(f, at - 1).canEat); assert(feedingStatus(f, at + MEAL_INTERVAL).canEat);
});
test('吃饱的大鱼不参与争食，另一条可进食的鱼能吃到食物', () => {
  const w = new World(t), full = fish(w, 20, 20, 'big', [cell(0, 0), cell(1, 0), cell(2, 0)]), hungry = fish(w, 17, 20, 'small'); eat(w, full, t + 500);
  const meal = food(w, 19, 20, t + 1000); hold(w); w.step(t + 1000); assert.equal(w.data.chars[meal].entity, hungry); assert.equal(w.fishStatus(full, t + 1000).meals24, 1);
});
test('冷却中的鱼不追食也不因附近食物停住，食物继续下沉', () => {
  const w = new World(t); let id; do { id = crypto.randomUUID(); } while (hash(`${id}:0`) % 3 !== 2 || Math.floor(hash(`${id}:0`) / 3) % 3 !== 1);
  assert(w.apply({ id, actor: 'alice', t, kind: 'fish', cost: 2, x: 20, y: 20, cells: [cell(0, 0, 'o'), cell(1, 0)] }).ok);
  eat(w, id, t + 500); const meal = food(w, 19, 20, t + 1000), f = w.data.fishes[id]; f.cx = 1; f.cy = 0; const x = f.x; w.data.chars[meal].fall = 1;
  w.step(t + 1000); assert.equal(f.x, x + 1); assert.equal(w.data.chars[meal].kind, 'food'); assert.equal(w.data.chars[meal].y, 21);
});
test('海草与普通鱼食共用一次进食额度', () => {
  const w = new World(t), id = fish(w); eat(w, id, t + 500); const p = spot(w, id), x = (p.x + 999) % 1000, y = p.y;
  const wall = crypto.randomUUID(); assert(w.apply({ id: wall, actor: 'wall', t, kind: 'scene', x: (x + 999) % 1000, y: y + 1, cells: [cell(0, 0, '#'), cell(0, 1, '#')], cost: 2 }).ok);
  let hour = Math.floor(t / HOUR), source = `cell:${wall}:0`, weed; do { hour--; weed = weedId(source, hour, hash); } while (!growthRoll(source, hour, hash));
  w.data.chars[weed] = { id: weed, kind: 'seaweed', entity: weed, payer: '', ch: '草', color: GREENS[hash(weed) % GREENS.length], x, y, created: hour * HOUR, path: [], wild: { source, hour, plant: weed, index: 0, x, y } };
  hold(w); w.step(t + 1000); assert.equal(w.data.chars[weed].kind, 'seaweed'); assert.equal(w.fishStatus(id, t + 1000).meals24, 1);
});
test('浮游食物同样受限制，一小时内不能额外吃免费食物', () => {
  const w = new World(t), id = fish(w); eat(w, id, t + 500); let at = Math.ceil((t + 1000) / LIFE.weatherPeriod) * LIFE.weatherPeriod; while (weatherAt(w.data, at).type !== 'plankton') at += LIFE.weatherPeriod;
  assert(at < t + MEAL_INTERVAL); const weather = weatherAt(w.data, at), c = planktonSource(w.data, weather.seed, weather.slot, 0), p = cellPosition(w.data.fishes[id], w.fishCells(id)[0]);
  w.data.chars[c.id] = { ...c, x: (p.x + 999) % 1000, y: p.y - 1, kind: 'food', entity: '', payer: '', created: c.born, path: [], fall: 0, plankton: { seed: weather.seed, slot: weather.slot, index: 0 } };
  hold(w); w.step(at); assert.equal(w.data.chars[c.id].kind, 'food'); assert.equal(w.fishStatus(id, at).meals24, 1);
});
test('刷新、旧存档迁移与旧快照合流不会清掉冷却，脱落鱼元的历史仍计入', () => {
  const w = new World(t), id = fish(w), meal = eat(w, id, t + 500), saved = w.serialize(); delete saved.fishes[id].lastMealAt;
  const restored = restoreCheckpoint({ world: saved, lastOnlineAt: t + 500 }, t + 1000).world; restored.ambient = false;
  const second = nearby(restored, id, t + 1000); hold(restored); restored.step(t + 1000); assert.equal(restored.data.chars[second].kind, 'food');
  restored.merge(saved); assert(!restored.fishStatus(id, t + 1000).canEat); assert.equal(restored.data.fishes[id].lastMealAt, t + 500);
  const c = restored.data.chars[meal]; c.kind = 'burn'; c.entity = ''; delete restored.data.fishes[id].lastMealAt; restored.data.fishes[id].lastFed = t;
  hold(restored); restored.step(t + 1500); assert.equal(restored.data.fishes[id].lastMealAt, t + 500); assert.equal(restored.data.chars[second].kind, 'food');
});
test('繁殖中的双亲分别限一次；自然出生的小鱼立即可以吃第一餐', () => {
  const w = new World(t), male = fish(w, 20, 20, 'male', [cell(0, 0), cell(1, 0), cell(2, 0)], 'male'), female = fish(w, 23, 20, 'female', [cell(0, 0), cell(1, 0), cell(2, 0)], 'female');
  for (let elapsed = 0; elapsed <= 5000; elapsed += 500) updateContacts(w, t + elapsed, w.fishGroups(), w.sceneryMap());
  const record = w.breedingState(male); assert(record); const meals = [food(w, 19, 20, t + 5500), food(w, 26, 20, t + 5500), food(w, 19, 19, t + 5500)]; hold(w); w.step(t + 5500);
  assert.equal(w.fishStatus(male, t + 5500).meals24, 1); assert.equal(w.fishStatus(female, t + 5500).meals24, 1); assert.equal(meals.filter(id => w.data.chars[id].kind === 'fish').length, 2);
  const transition = (c, next, event) => { Object.assign(c, next); c.path.push({ ...event, target: next.entity || '', x: next.x, y: next.y }); };
  finishBreeding(w, record.ends, transition); const baby = record.baby.id; assert(w.fishStatus(baby, record.ends).canEat); assert(w.fishStatus(baby, record.ends).neverFed);
});
