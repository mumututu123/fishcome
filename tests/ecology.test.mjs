import test from 'node:test';
import assert from 'node:assert/strict';
import { World, hash, clone } from '../www/engine.js';
import { updateContacts, finishBreeding } from '../www/breeding.js';
import { ECOLOGY, newEcology, densityField, contactTime, growthChance, weedExpires, weedAlpha, updateEcology, looseWither, mergeEcology, validEcology } from '../www/ecology.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const HOUR = 3600000, now = Date.now(), cell = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
const transition = (c, next, event) => { Object.assign(c, next); c.path.push({ ...event, target: next.entity || '', x: next.x, y: next.y }); };
function sea() { const w = new World(now - 10 * 86400000, undefined, { populate: false }); w.data.tick = now; w.data.ecology = newEcology(now); w.data.seaweedHour = Math.floor(now / HOUR); w.data.bubbleMinute = Math.floor(now / 60000); return w; }
function fish(w, gender, x) { const id = crypto.randomUUID(); assert(w.apply({ id, actor: gender, nick: gender, t: now, kind: 'fish', cost: 3, x, y: 20, gender, cells: [cell(0, 0), cell(1, 0), cell(2, 0)] }).ok); return id; }
function fill(w, cx, cy, count) {
  const occupied = w.fishMap(), id = `fixture:${crypto.randomUUID()}`; w.data.scenes[id] = { id, x: 0, y: 0, posAt: now, poseId: id }; let n = 0;
  for (let dy = -15; dy <= 15 && n < count; dy++) for (let dx = -15; dx <= 15 && n < count; dx++) { const x = (cx + dx + 1000) % 1000, y = cy + dy; if (!w.waterAt(x, y) || occupied.has(`${x},${y}`)) continue; const key = `${id}:${n++}`; w.data.chars[key] = { id: key, x, y, ch: '#', color: '#88aacc', kind: 'scene', entity: id, created: now, path: [] }; }
}
function grass(w, id, index, created, plant = id) { const c = { id, kind: 'seaweed', entity: plant, x: 30, y: w.floorAt(30) - 1 - index, ch: '草', color: '#48aa5d', payer: '', created, path: [], wild: { index, source: 'floor:30', plant, hour: Math.floor(created / HOUR), x: 30, y: w.floorAt(30) - 1 - index } }; w.data.chars[id] = c; return c; }
function sediment(w, id, settled, x = 50) { const c = { id, payer: 'maker', kind: 'scene', entity: id, ch: '食', color: '#ffffff', x: 0, y: 0, created: settled - 300000, path: [{ id: `settle:${id}`, t: settled, reason: 'expire', target: id, x: 0, y: 0 }] }; w.data.chars[id] = c; w.data.scenes[id] = { id, x, y: 20, posAt: settled, poseId: id }; return c; }

test('密度只计实际水域和唯一占格，接缝与海面分母正确', () => {
  const w = sea(); fill(w, 998, 20, 100); assert.equal(densityField(w)(998, 20), 100 / 961); assert.equal(densityField(w)(-2, 20), 100 / 961);
  const top = sea(); fill(top, 20, 0, 100); assert.equal(densityField(top)(20, 0), 100 / (31 * 16));
  const duplicate = Object.values(top.data.chars)[0]; top.data.chars.copy = { ...duplicate, id: 'copy' }; assert.equal(densityField(top)(20, 0), 100 / (31 * 16));
});
test('20%延长配对至20秒，40%暂停并清空计时，稀疏区仍为5秒', () => {
  for (const [occupied, seconds] of [[0, 5], [200, 20], [400, Infinity]]) {
    const w = sea(), male = fish(w, 'male', 20); fish(w, 'female', 23); fill(w, 22, 20, occupied);
    const d = densityField(w)(22, 20); assert.equal(contactTime(d), Number.isFinite(seconds) ? seconds * 1000 : Infinity);
    for (let elapsed = 0; elapsed <= 19500; elapsed += 500) updateContacts(w, now + elapsed, w.fishGroups(), w.sceneryMap());
    if (seconds === 5) assert(w.breedingState(male)); else assert(!w.breedingState(male));
    if (seconds === 20) { updateContacts(w, now + 20000, w.fishGroups(), w.sceneryMap()); assert(w.breedingState(male)); }
    if (seconds === Infinity) { assert.equal(Object.keys(w.data.contacts).length, 0); for (const [id, c] of Object.entries(w.data.chars)) if (c.kind === 'scene') delete w.data.chars[id]; updateContacts(w, now + 20000, w.fishGroups(), w.sceneryMap()); assert(!w.breedingState(male)); }
  }
});
test('繁殖密度按公鱼编号和母鱼本地化编号取接触点，兼容旧存档小数坐标', () => {
  for (const left of [19, 19.5]) {
    const w = sea(), male = fish(w, 'male', 20), female = fish(w, 'female', 23);
    const [m1, m2, m3] = w.fishCells(male), [f1, f2, f3] = w.fishCells(female);
    Object.assign(m1, { x: 4, id: 'a-male' });
    Object.assign(m2, { x: 0, id: 'Z-male' });
    Object.assign(m3, { x: 8, id: 'spare-male' });
    Object.assign(f1, { x: -2, id: 'Z-female' });
    Object.assign(f2, { x: left - 23, id: 'a-female' });
    Object.assign(f3, { x: 2, id: 'extra-female' });
    fill(w, 20, 20, 189);
    const density = densityField(w);
    assert.equal(contactTime(density(20, 20)), 20000);
    assert.equal(contactTime(density(21, 20)), 5000);
    assert.equal(contactTime(density(25, 20)), 5000);

    const groups = w.fishGroups(), scenery = w.sceneryMap();
    for (let elapsed = 0; elapsed < 20000; elapsed += 500) {
      updateContacts(w, now + elapsed, groups, scenery);
      assert.equal(w.breedingState(male), undefined);
    }
    updateContacts(w, now + 20000, groups, scenery);
    assert.deepEqual(w.breedingState(male)?.contact, {
      male: ['Z-male', 'a-male'],
      female: left === 19 ? ['Z-female', 'a-female', 'extra-female'] : ['Z-female', 'extra-female']
    });
  }
});
test('已经开始的繁殖不因后来的拥挤被取消，出生不增加鱼元', () => {
  const w = sea(), male = fish(w, 'male', 20); fish(w, 'female', 23); for (let e = 0; e <= 5000; e += 500) updateContacts(w, now + e, w.fishGroups(), w.sceneryMap()); const r = w.breedingState(male); fill(w, 22, 20, 400); const count = Object.keys(w.data.chars).length;
  finishBreeding(w, r.ends, transition); assert.equal(r.status, 'born'); assert.equal(Object.keys(w.data.chars).length, count);
});
test('海草寿命稳定在72到120小时，临近枯萎只改变绘制透明度', () => {
  const w = sea(), c = grass(w, 'grass-life', 0, now); const expires = weedExpires(c, w.data.ecology); assert(expires >= now + 72 * HOUR && expires <= now + 120 * HOUR); assert.equal(weedExpires(clone(c), w.data.ecology), expires); assert.equal(weedAlpha(c, w.data.ecology, now), 1); assert(weedAlpha(c, w.data.ecology, expires - HOUR) < .4); assert.equal(c.color, '#48aa5d');
});
test('老海草获得分散24到48小时过渡期，刷新不会重新延长', () => {
  const w = sea(), c = grass(w, 'legacy-grass', 0, now - 200 * HOUR); w.data.ecology = newEcology(now, true); const expires = weedExpires(c, w.data.ecology); assert(expires >= now + 24 * HOUR && expires <= now + 48 * HOUR);
  const restored = restoreCheckpoint({ world: w.serialize(), lastOnlineAt: now }, now + HOUR).world; assert.equal(weedExpires(restored.data.chars[c.id], restored.data.ecology), expires);
});

test('旧存档迁移后与更早启用生态的世界合流，不缩短老草过渡期', () => {
  const original = sea(), c = grass(original, 'migration-grass', 0, now - 200 * HOUR); delete original.data.ecology;
  const migrated = restoreCheckpoint({ world: original.serialize(), lastOnlineAt: now }, now).world, expires = weedExpires(migrated.data.chars[c.id], migrated.data.ecology);
  const older = sea(); older.data.ecology = newEcology(now - 100 * HOUR); migrated.merge(older.serialize());
  assert.equal(migrated.data.chars[c.id].ecoGraceAt, now); assert.equal(weedExpires(migrated.data.chars[c.id], migrated.data.ecology), expires);
});
test('根部枯萎后上部成为75秒临时食物，过期消散并且旧快照不复活', () => {
  const w = sea(), root = grass(w, 'old-root', 0, now - 200 * HOUR), tip = grass(w, 'young-tip', 1, now, root.id), saved = w.serialize(), expires = weedExpires(root, w.data.ecology);
  updateEcology(w, expires, transition); assert.equal(root.kind, 'burn'); assert.equal(tip.kind, 'food'); assert.equal(tip.born, expires); assert(looseWither(tip));
  updateEcology(w, expires + 75000, transition); assert.equal(tip.kind, 'burn'); w.merge(saved); assert.equal(w.data.chars[root.id].kind, 'burn'); assert.equal(w.data.chars[tip.id].kind, 'burn');
});
test('离线期间已经消散的枯草食物不会在回来时变成新食物', () => {
  const w = sea(), root = grass(w, 'offline-root', 0, now - 200 * HOUR), tip = grass(w, 'offline-tip', 1, now, root.id); updateEcology(w, now, transition); assert.equal(root.kind, 'burn'); assert.equal(tip.kind, 'burn'); assert(tip.born + 75000 <= now);
});
test('已经被吃进鱼体的海草不再因草龄或枯草计时消失', () => {
  const w = sea(), c = grass(w, 'inside-fish', 0, now - 200 * HOUR); c.kind = 'fish'; c.entity = 'fish'; c.path.push({ reason: 'wither-loose', t: now - 100000 }, { reason: 'eat', t: now, target: 'fish' }); updateEcology(w, now + HOUR, transition); assert.equal(c.kind, 'fish'); assert(!looseWither(c));
});
test('生长概率在20%与40%边界分别为0.5%和0', () => { assert.equal(growthChance(.199), .01); assert.equal(growthChance(.2), .005); assert.equal(growthChance(.399), .005); assert.equal(growthChance(.4), 0); });
test('自然沉积满48小时后才参与风化，同小时重开不重复抽签', () => {
  const w = sea(), hour = Math.floor(now / HOUR); let id; do { id = crypto.randomUUID(); } while (hash(`weathering:${id}:${hour}`) % 10000 >= 200); const c = sediment(w, id, hour * HOUR - 48 * HOUR); w.data.ecology.hour = hour - 1;
  const saved = w.serialize(); updateEcology(w, hour * HOUR - 1, transition); assert.equal(c.kind, 'scene'); updateEcology(w, hour * HOUR, transition); assert.equal(c.kind, 'burn'); const length = c.path.length; updateEcology(w, hour * HOUR, transition); assert.equal(c.path.length, length); w.merge(saved); assert.equal(w.data.chars[id].kind, 'burn'); assert(!w.data.scenes[id]);
});
test('拥挤区风化概率为5%，稀疏区同一个2%到5%抽签不风化', () => {
  const hour = Math.floor(now / HOUR); let id; do { id = crypto.randomUUID(); } while (hash(`weathering:${id}:${hour}`) % 10000 < 200 || hash(`weathering:${id}:${hour}`) % 10000 >= 500);
  for (const dense of [false, true]) { const w = sea(), c = sediment(w, id, hour * HOUR - 60 * HOUR, 50); if (dense) fill(w, 50, 20, 400); w.data.ecology.hour = hour - 1; updateEcology(w, hour * HOUR, transition); assert.equal(c.kind, dense ? 'burn' : 'scene'); }
});
test('人工字符、主动改字后的沉积与聊天记忆不会风化，风化不返还额度', () => {
  const w = sea(), hour = Math.floor(now / HOUR), id = 'edited-natural', c = sediment(w, id, now - 200 * HOUR); w.data.ops.edit = { id: 'edit', kind: 'sceneEdit', cell: id, cost: 0, actor: 'maker', t: now };
  const created = crypto.randomUUID(); assert(w.apply({ id: created, actor: 'maker', t: now, kind: 'scene', x: 80, y: 20, cells: [cell(0, 0, '景'), cell(1, 0, '景')], cost: 2 }).ok); const memory = sediment(w, 'memory', now - 200 * HOUR, 100); memory.chat = 'message';
  w.data.ecology.hour = hour - 1; updateEcology(w, now, transition); assert.equal(c.kind, 'scene'); assert.equal(memory.kind, 'scene'); assert.equal(w.sceneCells(created).length, 2); assert.equal(w.wallet('maker'), 18);
});
test('生态时钟合流取稳定起点和最新小时，非法时间拒绝', () => { const a = newEcology(now, true), b = newEcology(now + HOUR); assert.deepEqual(mergeEcology(a, b), mergeEcology(b, a)); assert(validEcology(a)); assert(!validEcology({ ...a, activated: Infinity })); });
