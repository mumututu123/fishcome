import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, hash, validateDrawing, EYES, clone } from '../www/engine.js';
import { initialLife, initialSources, validInitialOp, INITIAL_FISH_NAME } from '../www/genesis.js';
import { validWildCell, HOUR, growthRoll, updateSeaweed } from '../www/seaweed.js';
import { bubbleRoll, MINUTE } from '../www/bubbles.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { fishCatalog, displayFishName } from '../www/fish-profile.js';
import { CONTACT_TIME, BREEDING_TIME, updateContacts, finishBreeding, validBreedingRecord } from '../www/breeding.js';
import { wrapX } from '../www/geography.js';
const at = Date.now() - 2 * HOUR;
const transition = (cell, next, record) => { Object.assign(cell, next); cell.path.push({ ...record, target: next.entity || '', x: next.x, y: next.y }); };

test('新世界随机2–10条合法鱼及约1%的逐列海底海草，鱼元不重叠且不扣用户额度', () => {
  const counts = new Set(); let weeds = 0;
  for (let i = 0; i < 120; i++) {
    const world = new World(at), count = world.counts().fish; counts.add(count);
    assert(count >= 2 && count <= 10); assert.equal(world.wallet('player'), 20);
    const positions = new Set(), sources = initialSources(world.data.roots), catalog = fishCatalog(world.data);
    for (const fish of Object.values(world.data.fishes)) {
      const op = world.data.ops[fish.id]; assert(validInitialOp(op, sources)); assert.equal(world.validOp(op), ''); assert.equal(validateDrawing(op.cells, 'fish'), '');
      assert(op.cells.length >= Array.from(INITIAL_FISH_NAME).length && op.cells.length <= 15); assert(op.cells.some(cell => EYES.has(cell.ch)));
      assert.equal(displayFishName(catalog.get(fish.id)), INITIAL_FISH_NAME); assert(['male', 'female'].includes(world.fishOrigin(fish.id).gender));
      for (const cell of op.cells) { const key = `${wrapX(fish.x + cell.x)},${fish.y + cell.y}`; assert(!positions.has(key)); positions.add(key); assert(world.waterAt(fish.x + cell.x, fish.y + cell.y)); }
    }
    for (const cell of Object.values(world.data.chars).filter(cell => cell.kind === 'seaweed')) { weeds++; assert.equal(cell.y, world.floorAt(cell.x) - 1); assert(validWildCell(cell, CONFIG, hash, sources)); assert(!positions.has(`${cell.x},${cell.y}`)); }
  }
  assert.equal(counts.size, 9); assert(weeds > 850 && weeds < 1550, `120000列生成${weeds}草`);
});

test('同一起源复现相同初始生命，恢复存档不补种，旧世界仍保持原状', () => {
  const world = new World(at), same = new World(at, world.id); assert.deepEqual(same.serialize(), world.serialize());
  const fish = Object.keys(world.data.fishes)[0]; world.starve(fish, at + CONFIG.hunger); const saved = world.serialize();
  assert.deepEqual(restoreCheckpoint({ world: saved, lastOnlineAt: at }, at + 10000).world.data.chars, saved.chars);
  const legacy = new World(at, undefined, { populate: false });
  const restored = restoreCheckpoint({ world: legacy.serialize(), at }, at + 1000).world; assert.equal(restored.counts().fish, 0); assert.equal(Object.keys(restored.data.chars).length, 0);
  const next = restoreCheckpoint({ world: saved, lastOnlineAt: at }, at + CONFIG.offlineLife); assert(next.expired); assert(next.world.counts().fish >= 2 && next.world.counts().fish <= 10); assert(!next.world.data.fishes[fish]);
});

test('初始鱼与同凭据正常投放的鱼遵循相同游速、移动、鱼况与饥饿脱字规则', () => {
  const seeded = new World(at), normal = new World(at, seeded.id, { populate: false });
  for (const cell of Object.values(seeded.data.chars).filter(cell => cell.kind === 'seaweed')) normal.data.chars[cell.id] = clone(cell);
  for (const op of Object.values(seeded.data.ops)) { const { genesis, ...body } = op; assert(normal.apply(body).ok); }
  for (let step = 1; step <= 20; step++) { const now = at + step * CONFIG.step; seeded.step(now); normal.step(now); }
  assert.deepEqual(seeded.data.fishes, normal.data.fishes); assert.deepEqual(seeded.data.chars, normal.data.chars); assert.deepEqual(seeded.data.travel, normal.data.travel);
  for (const id of Object.keys(seeded.data.fishes)) { assert.deepEqual(seeded.fishStatus(id, at + 10000), normal.fishStatus(id, at + 10000)); seeded.starve(id, at + CONFIG.hunger); normal.starve(id, at + CONFIG.hunger); }
  assert.deepEqual(seeded.data.chars, normal.data.chars); assert.deepEqual(seeded.data.fishes, normal.data.fishes);
});

test('初始鱼占据真实鱼体，正常用户不能在其身上造鱼或造景', () => {
  const world = new World(at), fish = Object.values(world.data.fishes)[0], body = world.fishCells(fish.id);
  for (const kind of ['fish', 'scene']) { const result = world.apply({ id: crypto.randomUUID(), actor: 'player', t: at, kind, x: fish.x, y: fish.y, cells: body.slice(0, 2).map(({ x, y, ch, color }) => ({ x, y, ch, color })), cost: 2 }); assert(!result.ok); }
  assert.equal(world.wallet('player'), 20);
});

test('初始海草草尖按原规则继续生长，新草尖仍有合法来源且归入同一株', () => {
  let world, root;
  do { world = new World(at); root = Object.values(world.data.chars).find(cell => cell.kind === 'seaweed'); } while (!root);
  let hour = Math.floor(at / HOUR) + 2; while (!growthRoll(`tip:${root.id}`, hour, hash)) hour++;
  world.data.seaweedHour = hour - 1;
  updateSeaweed(world, hour * HOUR, CONFIG, world.monument, hash, transition);
  const child = Object.values(world.data.chars).find(cell => cell.wild?.source === `tip:${root.id}`);
  assert(child); assert.equal(child.entity, root.entity); assert.equal(child.wild.index, 1); assert(validWildCell(child, CONFIG, hash, initialSources(world.data.roots)));
});

function initialSeaweedAtBubbleMinute(world, minute) {
  const cell = Object.values(world.data.chars).find(cell => cell.kind === 'seaweed' && bubbleRoll(cell.id, minute, cell.y));
  assert(cell);
  return cell;
}

const seaweedStart = Date.UTC(2026, 0, 1);
const seaweedWorldId = '00000000-0000-4000-8000-000000000000';

test('初始海草会产生能追溯到该株海草的气泡', () => {
  const world = new World(seaweedStart, seaweedWorldId);
  const minute = seaweedStart / MINUTE + 2;
  const cell = initialSeaweedAtBubbleMinute(world, minute);
  world.step(minute * MINUTE);
  assert(Object.values(world.data.bubbles).some(bubble => bubble.source === cell.id));
});

test('初始鱼吃到海草后保留可验证的生态来源', () => {
  const world = new World(seaweedStart, seaweedWorldId);
  const minute = seaweedStart / MINUTE + 2;
  const cell = initialSeaweedAtBubbleMinute(world, minute);
  world.step(minute * MINUTE);
  const fish = Object.values(world.data.fishes)[0];
  Object.assign(fish, { x: wrapX(cell.x - 3), y: cell.y - 3, facing: 1 });

  world.step(world.data.tick);

  assert.equal(cell.kind, 'fish');
  assert.equal(cell.entity, fish.id);
  assert(cell.path.some(event => event.reason === 'eat'));
  assert(validWildCell(cell, CONFIG, hash, initialSources(world.data.roots)));
});

test('初始鱼在相同偏移处够不到海草时不会吃掉它', () => {
  const start = Date.UTC(2026, 10, 25, 7, 52, 8);
  const world = new World(start, 'd2f48367-2c02-49f6-87dd-3c9ecee6deac');
  const minute = Math.floor(start / MINUTE) + 5;
  const cell = initialSeaweedAtBubbleMinute(world, minute);
  world.step(minute * MINUTE);
  const fish = Object.values(world.data.fishes)[0];
  Object.assign(fish, { x: wrapX(cell.x - 3), y: cell.y - 3, facing: 1 });

  world.step(world.data.tick);

  assert.equal(cell.kind, 'seaweed');
  assert(!cell.path.some(event => event.reason === 'eat'));
  assert(validWildCell(cell, CONFIG, hash, initialSources(world.data.roots)));
});

test('初始公母鱼按正常接触计时繁殖，后代具有真实归属和鱼谱记录', () => {
  let world, male, female;
  do { world = new World(at); male = Object.values(world.data.fishes).find(fish => fish.gender === 'male' && world.data.ops[fish.id].cells.length === 9); female = Object.values(world.data.fishes).find(fish => fish.gender === 'female' && world.data.ops[fish.id].cells.length === 9); } while (!male || !female);
  Object.assign(male, { x: 30, y: 20 }); Object.assign(female, { x: 30, y: 23 });
  for (let offset = 0; offset <= CONTACT_TIME; offset += CONFIG.step) updateContacts(world, at + offset, world.fishGroups(), world.sceneryMap());
  const record = world.breedingState(male.id); assert(record); assert.equal(record.ends - record.started, BREEDING_TIME);
  finishBreeding(world, record.ends, transition); assert.equal(record.status, 'born'); assert(validBreedingRecord(record, world.data)); assert(world.data.fishes[record.baby.id]); assert.equal(fishCatalog(world.data).get(record.baby.id).parents.length, 2); assert([male.actor, female.actor].includes(record.baby.actor));
});

test('不同新世界合流保留各自初始生命且重复合流不复制，已死鱼不复活', () => {
  const a = new World(at), b = new World(at + 1), before = a.serialize(), count = a.counts().fish + b.counts().fish;
  a.merge(b.serialize()); b.merge(before); a.reconcileGeometry(at + 2); b.reconcileGeometry(at + 2); assert.equal(a.counts().fish, count); assert.deepEqual(a.data.chars, b.data.chars);
  const id = Object.keys(a.data.fishes)[0], old = a.serialize(); while (a.data.fishes[id]) a.starve(id, at + CONFIG.hunger);
  a.merge(old); assert(!a.data.fishes[id]); const size = Object.keys(a.data.chars).length; a.merge(b.serialize()); a.merge(b.serialize()); assert.equal(Object.keys(a.data.chars).length, size);
});

test('初始鱼和海草出生记录拒绝改名、改色、超量、伪造起源和修改起源时间', () => {
  const world = new World(at), initial = initialSources(world.data.roots), op = Object.values(world.data.ops)[0];
  for (const bad of [{ ...op, name: '伪造' }, { ...op, cost: 0 }, { ...op, genesis: crypto.randomUUID() }, { ...op, id: crypto.randomUUID() }, { ...op, proof: {} }]) assert(!validInitialOp(bad, initial));
  const bad = world.serialize(); bad.ops[op.id].gender = op.gender === 'male' ? 'female' : 'male'; assert.throws(() => world.merge(bad), /初始鱼/);
  const changedRoot = world.serialize(); changedRoot.roots[world.id]++; delete changedRoot.terrain; assert.throws(() => world.merge(changedRoot), /起源时间/);
  let grassWorld = world; while (!Object.values(grassWorld.data.chars).some(cell => cell.kind === 'seaweed')) grassWorld = new World(at);
  const grass = Object.values(grassWorld.data.chars).find(cell => cell.kind === 'seaweed'), sources = initialSources(grassWorld.data.roots);
  for (const bad of [{ ...grass, ch: '鱼' }, { ...grass, color: '#000000' }, { ...grass, created: at + 1 }, { ...grass, wild: { ...grass.wild, x: grass.x + 1 } }]) assert(!validWildCell(bad, CONFIG, hash, sources));
});
