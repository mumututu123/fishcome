import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, World } from '../www/engine.js';
import { worldTables } from '../www/simulation-changes.js';
import { WorkerSimulation } from '../www/simulation-worker.js';

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
  assert.deepEqual(Object.fromEntries(reply.patch.tables.chars.set.map(([id, cell]) => [id, cell.x])), {
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
