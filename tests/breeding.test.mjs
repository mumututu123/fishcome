import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, EYES, cellPosition, components, velocities, clone, hash } from './empty-world.mjs';
import { CONTACT_TIME, BREEDING_TIME, updateContacts, finishBreeding, chooseOwner, motionUnits, commitUnit, validBreedingRecord, inheritedGlyph } from '../www/breeding.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { HOUR, GREENS, growthRoll, weedId, validWildCell } from '../www/seaweed.js';
const t = Date.now() - 2 * BREEDING_TIME;
const cell = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
function fish(world, gender, x, y, cells = [cell(0, 0), cell(1, 0), cell(2, 0)], actor = gender, suppliedId) {
  const id = suppliedId || crypto.randomUUID(); assert(world.apply({ id, kind: 'fish', actor, nick: actor, gender, t, x, y, cells, cost: cells.length }).ok); return id;
}
function pair(fatherCells, motherCells, motherX = 23, motherY = 20) {
  const world = new World(t), male = fish(world, 'male', 20, 20, fatherCells), female = fish(world, 'female', motherX, motherY, motherCells); return { world, male, female };
}
function contacts(world, now) { updateContacts(world, now, world.fishGroups(), world.sceneryMap()); }
function bind(world) { for (let i = 0; i <= CONTACT_TIME; i += CONFIG.step) contacts(world, t + i); return Object.values(world.data.breeding).find(record => record.status === 'active'); }
const transition = (cell, next, record) => { Object.assign(cell, next); cell.path.push({ ...record, target: next.entity || '', x: next.x, y: next.y }); };

test('公母八邻域连续接触满5秒才绑定，中断、长时间休眠重置计时', () => {
  const { world, female } = pair(); contacts(world, t); for (let i = 500; i < 5000; i += 500) contacts(world, t + i);
  assert.equal(Object.keys(world.data.breeding).length, 0); contacts(world, t + 5000); assert.equal(Object.values(world.data.breeding)[0].ends, t + 5000 + BREEDING_TIME);
  const interrupted = pair(); contacts(interrupted.world, t); contacts(interrupted.world, t + 500); interrupted.world.data.fishes[interrupted.female].x += 10; contacts(interrupted.world, t + 1000); assert.equal(Object.keys(interrupted.world.data.contacts).length, 0);
  interrupted.world.data.fishes[interrupted.female].x -= 10; contacts(interrupted.world, t + 1500); contacts(interrupted.world, t + 6500); assert.equal(Object.keys(interrupted.world.data.breeding).length, 0);
  const sameSex = pair(); sameSex.world.data.ops[sameSex.female].gender = 'male'; assert.equal(bind(sameSex.world), undefined);
  const legacy = pair(); delete legacy.world.data.ops[legacy.female].gender; assert.equal(bind(legacy.world), undefined);
});
test('接触不能隔着造景，繁殖期间不能与第三条鱼配对', () => {
  const diagonal = pair(undefined, undefined, 23, 21);
  assert(diagonal.world.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 23, y: 20, cells: [cell(0, 0, '#'), cell(1, 0, '#')], cost: 2 }).ok);
  assert.equal(bind(diagonal.world), undefined);
  const { world, male } = pair(), record = bind(world); assert(record);
  fish(world, 'female', 17, 20, undefined, 'other'); for (let i = 5500; i <= 12000; i += 500) contacts(world, t + i);
  assert.equal(Object.values(world.data.breeding).filter(r => r.status === 'active').length, 1); assert.equal(world.breedingState(male).id, record.id);
});
test('合体游速按外接宽高和两鱼总字数计算，移动与水平翻转保持相对形状', () => {
  const { world, male, female } = pair(), record = bind(world), units = motionUnits(world, world.fishGroups());
  assert.equal(units.length, 1); assert.deepEqual(velocities(units[0].cells), { x: 2, y: 1 / 3 }); assert.deepEqual(world.swimVelocities(male), world.swimVelocities(female));
  const unit = units[0], initial = world.fishCells(male).map(c => cellPosition(world.data.fishes[male], c));
  assert(world.turn(unit.fish, unit.cells)); unit.fish.x -= 1; unit.fish.y += 1; commitUnit(unit, t + 5500);
  assert.equal(world.data.fishes[male].x - world.data.fishes[female].x, 3); assert.equal(world.data.fishes[male].y, world.data.fishes[female].y);
  assert.equal(world.data.fishes[male].facing, -1); assert.equal(world.data.fishes[female].facing, -1);
  assert(validBreedingRecord(record, world.data));
  const reflected = world.fishCells(male).map(c => cellPosition(world.data.fishes[male], c));
  assert.deepEqual(reflected, initial.map(p => ({ x: 45 - p.x - 1, y: p.y + 1 })));
});
test('合体移动、转头检查两条鱼全部鱼元与扫过路径，碰墙不移动', () => {
  const { world } = pair(); bind(world); const unit = motionUnits(world, world.fishGroups())[0];
  assert(world.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 26, y: 20, cells: [cell(0, 0, '#'), cell(0, 1, '#')], cost: 2 }).ok);
  assert.equal(world.canOccupy({ ...unit.fish, x: unit.fish.x + 1 }, unit.cells), false);
  const bent = pair([cell(0, 0), cell(1, 1), cell(2, 2)], [cell(0, 0), cell(1, 0), cell(2, 0)], 23, 22); bind(bent.world);
  const turning = motionUnits(bent.world, bent.world.fishGroups())[0];
  assert(bent.world.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 22, y: 20, cells: [cell(0, 0, '#'), cell(1, 0, '#')], cost: 2 }).ok);
  assert.equal(bent.world.turn(turning.fish, turning.cells), false);
});
test('繁殖期间两鱼正常进食，字色长在吃到的鱼上，合体仍保持固定位置', () => {
  const { world, male, female } = pair(); bind(world);
  const foodIds = [];
  for (const [index, x] of [19, 26].entries()) { const id = crypto.randomUUID(); foodIds.push(id); assert(world.apply({ id, actor: 'feeder', t, kind: 'food', x, y: 0, ch: index ? '口' : '草', color: '#55bc68', cost: 1 }).ok); world.data.chars[id].y = 20; }
  world.step(t + 5500);
  assert.equal(world.data.chars[foodIds[0]].entity, male); assert.equal(world.data.chars[foodIds[1]].entity, female);
  assert.equal(world.fishCells(male).length, 4); assert.equal(world.fishCells(female).length, 4);
  assert.equal(world.data.fishes[male].lastFed, t + 5500); assert.equal(world.data.fishes[female].lastFed, t + 5500);
  assert.equal(world.data.fishes[male].x - world.data.fishes[female].x, -3); assert.equal(world.fishStatus(male, t + 5500).meals24, 1);
});
test('1小时后只转移进入繁殖时的接触鱼元，父母各保留至少两个连通鱼元，小鱼补眼且不复制鱼元', () => {
  const { world, male, female } = pair(), record = bind(world), ids = Object.keys(world.data.chars), positions = new Map(Object.values(world.data.chars).map(c => [c.id, cellPosition(world.data.fishes[c.entity], c)]));
  finishBreeding(world, record.ends - 1, transition); assert.equal(world.counts().fish, 2);
  finishBreeding(world, record.ends, transition); assert.equal(record.status, 'born'); assert.equal(world.counts().fish, 3); assert.deepEqual(Object.keys(world.data.chars), ids);
  const baby = world.data.fishes[record.baby.id], cells = world.fishCells(baby.id);
  assert.equal(cells.length, 2); assert(cells.some(c => EYES.has(c.ch))); assert.equal(cells.filter(c => EYES.has(c.ch)).length, 1);
  for (const c of cells) { assert.deepEqual(cellPosition(baby, c), positions.get(c.id)); assert.equal(c.color, '#88aacc'); assert.equal(inheritedGlyph(c, 'Q', world.data), c.ch); }
  for (const id of [male, female]) { assert.equal(world.fishCells(id).length, 2); assert.equal(components(world.fishCells(id)).length, 1); assert.equal(world.breedingState(id), undefined); }
  assert(validBreedingRecord(record, world.data)); assert.equal(world.wallet('male'), 17); assert.equal(world.wallet('female'), 17);
  assert.equal(world.myFishes(baby.actor).some(f => f.id === baby.id), true); assert.equal(world.fishStatus(baby.id, record.ends).meals24, 0);
  finishBreeding(world, record.ends + 500, transition); assert.equal(world.counts().fish, 3);
});
test('归属优先继承鱼元数量，再比较分裂后的父母字数，最后稳定随机', () => {
  const { world, female } = pair(undefined, [0, 1, 2, 3, 4].map(y => cell(0, y)), 23, 19), record = bind(world);
  finishBreeding(world, record.ends, transition); assert.equal(record.baby.fatherCount, 1); assert.equal(record.baby.motherCount, 3); assert.equal(record.baby.owner, female); assert.equal(record.baby.actor, 'female'); assert(validBreedingRecord(record, world.data));
  const largeFather = pair([0, 1, 2, 3, 4].map(x => cell(x, 0)), undefined, 25, 20), second = bind(largeFather.world); finishBreeding(largeFather.world, second.ends, transition); assert.equal(second.baby.owner, largeFather.male);
  assert.equal(chooseOwner(record, 1, 2, 10, 2), record.female);
  const chosen = chooseOwner(record, 2, 2, 4, 4); assert([record.male, record.female].includes(chosen)); assert.equal(chooseOwner(clone(record), 2, 2, 4, 4), chosen);
});
test('出生后父母过小、父母断裂或小鱼不连通时取消出生，鱼元不减少', () => {
  const cases = [pair([cell(0, 0), cell(1, 0)], [cell(0, 0), cell(1, 0)], 22, 20), pair([0, 1, 2, 3, 4].map(x => cell(x, 0)), [0, 1, 2].map(y => cell(0, y)), 22, 17), pair([0, 1, 2, 3, 4, 5, 6].map(x => cell(x, 0)), [cell(0, 0), cell(6, 0), ...[0, 1, 2, 3, 4, 5, 6].map(x => cell(x, 1))], 20, 21)];
  for (const { world } of cases) { const record = bind(world); assert(record); const before = clone(world.data.chars); finishBreeding(world, record.ends, transition); assert.equal(record.status, 'cancelled'); assert.equal(world.counts().fish, 2); assert.deepEqual(world.data.chars, before); }
});
test('繁殖期间亲鱼消失取消绑定，饥饿丢失接触鱼元时不转移其他鱼元替代', () => {
  const { world, male } = pair(), record = bind(world); delete world.data.fishes[male]; finishBreeding(world, t + 6000, transition); assert.equal(record.reason, 'parent-gone');
  const second = pair(), attempt = bind(second.world), removed = attempt.contact.male[0]; second.world.starve(second.male, t + 6000, removed); finishBreeding(second.world, attempt.ends, transition); assert.equal(attempt.status, 'cancelled'); assert.equal(second.world.data.chars[removed].kind, 'burn');
});
test('繁殖状态、出生归属、鱼元和运动记录跨存档与合流保存，旧快照不复活孕期或重复出生', () => {
  const { world } = pair(), record = bind(world), active = world.serialize();
  const restored = restoreCheckpoint({ world: active, at: t + 5000, lastOnlineAt: t + 5000 }, t + 6000).world; assert(restored.breedingState(record.male));
  finishBreeding(restored, record.ends, transition); const born = restored.serialize(), peer = new World(t); peer.merge(born); peer.merge(active); peer.merge(born);
  assert.equal(peer.counts().fish, 3); assert.equal(peer.data.breeding[record.id].status, 'born'); assert.equal(peer.breedingState(record.male), undefined); assert.equal(peer.fishCells(born.breeding[record.id].baby.id).length, 2);
  assert.equal(peer.data.travel[born.breeding[record.id].baby.id].since, record.ends);
});
test('出生记录与眼睛转换必须可追溯，伪造归属、性别或鱼元转换被拒绝', () => {
  const { world } = pair(), record = bind(world); finishBreeding(world, record.ends, transition);
  for (const mutate of [r => r.baby.actor = 'intruder', r => r.baby.gender = r.baby.gender === 'male' ? 'female' : 'male', r => r.baby.cells[0].after = '#', r => r.ends--, r => r.pose.male.x++]) { const bad = clone(record); mutate(bad); assert.equal(validBreedingRecord(bad, { ...world.data, breeding: { [bad.id]: bad } }), false); }
  const born = world.fishCells(record.baby.id)[0], bad = clone(born); bad.path.at(-1).before = '#'; assert.equal(inheritedGlyph(bad, 'Q', world.data), null);
});
test('完整模拟循环持续接触5秒后配对，合体眼睛共同寻食且两鱼运动同量', () => {
  const world = new World(t);
  function idleId() { let id; do { id = crypto.randomUUID(); } while (hash(`${id}:0`) % 3 !== 1 || Math.floor(hash(`${id}:0`) / 3) % 3 !== 1); return id; }
  const male = fish(world, 'male', 20, 20, [cell(0, 0, 'o'), cell(1, 0), cell(2, 0)], 'male', idleId()), female = fish(world, 'female', 23, 20, undefined, 'female', idleId());
  for (let elapsed = 0; elapsed <= 5000; elapsed += 500) world.step(t + elapsed);
  assert(world.breedingState(male));
  const food = crypto.randomUUID(); assert(world.apply({ id: food, actor: 'feed', t: t + 5000, kind: 'food', x: 30, y: 0, ch: '口', color: '#aabbcc', cost: 1 }).ok); world.data.chars[food].y = 20;
  const old = { x: world.data.fishes[male].x, y: world.data.fishes[male].y }, other = { x: world.data.fishes[female].x, y: world.data.fishes[female].y };
  world.step(t + 5500);
  assert.equal(world.data.fishes[male].x - old.x, world.data.fishes[female].x - other.x); assert.equal(world.data.fishes[male].y - old.y, world.data.fishes[female].y - other.y);
  assert.equal(world.fishStatus(male, t + 5500).movement, world.fishStatus(female, t + 5500).movement); assert(world.fishStatus(male, t + 5500).movement > 0);
});
test('小鱼长大后可以繁殖，后代归属和多代眼睛转换仍可追溯', () => {
  const { world, male, female } = pair(), first = bind(world); finishBreeding(world, first.ends, transition);
  const child = world.data.fishes[first.baby.id]; child.x = 40; child.y = 20; world.data.fishes[male].y = world.data.fishes[female].y = 50;
  for (const x of [2, 3]) {
    const id = crypto.randomUUID(); assert(world.apply({ id, actor: 'feeder', t, kind: 'food', x: 40 + x, y: 0, ch: 'Q', color: '#aabbcc', cost: 1 }).ok);
    transition(world.data.chars[id], { kind: 'fish', entity: child.id, x, y: 0 }, { id: `eat:${id}`, t: first.ends, reason: 'eat' });
  }
  const gender = child.gender === 'male' ? 'female' : 'male'; fish(world, gender, 37, 20, undefined, 'new-parent');
  for (let elapsed = 500; elapsed <= 5500; elapsed += 500) contacts(world, first.ends + elapsed);
  const second = world.breedingState(child.id); assert(second); finishBreeding(world, second.ends, transition); assert.equal(second.status, 'born'); assert(validBreedingRecord(second, world.data));
  const inherited = world.fishCells(second.baby.id).find(c => c.path.filter(p => p.reason === 'birth').length === 2); assert(inherited); assert.equal(inheritedGlyph(inherited, 'Q', world.data), inherited.ch);
  assert(world.myFishes(second.baby.actor).some(f => f.id === second.baby.id));
});
test('曾吃入鱼体的海草也可遗传，补眼后仍保留合法自然来源与原色', () => {
  const { world, male } = pair(), tip = world.fishCells(male).find(c => c.x === 2); world.starve(male, t + 500, tip.id);
  const source = 'floor:22'; let hour = Math.floor(t / HOUR) - 10000; while (!growthRoll(source, ++hour, hash)) {}
  const id = weedId(source, hour, hash), grass = { id, kind: 'food', entity: '', payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x: 22, y: 20, born: t, created: hour * HOUR, path: [], wild: { source, hour, plant: id, index: 0, x: 22, y: 119 } }; world.data.chars[id] = grass;
  transition(grass, { kind: 'fish', entity: male, x: 2, y: 0 }, { id: `eat:${id}`, t, reason: 'eat' });
  const record = bind(world); finishBreeding(world, record.ends, transition); assert.equal(grass.entity, record.baby.id); assert(validWildCell(grass, CONFIG, hash)); assert.equal(inheritedGlyph(grass, '草', world.data), grass.ch); assert(validBreedingRecord(record, world.data));
});
