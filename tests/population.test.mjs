import test from 'node:test';
import assert from 'node:assert/strict';
import { World, clone, cellPosition, key, chooseClaim } from '../www/engine.js';
import { POPULATION, updatePopulation, illnessOf, volcanoPlan, predatorCells, validPopulation, validRocks, mergePopulation, mergeRocks } from '../www/population.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { verifyReplica } from '../www/replica.js';
import { validateLife } from '../www/life.js';
import { WorkerSimulation } from '../www/simulation-worker.js';
import { SimulationClient } from '../www/simulation-client.js';
import { WorldBroadcast } from '../www/world-broadcast.js';
import { ARCHIVE_FIELDS, ArchiveStore, encodeArchive } from '../www/archive.js';

const HOUR = 3600000, now = Math.floor((Date.now() - 48 * HOUR) / HOUR) * HOUR, born = now - 3 * HOUR;
const glyph = (x, y, ch = '鱼') => ({ x, y, ch, color: '#88aacc' });
const transition = (cell, next, record) => { Object.assign(cell, next); cell.path.push({ ...record, target: next.entity || '', x: next.x, y: next.y }); };
function fish(w, x, y, cells = [glyph(0, 0, 'o'), glyph(1, 0)], created = born) {
  const id = crypto.randomUUID(); assert(w.apply({ id, actor: crypto.randomUUID(), nick: '生态测试', kind: 'fish', t: created, cells, cost: cells.length, gender: 'male', x, y }).ok); return id;
}
function world(count = 0) {
  const w = new World(born, crypto.randomUUID(), { populate: false }); w.data.tick = w.data.population.at = now;
  for (let i = 0; i < count; i++) fish(w, (i % 125) * 8, 10 + Math.floor(i / 125) * 6);
  w.data.population.illnessSlot = Math.floor(now / HOUR); w.data.population.volcanoSlot = Math.floor(now / POPULATION.volcanoPeriod); return w;
}
const advance = (w, t) => { updatePopulation(w, t, transition); w.data.tick = t; };
function erupt(w, at = now) {
  let slot = Math.floor(at / POPULATION.volcanoPeriod), plan;
  while (!(plan = volcanoPlan(w.data, slot))) slot++;
  const started = slot * POPULATION.volcanoPeriod;
  w.data.population.eruption = { ...plan, at: started, emitted: 0, nextAt: started + POPULATION.warning, particles: {} };
  w.data.population.at = w.data.tick = started; w.data.population.volcanoSlot = slot;
  return w.data.population.eruption;
}
function particle(w, e, index, x, y, at = e.at + POPULATION.warning) {
  const id = `${e.id}:${index}`; e.emitted = Math.max(e.emitted, index + 1);
  e.particles[id] = { id, x, y, born: at, rise: 0, drift: 0, cx: 0, cy: 0, settled: true }; return e.particles[id];
}

test('同一批鱼同时饥饿或补结算多小时疾病时共用鱼体索引', () => {
  const w = world(), body = [glyph(0, 0), glyph(1, 0), glyph(2, 0), glyph(3, 0), glyph(4, 0)];
  const hungry = fish(w, 50, 20, body), sick = fish(w, 70, 20, body);
  w.ambient = false;
  w.data.fishes[hungry].hungerAt = now;
  w.data.population.illnesses[sick] = { at: now - 2 * HOUR, nextLossAt: now - HOUR, curedAt: 0 };
  w.fishCells = () => assert.fail('批量结算应按鱼编号获取鱼体，逐条重扫了整片海');
  w.step(now + 500);
  const groups = w.fishGroups();
  assert.equal(groups.get(sick).length, 3);
  assert(groups.get(hungry).length >= 2 && groups.get(hungry).length < body.length);
  const losses = Object.values(w.data.chars).flatMap(cell => cell.path).filter(event => event.reason === 'ecoDissolve');
  assert.deepEqual(losses.map(event => event.t).sort((a, b) => a - b), [now - HOUR, now]);
});

test('低于阈值不患病；500条每小时最多20%，不重复抽签且保护新鱼', () => {
  const low = world(299); advance(low, now + HOUR); assert.equal(Object.keys(low.data.population.illnesses).length, 0);
  const w = world(500); advance(w, now + HOUR); assert.equal(Object.keys(w.data.population.illnesses).length, 100);
  const saved = clone(w.data.population.illnesses); advance(w, now + HOUR + 500);
  assert.deepEqual(w.data.population.illnesses, saved);
  advance(w, now + 2 * HOUR); assert.equal(Object.keys(w.data.fishes).length, 400); assert.equal(Object.keys(w.data.population.illnesses).length, 80);
  const fresh = world(300); for (const f of Object.values(fresh.data.fishes)) f.created = now;
  advance(fresh, now + HOUR); assert.equal(Object.keys(fresh.data.population.illnesses).length, 0);
});
test('只有真正吃下乐才康复；普通鱼食不治病，24小时免疫，保留60分钟进食限制', () => {
  const w = world(), id = fish(w, 20, 12), f = w.data.fishes[id];
  w.ambient = false; w.data.population.illnesses[id] = { at: now, nextLossAt: now + POPULATION.dissolveEvery, curedAt: 0 };
  const feed = (ch, at = now) => { const positions = w.fishCells(id).map(c => cellPosition(f, c)).sort((a, b) => a.y - b.y), p = positions[0]; const op = { id: crypto.randomUUID(), actor: crypto.randomUUID(), kind: 'food', ch, color: '#88aacc', t: at, cost: 1, x: p.x, y: 0 }; assert(w.apply(op).ok); const c = w.data.chars[op.id]; c.y = p.y - 1; return c; };
  feed('爱'); w.step(now + 500); assert(illnessOf(w.data, id));
  const cure = feed('乐'); w.step(now + 1000); assert.equal(cure.kind, 'food'); assert(illnessOf(w.data, id));
  w.step(now + HOUR + 500); const fresh = feed('乐', now + HOUR + 500); w.step(now + HOUR + 1000); assert.equal(fresh.entity, id); assert.equal(illnessOf(w.data, id), null);
  assert.equal(w.data.population.illnesses[id].curedAt, now + HOUR + 1000);
  assert.equal(f.lastMealAt, now + HOUR + 1000); assert(Object.values(w.data.life.stories).some(s => s.kind === 'recovered'));
  assert(validateLife(w.data.life, w.data));
});
test('两字鱼患病一小时后沿用正常死亡；休眠恢复和旧快照不会复活或退款', () => {
  const w = world(), id = fish(w, 20, 12); w.data.population.illnesses[id] = { at: now, nextLossAt: now + POPULATION.dissolveEvery, curedAt: 0 };
  const before = w.serialize(), owner = w.data.fishes[id].actor, balance = w.wallet(owner);
  advance(w, now + POPULATION.dissolveEvery - 1); assert(w.data.fishes[id]);
  advance(w, now + POPULATION.dissolveEvery); assert(!w.data.fishes[id]); assert.equal(w.wallet(owner), balance);
  assert(Object.values(w.data.chars).every(c => c.kind === 'burn' && c.path.at(-1).reason === 'ecoDissolve'));
  w.merge(before); w.merge(before); assert(!w.data.fishes[id]);
  const restored = restoreCheckpoint({ world: before, lastOnlineAt: now }, now + 9 * HOUR).world;
  assert(!restored.data.fishes[id]); assert.equal(Object.keys(restored.data.population.illnesses).length, 0);
});
test('500条无人医治运行48小时后降到阈值以下，生态实体和鱼生记录始终有界', () => {
  const w = world(500);
  for (let hour = 1; hour <= 48; hour++) advance(w, now + hour * HOUR);
  assert(Object.keys(w.data.fishes).length < 300); assert(Object.keys(w.data.fishes).length >= 200);
  assert(Object.keys(w.data.population.predators).length <= 4);
  assert(Object.keys(w.data.population.illnesses).length <= 100); assert(Object.keys(w.data.life.stories).length <= 512);
  assert(Object.keys(w.data.rocks).length <= 2000); assert(validPopulation(w.data.population, w.data));
});
test('食肉鱼真实嘴部接触才捕食，30分钟个体冷却和10分钟全海冷却，无跨墙或幼鱼捕食', () => {
  const w = world(201), id = fish(w, 501, 70), p = { id: '0', x: 500, y: 70, facing: 1, created: born, lastBite: 0, cx: 0, cy: 0 };
  w.data.population.predators['0'] = p; advance(w, now + 500); assert(!w.data.fishes[id]); assert.equal(p.lastBite, now + 500);
  const next = fish(w, 501, 70); advance(w, now + 1000); assert(w.data.fishes[next]);
  p.x = 500; p.y = 70; p.lastBite = 0; w.data.population.huntAt = now; advance(w, now + 2000); assert(w.data.fishes[next]);
  const young = fish(w, 501, 65, undefined, now); p.x = 500; p.y = 65; p.lastBite = 0; w.data.population.huntAt = 0; advance(w, now + 2500); assert(w.data.fishes[young]);
  const blocked = fish(w, 502, 60); p.x = 500; p.y = 60;
  assert(w.apply({ id: crypto.randomUUID(), actor: crypto.randomUUID(), kind: 'scene', t: born, cells: [glyph(0, 0, '墙'), glyph(0, 1, '墙')], cost: 2, x: 501, y: 60 }).ok);
  advance(w, now + 3000); assert(w.data.fishes[blocked]); assert.equal(p.x, 500);
  assert(predatorCells(p).every(c => !w.fishMap().has(key(c.x, c.y))));
});
test('火山预警、发射上升、回落与32字上限；间隔至少6小时，离线不补喷', () => {
  const w = world(), e = erupt(w), start = e.at;
  advance(w, start + POPULATION.warning - 500); assert.equal(e.emitted, 0);
  advance(w, start + POPULATION.warning); assert.equal(e.emitted, 1);
  const c = Object.values(e.particles)[0], initialY = c.y;
  for (let i = 1; i <= 4; i++) advance(w, start + POPULATION.warning + i * 500);
  assert(c.y < initialY);
  for (let i = 5; i <= 250; i++) advance(w, start + POPULATION.warning + i * 500);
  assert.equal(e.emitted, 32); assert(Object.keys(e.particles).length <= 32); assert(Object.values(e.particles).some(p => p.settled));
  const saved = w.serialize(), restored = restoreCheckpoint({ world: saved, lastOnlineAt: saved.tick }, saved.tick + HOUR).world;
  assert.equal(restored.data.population.eruption.emitted, 32); assert.equal(Object.keys(restored.data.population.eruption.particles).length, 0);
  for (let t = start + POPULATION.volcanoPeriod; t < start + POPULATION.volcanoCooldown; t += POPULATION.volcanoPeriod) advance(w, t);
  assert.equal(w.data.population.eruption.id, e.id);
});
test('红色浆真实碰鱼致死；正好10分钟冷却不再伤鱼，岩石堆叠且挡住鱼与食物', () => {
  const w = world(), e = erupt(w), bornAt = e.at + POPULATION.warning, y = w.floorAt(e.x) - 1;
  const target = fish(w, e.x, y - 3), c = particle(w, e, 0, e.x, y - 3, bornAt);
  advance(w, bornAt + 500); assert(!w.data.fishes[target]);
  c.y = y; advance(w, bornAt + POPULATION.cooling - 1); assert.equal(Object.keys(w.data.rocks).length, 0);
  advance(w, bornAt + POPULATION.cooling); const rock = w.data.rocks[c.id]; assert(rock); assert.equal(rock.y, y); assert(w.sceneryMap().has(key(e.x, y)));
  const second = particle(w, e, 1, e.x, y - 1, bornAt + 2000); advance(w, bornAt + 2000 + POPULATION.cooling); assert.equal(w.data.rocks[second.id].y, y - 1);
  const f = { id: 'preview', x: e.x, y: y - 1, facing: 1 }; assert.equal(w.canOccupy(f, [glyph(0, 0)]), false);
  const coldFish = fish(w, e.x + 5, y - 4), cold = particle(w, e, 2, e.x + 5, y - 4, bornAt + 4000);
  advance(w, cold.born + POPULATION.cooling); assert(w.data.fishes[coldFish]);
  assert(validRocks(w.data.rocks, w.data));
});
test('岩石和康复合流顺序一致，旧快照不重新加热或重复沉积', () => {
  const w = world(), e = erupt(w), bornAt = e.at + POPULATION.warning, c = particle(w, e, 0, e.x, w.floorAt(e.x) - 1, bornAt), hot = w.serialize();
  advance(w, bornAt + POPULATION.cooling); w.merge(hot); w.merge(hot); assert.equal(Object.keys(w.data.rocks).length, 1); assert(!w.data.population.eruption.particles[c.id]);
  const a = clone(w.data.population), b = clone(a), id = fish(w, 20, 20); a.illnesses[id] = { at: now, nextLossAt: now + POPULATION.dissolveEvery, curedAt: 0 }; b.illnesses[id] = { ...a.illnesses[id], curedAt: now + HOUR };
  assert.deepEqual(mergePopulation(a, b, now), mergePopulation(b, a, now)); assert.equal(mergePopulation(a, b, now).illnesses[id].curedAt, now + HOUR);
  assert.deepEqual(mergeRocks(w.data.rocks, {}), mergeRocks({}, w.data.rocks));
});
test('多人副本接受合法疾病与岩石，拒绝伪造起源、无限数量与异常时间', async () => {
  const w = world(300); advance(w, now + HOUR);
  await verifyReplica(w.serialize(), {}, undefined, { current: w.serialize() });
  assert(validPopulation(w.data.population, w.data));
  for (const mutate of [s => s.at = Infinity, s => s.illnessSlot = -1, s => s.huntAt = Infinity, s => s.illnesses.fake = { at: now, nextLossAt: now + POPULATION.dissolveEvery, curedAt: 0 }, s => Object.values(s.illnesses)[0].nextLossAt++]) { const s = clone(w.data.population); mutate(s); assert(!validPopulation(s, w.data)); }
  const e = erupt(w), c = particle(w, e, 0, e.x, w.floorAt(e.x) - 1); advance(w, c.born + POPULATION.cooling);
  await verifyReplica(w.serialize(), {}, undefined, { current: w.serialize() });
  const rocks = clone(w.data.rocks); Object.values(rocks)[0].seed = crypto.randomUUID(); assert(!validRocks(rocks, w.data));
});
test('后台线程同步疾病；正常多人广播只发送新增的岩石行', async () => {
  const a = world(300), b = new World(now, undefined, { populate: false }); b.data = a.serialize();
  a.data.population.illnessSlot = b.data.population.illnessSlot = Math.floor(now / HOUR) - 1;
  const simulation = new WorkerSimulation();
  const client = new SimulationClient(() => ({ terminate() {}, postMessage(message) { setImmediate(() => { try { this.onmessage({ data: { result: structuredClone(simulation.receive(structuredClone(message))) } }); } catch (e) { this.onmessage({ data: { error: e.message } }); } }); } }));
  try { a.step(now + 500); await client.advance(b, now + 500); assert.deepEqual(b.serialize(), a.serialize()); } finally { client.close(); }
  const channel = new WorldBroadcast(), network = { live: () => [1], broadcast: (kind, body) => body };
  const full = await channel.send(network, a.data, a.data.tick); assert(full.world.population);
  const e = erupt(a), c = particle(a, e, 0, e.x, a.floorAt(e.x) - 1); advance(a, c.born + POPULATION.cooling);
  const first = await channel.send(network, a.data, full.world.tick + 1000); assert.equal(Object.keys(first.world.rocks).length, 1);
  const second = await channel.send(network, a.data, full.world.tick + 2000); assert.equal(Object.keys(second.world.rocks).length, 0); assert(second.world.population);
});
test('生态死亡的已吃入鱼食归档后，仍能找到那条鱼的来源凭据', async () => {
  const w = world(), id = fish(w, 20, 12); w.ambient = false;
  const op = { id: crypto.randomUUID(), actor: crypto.randomUUID(), kind: 'food', ch: '乐', color: '#88aacc', t: now, cost: 1, x: 20, y: 0 };
  assert(w.apply(op).ok); w.data.chars[op.id].y = 11; w.step(now + 500); assert.equal(w.data.chars[op.id].entity, id);
  w.data.population.illnesses[id] = { at: now + 1000, nextLossAt: now + 1000 + POPULATION.dissolveEvery, curedAt: 0 };
  advance(w, now + 1000 + 2 * POPULATION.dissolveEvery);
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])); records.ops[id] = w.data.ops[id]; records.ops[op.id] = w.data.ops[op.id];
  const store = new ArchiveStore(); await store.ingest(await encodeArchive(records, w.data.roots), chooseClaim);
  const incoming = { protocol: 1, roots: w.data.roots, chars: { [op.id]: w.data.chars[op.id] }, fishes: {}, scenes: {}, ops: {}, breeding: {}, travel: {} };
  const extra = await store.dependencies(incoming, {}); assert(extra.ops[id]); assert(extra.ops[op.id]);
  await verifyReplica(incoming, extra, undefined, { current: { ops: extra.ops } });
});
test('患病每小时只消散一字，保持连通；重复推进、刷新与旧快照不重复扣字', () => {
  const w = world(), id = fish(w, 20, 12, Array.from({ length: 6 }, (_, x) => glyph(x, 0, x ? '鱼' : 'o')));
  w.ambient = false; w.data.population.illnesses[id] = { at: now, nextLossAt: now + HOUR, curedAt: 0 };
  const before = w.serialize(), hunger = w.data.fishes[id].hungerAt;
  advance(w, now + HOUR - 1); assert.equal(w.fishCells(id).length, 6);
  for (let hour = 1; hour <= 4; hour++) {
    advance(w, now + hour * HOUR); assert.equal(w.fishCells(id).length, 6 - hour);
    advance(w, now + hour * HOUR); assert.equal(w.fishCells(id).length, 6 - hour);
    assert.equal(w.data.fishes[id].hungerAt, hunger); assert.equal(Object.values(w.data.chars).filter(c => c.kind === 'food').length, 0);
  }
  const restored = restoreCheckpoint({ world: w.serialize(), lastOnlineAt: w.data.tick }, w.data.tick + 500).world;
  assert.equal(restored.fishCells(id).length, 2); restored.merge(before); assert.equal(restored.fishCells(id).length, 2);
  advance(w, now + 5 * HOUR); assert(!w.data.fishes[id]);
  assert(Object.values(w.data.chars).every(c => c.kind === 'burn'));
  const end = Object.values(w.data.life.stories).find(s => s.kind === 'depart' && s.fish === id); assert(end); assert.equal(end.cause, undefined);
});
test('患病超过八小时仍能实际吃乐康复，康复后停止消散并保留二十四小时免疫', async () => {
  const w = world(), id = fish(w, 20, 12, Array.from({ length: 15 }, (_, x) => glyph(x, 0, x ? '鱼' : 'o')));
  w.ambient = false; w.data.population.illnesses[id] = { at: now, nextLossAt: now + HOUR, curedAt: 0 };
  advance(w, now + 8 * HOUR); assert.equal(w.fishCells(id).length, 7);
  const p = cellPosition(w.data.fishes[id], w.fishCells(id)[0]), op = { id: crypto.randomUUID(), actor: crypto.randomUUID(), kind: 'food', ch: '乐', color: '#88aacc', t: now + 8 * HOUR, cost: 1, x: p.x, y: 0 };
  assert(w.apply(op).ok); w.data.chars[op.id].y = p.y - 1; w.step(now + 8 * HOUR + 500);
  assert.equal(w.data.chars[op.id].entity, id); assert.equal(illnessOf(w.data, id), null);
  assert.equal(w.fishCells(id).length, 8); advance(w, now + 10 * HOUR); assert.equal(w.fishCells(id).length, 8);
  assert(validPopulation(w.data.population, w.data)); await verifyReplica(w.serialize(), {}, undefined, { current: w.serialize() });
});
