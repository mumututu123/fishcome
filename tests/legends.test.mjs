import test from 'node:test';
import assert from 'node:assert/strict';
import { World, hash, cellPosition, clone } from '../www/engine.js';
import { LEGEND_MODELS, modelCells, tentacleCells, atomicCells, legendaryModel } from '../www/legendary-models.js';
import { LEGENDS, legendSchedule, legendGeometry, legendPosition, capturedFish, activeLegend, ghostRoll, ghostIndex, ghostSource, validGhostCell, validLegends, mergeLegends } from '../www/legends.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { storyText, validateLife } from '../www/life.js';
import { wrapX, deltaX, makeTerrain } from '../www/geography.js';

const started = Math.floor((Date.now() - 3600000) / LEGENDS.period) * LEGENDS.period, born = started - 7200000;
function fixture(kind) {
  let seed, s; do { seed = crypto.randomUUID(); s = legendSchedule({ [seed]: born }, seed, started / LEGENDS.period); } while (s?.kind !== kind);
  const w = new World(born, seed, { populate: false, ambient: false }); const e = { seed, slot: s.slot, at: started, arms: {}, minute: 0, drops: [] }; w.data.legends.events[s.id] = e; return { w, s, e };
}
const glyph = (x, y, ch = 'o') => ({ x, y, ch, color: '#88aacc' });
test('幽灵船航行和传奇预警时无需定位全海的鱼或造景', () => {
  for (const [kind, age] of [['ship', 180000], ['cthulhu', 500], ['godzilla', 500]]) {
    const { w } = fixture(kind);
    w.sceneryMap = w.fishGroups = w.fishMap = () => assert.fail('此时没有触手或光束需要定位');
    at(w, started + age);
  }
});
function fish(w, x, y, cells = [glyph(0, 0), glyph(1, 0)], actor = crypto.randomUUID()) { const id = crypto.randomUUID(); assert(w.apply({ id, actor, nick: '鱼', t: born, kind: 'fish', x: wrapX(x), y, cells, cost: cells.length }).ok); return id; }
function at(w, time) { w.data.tick = w.data.legends.at = time - 500; w.resolveLegends(time); w.data.tick = time; }
const sources = w => ({ roots: w.data.roots, ops: w.data.ops, breeding: w.data.breeding, chars: w.data.chars });

test('三种形体只使用指定鱼元，八根触须独立运动，吐息只使用四个字', () => {
  for (const [kind, chars] of [['cthulhu', '克苏鲁'], ['godzilla', '哥斯拉'], ['ship', '幽灵船']]) { assert(modelCells(kind).length > 30); assert(modelCells(kind).every(c => chars.includes(c.ch))); assert.equal(new Set(modelCells(kind).map(c => c.index)).size, modelCells(kind).length); }
  const a = tentacleCells(22), b = tentacleCells(27); assert.equal(new Set(a.map(c => c.arm)).size, 8); assert.notDeepEqual(a, b);
  assert(atomicCells(29).every(c => '原子吐息'.includes(c.ch))); assert.equal(atomicCells(27).length, 0); assert.equal(atomicCells(32).length, 0);
  assert(legendaryModel('godzilla', 24).some(c => c.role === 'charge')); assert(modelCells('ship').some(c => c.y === 0));
  assert(legendaryModel('godzilla', 27).filter(c => c.role === 'charge').length > legendaryModel('godzilla', 21).filter(c => c.role === 'charge').length);
  assert(Math.max(...tentacleCells(590).map(c => Math.abs(c.x))) < Math.max(...tentacleCells(560).map(c => Math.abs(c.x))));
});
test('整海抽签概率约0.2%、0.2%、1%，形体起源、位置和时长稳定', () => {
  const count = { cthulhu: 0, godzilla: 0, ship: 0 }; for (let slot = 0; slot < 30000; slot++) { const s = legendSchedule({ sea: 0 }, 'sea', slot); if (s) { count[s.kind]++; assert.deepEqual(legendSchedule({ sea: 0 }, 'sea', slot), s); } }
  assert(count.cthulhu > 30 && count.cthulhu < 100); assert(count.godzilla > 30 && count.godzilla < 100); assert(count.ship > 220 && count.ship < 380);
  const { w, s } = fixture('cthulhu'); assert.equal(s.duration, 600000); assert.equal(legendPosition(w.data.roots, s, started + 20000).y, s.floor - 1); assert.equal(legendSchedule(w.data.roots, '__proto__', s.slot), null);
});
test('触须真实接触才捕获，一鱼一须，捕获冻结，统一十分钟消失且不退款', () => {
  const { w, s, e } = fixture('cthulhu'), p = legendGeometry(w.data, e, started + 22000).find(c => c.role === 'arm' && c.arm === 0 && deltaX(c.x, s.x) < -6);
  assert(p); const id = fish(w, p.x, p.y), balance = w.wallet(w.data.fishes[id].actor); at(w, started + 22000);
  const capture = capturedFish(w.data, id, started + 22000); assert(capture); assert.equal(Object.values(e.arms).filter(c => c.fish === id).length, 1);
  const position = clone(w.data.fishes[id]); w.step(started + 22500); assert.equal(w.data.fishes[id].x, position.x); assert.equal(w.data.fishes[id].y, position.y);
  const saved = w.serialize(), owner = w.data.fishes[id].actor; const restored = restoreCheckpoint({ world: saved, lastOnlineAt: saved.tick }, s.ends + 1000).world;
  assert(!restored.data.fishes[id]); assert(saved.chars && Object.values(restored.data.chars).filter(c => c.path.some(p => p.reason === 'legendBurn')).length >= 2);
  restored.merge(saved); restored.merge(saved); assert(!restored.data.fishes[id]); assert.equal(restored.wallet(owner), balance);
  assert(Object.values(restored.data.life.stories).some(r => r.kind === 'cthulhuDepart')); assert(validLegends(restored.data.legends, sources(restored))); assert(validateLife(restored.data.life, sources(restored)));
});
test('造景挡住触须，预告期无捕获，已脱落的碎片不被跨鱼抹掉', () => {
  const { w, s, e } = fixture('cthulhu'), time = started + 22000, p = legendGeometry(w.data, e, time).find(c => c.role === 'arm' && c.arm === 0 && deltaX(c.x, s.x) < -6), id = fish(w, p.x, p.y);
  at(w, started + 19500); assert.equal(capturedFish(w.data, id, started + 19500), null); at(w, time); assert(capturedFish(w.data, id, time));
  const c = w.fishCells(id)[0]; c.kind = 'food'; c.entity = ''; c.x = p.x; c.y = p.y; c.born = time + 500; c.path.push({ reason: 'shed', t: time + 500, target: '', x: c.x, y: c.y });
  at(w, s.ends); assert.equal(c.kind, 'food');
  const other = fixture('cthulhu'), arm = legendGeometry(other.w.data, other.e, time).find(c => c.role === 'arm'); const blocked = new Map([[`${arm.x},${arm.y}`, {}]]);
  const later = legendGeometry(other.w.data, other.e, time, blocked).filter(c => c.role === 'arm' && c.arm === arm.arm); assert.equal(later.length, 0);
});
test('原子吐息汇总删除鱼元，最大两字块存活且可成为盲鱼，幸存故事去重', () => {
  const { w, s, e } = fixture('godzilla'), time = started + 29000, beam = legendGeometry(w.data, e, time).filter(c => c.role === 'beam'), p = beam.at(-2);
  // Put a three-cell vertical body at the edge, with only its eye inside the beam.
  const target = beam[6], id = fish(w, target.x, target.y, [glyph(0, 0), glyph(0, 1, '木'), glyph(0, 2, '木'), glyph(0, 3, '木'), glyph(0, 4, '木'), glyph(0, 5, '木')]); at(w, time);
  assert(w.data.fishes[id]); assert(w.fishCells(id).length >= 2); const stories = Object.values(w.data.life.stories).filter(r => r.kind === 'atomicSurvivor' && r.fish === id); assert.equal(stories.length, 1); assert.match(storyText(stories[0], () => '鱼'), /哥斯拉原子吐息幸存者/);
  at(w, time + 200); assert.equal(Object.values(w.data.life.stories).filter(r => r.kind === 'atomicSurvivor' && r.fish === id).length, 1);
  const saved = w.serialize(); w.merge(saved); assert(validLegends(w.data.legends, sources(w)));
});
test('原子吐息致死不会被旧快照复活，直接烧毁不产生鱼食，遮挡位置可见', () => {
  const { w, s, e } = fixture('godzilla'), time = started + 29500, beam = legendGeometry(w.data, e, time).filter(c => c.role === 'beam'), p = beam[2], id = fish(w, p.x, p.y, [glyph(0, 0), glyph(0, 1)]), before = w.serialize();
  at(w, time); assert(!w.data.fishes[id]); assert(w.data.legends.deaths[id]); assert.equal(w.fishCells(id).length, 0); const burned = Object.values(w.data.chars).filter(c => c.path.some(p => p.reason === 'legendBurn'));
  assert(burned.length >= 2); w.merge(before); assert(!w.data.fishes[id]); assert(burned.every(c => w.data.chars[c.id].kind === 'burn'));
  const wall = new Map([[`${beam[0].x},${beam[0].y}`, {}]]); assert.equal(legendGeometry(w.data, e, time, wall).filter(c => c.role === 'beam').length, 0);
});
test('幽灵船整船每分钟1%掉落，分区跳过分钟不会改变船板身份，船结束不回收蛆', () => {
  let success = 0; for (let i = 0; i < 10000; i++) if (ghostRoll(`ship${i}`, 1, 1)) success++; assert(success > 60 && success < 150);
  let f, minute; do { f = fixture('ship'); minute = Array.from({ length: 60 }, (_, i) => i + 1).find(m => ghostRoll(f.s.seed, f.s.slot, m)); } while (!minute);
  const { w, s, e } = f; at(w, s.started + minute * 60000); assert.equal(e.drops.length, 1); const c = Object.values(w.data.chars).find(c => c.ghost); assert(c); assert(validGhostCell(c, w.data.roots)); assert.equal(c.ch, '蛆');
  const index = ghostIndex(s.seed, s.slot, minute, []); assert.equal(index, ghostIndex(s.seed, s.slot, minute, [{ minute: 1, index: 12 }]));
  at(w, s.ends + 1000); assert.equal(activeLegend(w.data, s.ends + 1000), null); assert(w.data.chars[c.id]); assert(validLegends(w.data.legends, sources(w)));
  const bad = clone(c); bad.ghost.index = 999; assert(!validGhostCell(bad, w.data.roots));
});
test('真正吃下船蛆才留下指定故事，食物按普通增长规则成为鱼身', () => {
  let f, minute; do { f = fixture('ship'); minute = Array.from({ length: 60 }, (_, i) => i + 1).find(m => ghostRoll(f.s.seed, f.s.slot, m)); } while (!minute);
  const { w, s } = f; at(w, started + minute * 60000); const food = Object.values(w.data.chars).find(c => c.ghost), id = fish(w, food.x - 1, 5); food.y = 4;
  w.step(w.data.tick + 500); assert.equal(food.entity, id); assert.equal(food.ch, '蛆'); assert(validGhostCell(food, w.data.roots)); const story = Object.values(w.data.life.stories).find(r => r.kind === 'shipMeal'); assert(story); assert.match(storyText(story, () => '鱼'), /吞下过幽灵船上生长的船蛆/);
});
test('缺来源、异常时间、重复捕获和伪造烧毁记录拒绝，合法分区合流顺序一致', () => {
  const { w, e, s } = fixture('ship'); assert(validLegends(w.data.legends, sources(w)));
  for (const mutate of [state => state.at = Infinity, state => state.events[s.id].slot = -1, state => state.events[s.id].minute = 99, state => state.through.unknown = 1, state => state.burns.fake = { seed: e.seed, slot: e.slot, at: started, reason: 'atomic', fish: 'fake' }]) { const state = clone(w.data.legends); mutate(state); assert(!validLegends(state, sources(w))); }
  const a = clone(w.data.legends), b = clone(a); b.at += 500; assert.deepEqual(mergeLegends(a, b, started), mergeLegends(b, a, started));
});

test('八个触须名额用完后不捕获第九条，已有鱼自然消失也不补抓', () => {
  const { w, s, e } = fixture('cthulhu');
  for (let arm = 0; arm < 8; arm++) { const id = fish(w, s.x + 30 + arm * 3, s.floor - 30), f = w.data.fishes[id]; e.arms[arm] = { fish: id, at: started + 21000, x: f.x, y: f.y, pose: { x: f.x, y: f.y, facing: 1 }, cells: w.fishCells(id).map(c => c.id) }; }
  const p = legendGeometry(w.data, e, started + 22000).find(c => c.role === 'arm'), ninth = fish(w, p.x, p.y); at(w, started + 22000);
  assert.equal(capturedFish(w.data, ninth, started + 22000), null); assert.equal(Object.keys(e.arms).length, 8);
  const first = e.arms[0].fish; delete w.data.fishes[first]; at(w, started + 23000); assert.equal(e.arms[0].fish, first); assert.equal(capturedFish(w.data, ninth, started + 23000), null);
});

test('跳过的离线船蛆分钟不补演；活动中和冷却期不生成第二个异象', () => {
  let f; do { f = fixture('ship'); } while (!ghostRoll(f.s.seed, f.s.slot, 1));
  f.w.data.legends.at = started; f.w.resolveLegends(started + 60000); assert.equal(f.e.drops.length, 0); assert.equal(f.e.minute, 1); f.w.resolveLegends(started + 60500); assert.equal(f.e.drops.length, 0);
  const c = fixture('cthulhu'); c.w.ambient = true;
  let slot = c.s.slot + 14, next; do { next = legendSchedule(c.w.data.roots, c.s.seed, slot++); } while (!next);
  // A recently merged sea supplies a real previous event ending at this slot.
  let seed, previous; do { seed = crypto.randomUUID(); previous = legendSchedule({ [seed]: born }, seed, next.slot - 1); } while (previous?.kind !== 'cthulhu');
  c.w.data.roots[seed] = born; c.w.data.legends.events[previous.id] = { seed, slot: previous.slot, at: previous.started, arms: {}, minute: 0, drops: [] };
  c.w.data.legends.at = next.started - 500; c.w.resolveLegends(next.started); assert.equal(Object.keys(c.w.data.legends.events).length, 2); assert(!c.w.data.legends.events[next.id]);
  slot = next.slot + 13; let ready; do { ready = legendSchedule(c.w.data.roots, c.s.seed, slot++); } while (!ready);
  c.w.data.legends.at = ready.started - 500; c.w.resolveLegends(ready.started); assert.equal(Object.keys(c.w.data.legends.events).length, 3);
});

test('不同海床合流后的自动安置会更新触须锚点，冻结不会把鱼塞回地下', () => {
  const { w, s, e } = fixture('cthulhu'), p = legendGeometry(w.data, e, started + 22000).find(c => c.role === 'arm' && c.arm === 0 && deltaX(c.x, s.x) < -6), id = fish(w, p.x, p.y); at(w, started + 22000); assert(capturedFish(w.data, id, started + 22000));
  let seed, ground; do { seed = crypto.randomUUID(); ground = makeTerrain(seed, born - 1000); } while (ground.depths[Math.floor(p.x)] > p.y);
  w.data.roots[seed] = born - 1000; w.data.terrain = ground; w.reconcileGeometry(started + 23000); w.step(started + 23500);
  assert(w.fishCells(id).every(c => { const at = cellPosition(w.data.fishes[id], c); return w.waterAt(at.x, at.y); }));
  assert(capturedFish(w.data, id, started + 23500).migratedAt); assert(validLegends(w.data.legends, sources(w)));
});
