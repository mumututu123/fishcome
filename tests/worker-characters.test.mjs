import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, World } from '../www/engine.js';
import { worldTables } from '../www/simulation-changes.js';
import { WorkerSimulation } from '../www/simulation-worker.js';
import { expandSimulationPatch } from '../www/simulation-delta.js';
import { updateContacts } from '../www/breeding.js';

const start = Date.UTC(2025, 5, 15, 12, 17);
const root = '00000000-0000-4000-8000-000000000012';

function food(id, x) {
  return { id, x, y: 0, kind: 'food', entity: '', ch: '*', color: '#ace123', payer: 'visitor',
    born: start, created: start, fall: 0, path: [] };
}

function startWorker(initial) {
  const source = new World(start, root, { populate: false, ambient: false });
  const worker = new WorkerSimulation();
  const values = {}, tables = [];
  for (const [field, value] of Object.entries(source.data)) {
    if (worldTables.has(field)) tables.push(field); else values[field] = value;
  }
  const send = message => worker.receive(structuredClone(message));
  send({ kind: 'open', values, tables, ambient: false });
  send({ kind: 'rows', rows: initial.map(cell => ['chars', cell.id, cell]) });
  send({ kind: 'ready' });
  return { worker, send };
}

test('后台接触查询随性别编辑和恢复更新', () => {
  const cells = ['a', 'b'].map(id => ({ ...food(id, 0), kind: 'fish', entity: id }));
  const { worker, send } = startWorker(cells);
  const world = worker.world;
  const fish = (id, x, gender) => ({ id, x, y: 4, facing: 1, gender });
  send({ kind: 'restore', rows: [['fishes', 'a', fish('a', 3, 'male')], ['fishes', 'b', fish('b', 4, 'female')]] });
  const pairs = () => {
    updateContacts(world, start, world.fishGroups(), world.sceneryMap());
    return Object.keys(world.data.contacts);
  };
  assert.deepEqual(pairs(), ['a|b']);
  world.data.fishes.b.gender = 'male';
  assert.deepEqual(pairs(), []);
  send({ kind: 'restore', rows: [['fishes', 'b', fish('b', 4, 'female')]] });
  assert.deepEqual(pairs(), ['a|b']);
});

test('后台重算使用归档、回滚和投喂后的鱼元记录', () => {
  const initial = [food('rolled-back', 40), food('replaced', 50), food('archived', 60)];
  const { send } = startWorker(initial);
  const step = (base, changes) => send({ kind: 'step', base, names: [], foods: [], ...changes });
  assert.deepEqual(step(start).patch.tables.chars.set.map(([id]) => id), initial.map(cell => cell.id).sort());

  const restored = food('restored', 70), replaced = food('replaced', 80), added = food('fed', 90);
  send({ kind: 'restore', rows: [['chars', 'rolled-back', undefined], ['chars', restored.id, restored]],
    previous: { tick: start }, foodRevision: 0 });
  const reply = step(start, { archives: [{ removed: { chars: ['archived'] }, meals: [] }],
    foods: [[replaced.id, replaced], [added.id, added]] });
  assert.deepEqual(reply.patch.tables.chars.remove, []);
  const committed = { chars: Object.fromEntries([restored, replaced, added].map(cell => [cell.id, cell])) };
  const updated = expandSimulationPatch(committed, reply.patch, []).tables.chars.set;
  assert.deepEqual(Object.fromEntries(updated.map(([id, cell]) => [id, cell.x])), {
    [replaced.id]: replaced.x, [restored.id]: restored.x, [added.id]: added.x
  });

  const next = food('whole-table', 100);
  send({ kind: 'restore', rows: [], previous: { chars: { [next.id]: next } }, foodRevision: 0 });
  assert.deepEqual(step(start + CONFIG.step).patch.tables.chars.set.map(([id]) => id), [next.id]);
});

test('后台按种类读取鱼元保留字符表顺序，变种类、删行和回滚后读取最新记录', () => {
  const initial = [food('loose', 10), { ...food('tip', 20), kind: 'seaweed' }, food('2', 30),
    { ...food('body', 40), kind: 'fish', entity: 'owner' }];
  const { worker, send } = startWorker(initial);
  const { world } = worker, chars = world.data.chars;
  const ids = (...kinds) => world.charValues(...kinds).map(cell => cell.id);
  assert.deepEqual(ids('seaweed', 'food'), ['2', 'loose', 'tip']);
  assert.deepEqual(ids('food'), ['2', 'loose']);
  assert.deepEqual(ids('scene'), []);
  assert.deepEqual(world.fishCells('owner').map(cell => cell.id), ['body']);

  // Existing loops may keep reading their list while transitions change its rows.
  const before = world.charValues('seaweed', 'food');
  chars.tip.kind = 'food';
  chars.loose.kind = 'burn';
  assert.deepEqual(before.map(cell => cell.kind), ['food', 'burn', 'food']);
  assert.deepEqual(ids('seaweed'), []);
  assert.deepEqual(ids('seaweed', 'food'), ['2', 'tip']);
  assert.deepEqual(ids('food'), ['2', 'tip']);
  assert.deepEqual(ids('burn'), ['loose']);

  send({ kind: 'restore', rows: [['chars', '2', undefined], ['chars', 'tip', food('tip', 25)],
    ['chars', '1', { ...food('1', 5), kind: 'scene' }]] });
  assert.deepEqual(ids('food'), ['tip']);
  assert.equal(world.charValues('food')[0].x, 25);
  assert.deepEqual(ids('scene'), ['1']);
  assert.deepEqual(ids(), ['1', 'loose', 'tip', 'body']);

  send({ kind: 'restore', rows: [], previous: { chars: { final: food('final', 100) } }, foodRevision: 0 });
  assert.deepEqual(ids('scene'), []);
  assert.deepEqual(ids('food'), ['final']);
  assert.deepEqual(ids(), ['final']);
});

test('下沉的食物只交付标量改动，改写历史的鱼元完整交付', () => {
  const initial = { ...food('food', 12), path: [{ reason: 'release', t: start, target: '' }] };
  const { worker, send } = startWorker([initial]);
  const result = send({ kind: 'step', base: start, names: [], foods: [] });
  const [motion] = result.patch.tables.chars.set;
  assert.equal(motion[0], initial.id);
  assert.equal(motion.length, 3);
  assert.equal(motion[1].moveAt, start + CONFIG.step);
  assert(!Object.hasOwn(motion[1], 'path'));
  const page = { chars: { [initial.id]: initial } };
  const updated = expandSimulationPatch(page, result.patch, []).tables.chars.set[0][1];
  assert.equal(updated.path, initial.path);
  worker.world.data.chars.food.path[0].target = 'new-owner';
  const [replacement] = worker.tracker.changes().tables.chars.set;
  assert.equal(replacement.length, 2);
  assert.equal(replacement[1].path[0].target, 'new-owner');
  assert.equal(initial.path[0].target, '');
});

test('食物沉积后的分类读取沿用活跃鱼元集合', () => {
  const { worker } = startWorker([food('loose', 10), { ...food('body', 20), kind: 'fish', entity: 'adult' }]);
  const { world } = worker;
  world.charValues('food');
  world.charValues('scene');
  let reads = 0;
  Object.defineProperty(world.data.chars.body, 'kind', { configurable: true, get() { reads++; return 'fish'; } });
  world.data.chars.loose.kind = 'scene';
  assert.deepEqual(world.charValues('food'), []);
  assert.deepEqual(world.charValues('scene').map(cell => cell.id), ['loose']);
  assert.equal(reads, 0);
});

test('后台生态索引读取当前鱼体和餐史，换主人、修改旧餐、回滚后与重新索引相同', () => {
  const { worker, send } = startWorker([food('first', 10), food('second', 20)]);
  const world = worker.world, cells = world.data.chars;
  const check = () => assert.deepEqual(world.ecologyCharacters(), World.prototype.ecologyCharacters.call(world));
  check();
  cells.first.kind = 'fish';
  cells.first.entity = 'adult';
  cells.first.path.push({ reason: 'eat', t: start, target: 'adult' });
  check();
  cells.first.wild = {};
  check();
  cells.first.path[0].target = 'earlier';
  check();
  cells.first.entity = 'offspring';
  check();
  send({ kind: 'restore', rows: [['chars', 'first', undefined]] });
  check();
});

test('过期食物沉积保留活鱼的占位和餐史，真实进食单独更新', () => {
  const { worker, send } = startWorker([{ ...food('body', 5), kind: 'fish', entity: 'adult' }, food('old', 10)]);
  const w = worker.world;
  send({ kind: 'restore', rows: [['fishes', 'adult', { id: 'adult', x: 5, y: 10, facing: 1 }]] });
  const first = w.ecologyCharacters(), grid = w.movementGrid(first.groups), c = w.data.chars.old;
  Object.assign(c, { kind: 'scene', entity: 'sand' });
  c.path.push({ reason: 'expire', target: 'sand', t: start });
  const settled = w.ecologyCharacters();
  assert.deepEqual(settled, World.prototype.ecologyCharacters.call(w));
  assert.equal(w.movementGrid(settled.groups), grid);
  assert.equal(settled.latestMeals, first.latestMeals);
  c.path.push({ reason: 'eat', target: 'adult', t: start + 1 });
  const fed = w.ecologyCharacters();
  assert.equal(fed.latestMeals.get('adult'), start + 1);
  assert.equal(w.movementGrid(fed.groups), grid);
  c.path.length = 0;
  assert.equal(w.ecologyCharacters().latestMeals.size, 0);
  c.kind = 'fish'; c.entity = 'adult';
  assert.notEqual(w.movementGrid(w.fishGroups()), grid);
  assert.deepEqual(w.ecologyCharacters(), World.prototype.ecologyCharacters.call(w));
});

test('后台复用上一轮占位时仍采纳旧姿态恢复、鱼元位移和重叠鱼的顺序', () => {
  const { worker, send } = startWorker(['a','b'].map((id, i) => ({ ...food(id, i), kind: 'fish', entity: id })));
  const { world } = worker;
  function pose(id, x) { return { id, x, y: 10, facing: 1 }; }
  send({ kind: 'restore', rows: [['fishes', 'a', pose('a', 4)], ['fishes','b',pose('b', 9)]] });
  const grid = () => world.movementGrid(world.fishGroups());
  assert.deepEqual([...grid().get(4, 10)], ['a']);
  send({ kind: 'restore', rows: [['fishes','a',pose('a', 10)]] });
  assert.equal(grid().get(4, 10), undefined);
  assert.deepEqual([...grid().get(10, 10)], ['a', 'b']);
  world.data.chars.a.x = -2;
  assert.deepEqual([...grid().get(10, 10)], ['b']);
  assert.deepEqual([...grid().get(8, 10)], ['a']);
});

test('后台复用鱼群资料时仍补回回滚的行程、旧餐和新归档的进食时间', () => {
  const { worker, send } = startWorker([food('cell', 5)]);
  const w = worker.world, cell = w.data.chars.cell;
  const fish = { id: 'fish', created: start, x: 5, y: 8, facing: 1, lastFed: start };
  send({ kind: 'restore', rows: [['fishes', 'fish', fish]] });
  const sync = now => {
    w.initializeTracking(now);
    w.applyMealClaims(w.ecologyCharacters().latestMeals);
  };
  sync(start);
  assert.equal(w.data.travel.fish.since, start);
  delete w.data.travel.fish;
  cell.path.push({ reason: 'eat', t: start + 10, target: 'fish' });
  sync(start + 100);
  assert.equal(w.data.travel.fish.since, start + 100);
  assert.equal(w.data.fishes.fish.lastMealAt, start + 10);
  w.data.fishes.fish.lastFed = start + 300;
  sync(start + 300);
  assert.equal(w.data.fishes.fish.lastMealAt, start + 300);
  send({ kind: 'step', base: start, names: [], foods: [], archives: [{ removed: {}, meals: [['fish', start + 400, false]] }] });
  assert.equal(w.data.fishes.fish.lastMealAt, start + 400);
});
