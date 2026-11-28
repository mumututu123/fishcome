import assert from 'node:assert/strict';
import test from 'node:test';
import { BodyMembership } from '../www/body-membership.js';
import { CONFIG, World, indexEcologyCharacters } from '../www/engine.js';
import { WorkerSimulation } from '../www/simulation-worker.js';
import { POPULATION } from '../www/population.js';
import { CONTACT_TIME, updateContacts } from '../www/breeding.js';
import { makeFishWorld } from './capacity-fish.mjs';

test('入体、换鱼、删除再加入只更新涉事字块，保留原表和整数键的顺序', () => {
  const fish = (id, entity) => ({ id, entity, kind: 'fish', path: [], x: 0, y: 0 });
  const table = { a: fish('odd', 'left'), b: fish('same', 'right'), c: fish('same', 'left'), z: fish('z', 'steady') };
  let scans = 0;
  const index = new BodyMembership(new Proxy(table, {
    ownKeys(target) { scans++; return Reflect.ownKeys(target); }
  }), ['food', 'seaweed', 'scene']);
  const stable = index.groups.get('steady');
  function compare() {
    index.flush();
    const expected = indexEcologyCharacters(Object.values(table));
    assert.deepEqual([...index.groups], [...expected.groups]);
    assert.deepEqual(index.activeCells(), Object.values(table).filter(c => ['food', 'seaweed', 'scene'].includes(c.kind)));
    assert.equal(index.groups.get('steady'), stable);
    assert.equal(scans, 1);
  }
  function set(key, value) {
    index.mark(key, true, value === undefined);
    if (value === undefined) delete table[key]; else table[key] = value;
  }
  index.mark('a'); table.a.kind = 'food'; compare();
  index.mark('b'); table.b.entity = 'left'; compare();
  set('c', undefined); set('c', fish('legacy', 'right')); compare();
  set('10', fish('tenth', 'left')); set('2', fish('second', 'right')); compare();
  set('2', undefined); set('10', undefined); compare();
});

function open(reference) {
  const worker = new WorkerSimulation();
  worker.receive({ kind: 'open', values: reference.serialize(), tables: [], ambient: true });
  worker.receive({ kind: 'ready' });
  return worker;
}

test('真实退鱼和归入新鱼元时保留其余鱼形及网格，原占格清除且新增占格立即可见', () => {
  const now = Date.UTC(2026, 0, 1);
  const reference = makeFishWorld(World, 3, 1000, { now });
  const [dead, fed, steady] = Object.keys(reference.data.fishes);
  const world = open(reference).world, groups = world.fishGroups(), grid = world.movementGrid(groups);
  const hull = grid.layout.hull(groups.get(steady)), stable = groups.get(steady);
  const old = world.data.fishes[dead], pos = { x: old.x, y: old.y };
  world.starve(dead, now);
  const next = world.fishGroups();
  assert.equal(world.data.fishes[dead], undefined);
  assert.equal(world.movementGrid(next), grid);
  assert.equal(next.get(steady), stable);
  assert.equal(grid.layout.hull(stable), hull);
  assert.equal(grid.get(pos.x, pos.y), undefined);
  const previous = next.get(fed), food = world.charValues('food')[0];
  Object.assign(food, { kind: 'fish', entity: fed, x: 2, y: 0 });
  const body = world.fishGroups();
  assert.equal(body.get(fed).length, previous.length + 1);
  assert.equal(world.movementGrid(body), grid);
  assert.deepEqual([...grid.get(world.data.fishes[fed].x + 2, world.data.fishes[fed].y)], [fed]);
  assert.equal(grid.layout.hull(stable), hull);
});

test('局部食物筛选覆盖跨海界鱼眼、深浅水、药物选择和旧小数坐标', () => {
  const now = Date.UTC(2026, 0, 1);
  for (const [x, y, dx, fractional] of [[995, 59, 20, false], [2, 60, -10, false], [45, 60, 11, false], [20.5, 35, 12.5, true]]) {
    const reference = makeFishWorld(World, 3, 1000, { now });
    const [id, local, distant] = Object.keys(reference.data.fishes);
    Object.assign(reference.data.fishes[id], { x, y, created: now - CONFIG.hunger - 1000, lastFed: now - CONFIG.hunger - 1000 });
    Object.assign(reference.data.fishes[local], { x: (x + 50) % 1000, y });
    Object.assign(reference.data.fishes[distant], { x: 600, y: 50 });
    reference.data.population.illnesses[id] = { at: now, nextLossAt: now + 3600000, curedAt: 0 };
    for (const [key, offset, ch] of [['target', dx, POPULATION.remedy], ['ordinary', dx > 0 ? -5 : 5, '饵']]) {
      reference.data.chars[key] = { id: key, kind: 'food', entity: '', ch, x: (x + offset + 1000) % 1000, y, born: now, moveAt: now, fall: 0, path: [] };
    }
    const worker = open(reference), world = worker.world, grid = world.movementGrid(world.fishGroups());
    const marked = grid.visibleFoodOwners(world.charValues('food'), CONFIG.sightShallow);
    if (fractional) assert.equal(marked, undefined);
    else { assert.equal(marked[grid.slot(id)], 1); assert.equal(marked[grid.slot(distant)], 0); }
    for (let i = 0; i < 4; i++) {
      const base = reference.data.tick;
      reference.step(base + CONFIG.step);
      worker.receive({ kind: 'step', base, names: [], foods: [] });
      assert.deepEqual(JSON.parse(JSON.stringify(world.data)), reference.serialize());
    }
  }
});

test('结伴的亲鱼共用两条鱼的眼睛，病鱼仍优先向另一条鱼看见的药物游动', () => {
  const now = Date.UTC(2026, 0, 1);
  const reference = makeFishWorld(World, 2, 1000, { now, mixedGenders: true, spacingX: 2 });
  const [male, female] = Object.values(reference.data.fishes);
  Object.assign(male, { x: 995, y: 25, lastFed: now - CONFIG.hunger });
  Object.assign(female, { x: 997, y: 25, lastFed: now - CONFIG.hunger });
  for (const cell of reference.fishCells(male.id)) cell.ch = '鱼';
  for (let t = now - CONTACT_TIME; t <= now; t += CONFIG.step) updateContacts(reference, t, reference.fishGroups(), reference.sceneryMap());
  assert(reference.breedingState(male.id));
  reference.data.population.illnesses[male.id] = { at: now, nextLossAt: now + 3600000, curedAt: 0 };
  for (const [id, x, ch] of [['left', 990, '饵'], ['right', 15, POPULATION.remedy]]) {
    reference.data.chars[id] = { id, kind: 'food', entity: '', ch, x, y: 25, born: now, moveAt: now, fall: 0, path: [] };
  }
  const worker = open(reference);
  for (let i = 0; i < 4; i++) {
    const base = reference.data.tick;
    reference.step(base + CONFIG.step);
    worker.receive({ kind: 'step', base, names: [], foods: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(worker.world.data)), reference.serialize());
  }
  const eastward = (reference.data.fishes[male.id].x - 995 + CONFIG.width) % CONFIG.width;
  assert(eastward > 0 && eastward < 20);
});
