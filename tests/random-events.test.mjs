import test from 'node:test';
import assert from 'node:assert/strict';
import { World, clone } from '../www/engine.js';
import { EVENTS, EVENT_KINDS, eventSchedule, eventPosition, activeEvent, planEvent, updateEvents, validEvent, eventMotion, eventLetter, radioLines, radioTranscript } from '../www/random-events.js';
import { eventGlyphs } from '../www/random-event-visuals.js';
import { lifeContext, recordStory, pairKey, mergeLife, validateLife, storyText, idleMotion } from '../www/life.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { archiveDependencies } from '../www/archive.js';
import { updateContacts } from '../www/breeding.js';

const t = Math.floor((Date.now() - 24 * 3600000) / EVENTS.period) * EVENTS.period;
function make() { return new World(t, crypto.randomUUID(), { populate: false }); }
const cells = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: '鱼', color: '#88aacc' }];
function populated(w) {
  const at = w.data.tick, fishes = [];
  for (let i = 0; i < 4; i++) { const id = crypto.randomUUID(); assert(w.apply({ id, kind: 'fish', actor: `author-${i}`, nick: '鱼', t: at, x: 370 + i * 3, y: 24, cells, cost: 2, gender: 'male' }).ok); fishes.push(id); }
  for (const a of fishes) for (const b of fishes) if (a < b) w.data.life.bonds[pairKey(a, b)] = { a, b, seconds: 50, run: 0, at, lastNear: at };
  for (let i = 0; i < 5; i++) w.data.chars[`grass-${i}`] = { id: `grass-${i}`, kind: 'seaweed', x: 373 + i, y: 28, created: at - 3600000, wild: { source: 'floor:373' }, path: [], ch: '草', color: '#88aa88' };
  return fishes;
}
function schedule(w, kind, rare) { let slot = Math.floor(w.data.tick / EVENTS.period) + 1, found; do { found = eventSchedule(w.data.roots, w.id, slot++); } while (!found || found.kind !== kind || rare !== undefined && found.rare !== rare); return found; }
const context = (w, at) => lifeContext(w, at, w.sceneryMap(), w.fishGroups());
function startEvent(w, kind) { const s = schedule(w, kind); w.data.tick = s.started; updateEvents(w, s.started, context(w, s.started), true, recordStory); return activeEvent(w.data, s.started); }
const sources = w => ({ roots: w.data.roots, ops: w.data.ops, breeding: w.data.breeding, chars: w.data.chars });

test('整片海稳定抽签，八类与稀有变体均可出现，事件间有安静间隔', () => {
  const roots = { sea: 0 }, counts = new Map(), rare = new Set(); let occurred = 0;
  for (let slot = 0; slot < 10000; slot++) {
    const s = eventSchedule(roots, 'sea', slot); assert.deepEqual(eventSchedule(clone(roots), 'sea', slot), s); if (!s) continue;
    occurred++; counts.set(s.kind, (counts.get(s.kind) || 0) + 1); if (s.rare) rare.add(s.kind); assert(s.duration <= 60000 && EVENTS.period - s.duration >= 300000);
  }
  assert.deepEqual(new Set(counts.keys()), new Set(EVENT_KINDS)); assert.deepEqual(rare, new Set(EVENT_KINDS)); assert(occurred > 4000 && occurred < 5000);
  assert.equal(eventSchedule(roots, 'unknown', 1), null); assert.equal(eventSchedule(roots, '__proto__', 1), null); assert.equal(eventSchedule(roots, 'sea', -1), null);
});

test('所有事件有对应画面；字符、碰撞、余额与食物数量不因视觉事件增加', () => {
  for (const kind of EVENT_KINDS) {
    const w = make(); populated(w); const before = { counts: w.counts(), chars: Object.keys(w.data.chars), wallet: w.wallet('author-0') };
    const s = schedule(w, kind), event = planEvent(w, s, s.started, context(w, s.started)); assert(event, kind); assert(validEvent(event, w.data.roots, id => !!w.data.fishes[id], s.started, w.data.chars));
    const full = { ...event, ...s }; assert(eventGlyphs(w.data, full, s.started + 4000).length > 0, kind);
    assert.equal(eventGlyphs(w.data, full, s.started - 1).length, 0); assert.equal(eventGlyphs(w.data, full, s.started + s.duration).length, 0);
    assert.deepEqual({ counts: w.counts(), chars: Object.keys(w.data.chars), wallet: w.wallet('author-0') }, before);
  }
});

test('实际开场只抽一次，刷新、重复快照与协调者接替不重抽、不复制故事', () => {
  const w = make(); populated(w); const event = startEvent(w, 'meeting'); assert(event);
  const s = eventSchedule(w.data.roots, event.seed, event.slot); w.data.life.at = s.started;
  const saved = w.serialize(); updateEvents(w, s.started + 500, context(w, s.started + 500), true, recordStory);
  const restored = restoreCheckpoint({ world: saved, lastOnlineAt: saved.tick }, s.started + 1000).world;
  assert.equal(activeEvent(restored.data, s.started + 1000).id, event.id); restored.merge(saved); restored.merge(saved);
  assert.equal(Object.keys(restored.data.life.events).length, 1); assert.equal(Object.values(restored.data.life.stories).filter(s => s.kind === 'ambient').length, event.fishes.length);
  assert(validateLife(restored.data.life, sources(restored), s.started + 2000));
  assert.deepEqual(mergeLife(saved.life, restored.data.life, restored.data), mergeLife(restored.data.life, saved.life, restored.data));
  assert.match(storyText(Object.values(w.data.life.stories).find(s => s.kind === 'ambient'), () => '鱼'), /临时会议/);
  const expired = s.started + s.duration + 1000; assert.equal(activeEvent(restored.data, expired), null); restored.merge(saved); assert.equal(activeEvent(restored.data, expired), null);
});

test('全员离线与中途重开不补事件；没有熟鱼或成熟海草的时段保持安静', () => {
  const w = make(), s = schedule(w, 'bottle');
  updateEvents(w, s.started, context(w, s.started), false, recordStory); assert.equal(Object.keys(w.data.life.events).length, 0);
  updateEvents(w, s.started + 1000, context(w, s.started + 1000), true, recordStory); assert.equal(Object.keys(w.data.life.events).length, 0);
  const late = make(), ls = schedule(late, 'bottle'); updateEvents(late, ls.started + EVENTS.opening, context(late, ls.started + EVENTS.opening), true, recordStory); assert.equal(Object.keys(late.data.life.events).length, 0);
  const quiet = make(); for (const kind of ['meeting', 'parade', 'hiccup', 'blossom']) { const e = schedule(quiet, kind); assert.equal(planEvent(quiet, e, e.started, context(quiet, e.started)), null); }
  populated(quiet); for (const c of Object.values(quiet.data.chars)) if (c.kind === 'seaweed') c.created = schedule(quiet, 'blossom').started; const blossom = schedule(quiet, 'blossom'); assert.equal(planEvent(quiet, blossom, blossom.started, context(quiet, blossom.started)), null);
});

test('会议短暂停留，游行尝试同步转向；分散、饥饿、繁殖和食物仍按生态规则处理', () => {
  const w = make(), fishes = populated(w), meeting = startEvent(w, 'meeting'); assert(meeting);
  assert.deepEqual(eventMotion(fishes[0], meeting.started + 1000, context(w, meeting.started + 1000)), { dx: 0, dy: 0 });
  w.data.fishes[fishes[1]].x = 700; assert.equal(eventMotion(fishes[0], meeting.started + 1000, context(w, meeting.started + 1000)), null); w.data.fishes[fishes[1]].x = 373;
  const parade = startEvent(w, 'parade'); assert(parade);
  assert.equal(eventMotion(fishes[0], parade.started + 1000, context(w, parade.started + 1000)).dx, parade.direction);
  assert.equal(eventMotion(fishes[0], parade.started + 7000, context(w, parade.started + 7000)).dx, -parade.direction);
  assert.equal(eventMotion(fishes[0], parade.started + 13000, context(w, parade.started + 13000)), null);
  w.data.fishes[fishes[0]].lastFed = parade.started - 86400000;
  const hungryMotion = idleMotion(w, w.data.fishes[fishes[0]], parade.started + 1000, context(w, parade.started + 1000)), remembered = w.data.life.events;
  w.data.life.events = {}; assert.deepEqual(idleMotion(w, w.data.fishes[fishes[0]], parade.started + 1000, context(w, parade.started + 1000)), hungryMotion); w.data.life.events = remembered;
  const mealWorld = make(); populated(mealWorld); const event = startEvent(mealWorld, 'meeting');
  const food = crypto.randomUUID(); assert(mealWorld.apply({ id: food, actor: 'feed', t: event.started, kind: 'food', ch: '食', color: '#ffffff', x: 371, y: 0, cost: 1 }).ok); mealWorld.data.chars[food].y = 23;
  mealWorld.step(event.started + 500); const winner = mealWorld.data.chars[food].entity;
  assert.equal(mealWorld.data.chars[food].kind, 'fish'); assert(event.fishes.includes(winner)); assert.equal(mealWorld.fishStatus(winner, event.started + 500).meals24, 1);
});

test('漂流瓶与流星支持环形接缝，稀有来信与电台文字稳定', () => {
  const w = make(), normal = schedule(w, 'bottle', false), rare = schedule(w, 'bottle', true), rareRadio = schedule(w, 'radio', true);
  assert.deepEqual(eventLetter(rare), { text: '？', author: '全文完' }); assert(eventLetter(normal).text.length > 5); assert.equal(eventLetter(clone(normal)).text, eventLetter(normal).text);
  assert.match(radioLines(rareRadio).at(-1), /吃草/);
  assert.equal(radioTranscript(rareRadio, rareRadio.started - 1).length, 0); assert.equal(radioTranscript(rareRadio, rareRadio.started + 8000).length, 2); assert.equal(radioTranscript(rareRadio, rareRadio.started + 22000).length, 4);
  const p = eventPosition({ ...normal, x: 999, y: 5, direction: 1 }, normal.started + 10000); assert(p.x >= 0 && p.x < 10);
  const star = schedule(w, 'meteor'); const trail = eventGlyphs(w.data, { ...star, x: 999, y: 2 }, star.started + 8000); assert(trail.every(g => g.x >= 0 && g.x < 1000));
});

test('完整模拟在开场连续运行时生成事件，重复结算不补抽，分散鱼不组成会议', () => {
  const w = new World(Date.UTC(2025, 0, 1), 'ambient-opening', { populate: false }); populated(w); const s = schedule(w, 'bottle');
  w.data.tick = w.data.life.at = s.started - 1500; w.data.seaweedHour = Math.floor(s.started / 3600000); w.data.bubbleMinute = Math.floor(s.started / 60000);
  for (let offset = -1000; offset <= 1500; offset += 500) w.step(s.started + offset);
  assert.equal(activeEvent(w.data, s.started + 1500)?.id, s.id); const count = Object.keys(w.data.life.events).length;
  w.step(s.started + 1500); assert.equal(Object.keys(w.data.life.events).length, count);
  const dispersed = make(), fish = populated(dispersed); fish.forEach((id, i) => dispersed.data.fishes[id].x = 20 + i * 5); const meeting = schedule(dispersed, 'meeting'), c = context(dispersed, meeting.started), plan = planEvent(dispersed, meeting, meeting.started, c);
  assert.equal(plan.fishes.length, 3); for (const id of plan.fishes) for (const other of plan.fishes) if (id !== other) assert(c.neighbors.get(id).some(q => q.id === other));
});

test('正在繁殖的双亲不被随机会议或游行打断', () => {
  const w = make(), fishes = populated(w);
  w.data.ops[fishes[1]].gender = 'female'; w.data.fishes[fishes[1]].x = 372;
  for (let ms = 0; ms <= 5000; ms += 500) updateContacts(w, t + ms, w.fishGroups(), w.sceneryMap());
  assert(w.breedingState(fishes[0])); assert(w.breedingState(fishes[1]));
  for (const kind of ['meeting', 'parade']) { const s = schedule(w, kind); assert.equal(planEvent(w, s, s.started, context(w, s.started)), null); }
});

test('坏时间、类型、坐标、参与鱼和海草来源被拒绝，历史事件及出处有上限', () => {
  const w = make(); populated(w); const event = startEvent(w, 'hiccup'); assert(event);
  const raw = w.data.life.events[event.id];
  for (const mutate of [e => e.kind = 'food', e => e.at += EVENTS.opening, e => e.x = -1, e => e.y = Infinity, e => e.seed = 'unknown', e => e.fishes = ['forged'], e => e.plants = ['unknown']]) {
    const bad = clone(raw); mutate(bad); assert(!validEvent(bad, w.data.roots, id => !!w.data.fishes[id], event.at, w.data.chars));
    const life = clone(w.data.life); life.events[event.id] = bad; assert(!validateLife(life, sources(w), event.at));
  }
  const bad = clone(w.data.life); bad.events[event.id] = null; assert(!validateLife(bad, sources(w), event.at));
  const dependencies = archiveDependencies(w.data); for (const id of event.plants) assert(dependencies.chars.has(id));
  for (let i = 1; i < 50; i++) { const s = eventSchedule(w.data.roots, w.id, event.slot + i); if (s) { w.data.life.events[s.id] = { ...raw, id: s.id, slot: s.slot, kind: s.kind, at: s.started }; } }
  updateEvents(w, (event.slot + 60) * EVENTS.period, context(w, (event.slot + 60) * EVENTS.period), false, recordStory); assert(Object.keys(w.data.life.events).length <= EVENTS.limit);
});

test('旧版鱼生存档兼容，世界湮灭不继承旧随机事件', () => {
  const w = make(); populated(w); const event = startEvent(w, 'bottle'); assert(event); const saved = w.serialize(), legacy = clone(saved); delete legacy.life.events; delete legacy.life.eventThrough;
  assert(validateLife(legacy.life, sources(w), event.at)); const restored = restoreCheckpoint({ world: legacy, lastOnlineAt: event.at }, event.at + 1000).world; updateEvents(restored, event.at + 1000, context(restored, event.at + 1000), false, recordStory); assert.equal(activeEvent(restored.data, event.at + 1000), null);
  const expired = restoreCheckpoint({ world: saved, lastOnlineAt: event.at }, event.at + 240 * 3600000).world; assert.equal(Object.keys(expired.data.life.events).length, 0);
});
