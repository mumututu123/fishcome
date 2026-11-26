import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: { history: { type: 'string', default: '1' }, live: { type: 'string' } },
  allowPositionals: true
});
assert(positionals.length <= 1 && ['0', '1', '10'].includes(values.history) &&
  [undefined, '1', '2', '4'].includes(values.live),
  'Usage: node tests/benchmark-breeding.mjs [source-checkout] [--history=0|1|10] [--live=1|2|4]');
const historyScale = Number(values.history), liveScale = Number(values.live ?? '1');
const fixedRegions = values.live !== undefined;
const source = positionals[0]
  ? pathToFileURL(resolve(positionals[0], 'www') + '/')
  : new URL('../www/', import.meta.url);
const { World, CONFIG } = await import(new URL('engine.js', source));
const { CONTACT_TIME, finishBreeding, updateContacts, validBreedingRecord } = await import(new URL('breeding.js', source));
const { fishCatalog } = await import(new URL('fish-profile.js', source));

const start = Date.UTC(2025, 5, 15, 12, 17);
const historyStart = Date.UTC(2025, 0, 1);
const seed = '00000000-0000-4000-8000-f150c0e00000';
const baseline = { fish: 558, active: 170, cancelled: 3814, born: 543 };
const expected = {
  fish: baseline.fish * liveScale,
  active: baseline.active * liveScale,
  cancelled: baseline.cancelled * historyScale,
  born: baseline.born * historyScale
};
const warmupSteps = 12, measuredSteps = 16;
const preparationMs = fixedRegions ? 20000 : CONTACT_TIME;
const drawing = [[0, 0], [1, 0], [2, 0], [3, 0], [1, 1], [2, 1]]
  .map(([x, y]) => ({ x, y, ch: x === 0 ? 'o' : '鱼', color: '#8be7df' }));
let sequence = fixedRegions ? 0x100000 : 0;

function addFish(world, gender, x, y, t, cells = drawing) {
  const id = `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
  const result = world.apply({ id, actor: id, nick: '鱼友', kind: 'fish', gender, x, y, t, cells, cost: cells.length });
  assert.equal(result.ok, true, result.error);
}

function bindPairs(world, now, duration = CONTACT_TIME) {
  const groups = world.fishGroups(), scenery = world.sceneryMap();
  for (let t = now - duration; t <= now; t += CONFIG.step) updateContacts(world, t, groups, scenery);
}

function endPair(world, started, status) {
  bindPairs(world, started);
  const [record] = Object.values(world.data.breeding);
  assert.equal(record?.status, 'active');
  finishBreeding(world, record.ends, (cell, next, event) => {
    Object.assign(cell, next);
    cell.path.push({ ...event, target: next.entity, x: next.x, y: next.y });
  });
  assert.equal(record.status, status);
  delete world.data.breeding[record.id];
  return record;
}

function addHistory(world, batch) {
  const first = historyStart, hour = 3600000;
  const x = 20 + batch * 10;
  const history = new World(first, seed, { populate: false, ambient: false });
  addFish(history, 'male', x, 20, first, drawing.slice(0, 2));
  addFish(history, 'female', x + 2, 20, first, drawing.slice(0, 2));
  Object.assign(world.data.ops, history.data.ops);
  for (let i = 1; i <= baseline.cancelled; i++) {
    const record = endPair(history, first + i * (hour + CONTACT_TIME), 'cancelled');
    world.data.breeding[record.id] = record;
  }
  for (let i = 0; i < baseline.born; i++) {
    const t = first + i * hour;
    const parents = new World(t, seed, { populate: false, ambient: false });
    const y = batch === 0 ? 20 : 24;
    addFish(parents, 'male', x, y, t, drawing.slice(0, 3));
    addFish(parents, 'female', x + 3, y, t, drawing.slice(0, 3));
    const record = endPair(parents, t + CONTACT_TIME, 'born');
    world.data.breeding[record.id] = record;
    Object.assign(world.data.ops, parents.data.ops);
  }
}

function placeInRegions(world, created) {
  const singlesPerGender = (expected.fish - expected.active * 2) / 2;
  const regions = [
    { firstColumn: 0, columns: 36, count: expected.active, gender: 'pair' },
    { firstColumn: 40, columns: 25, count: singlesPerGender, gender: 'male' },
    { firstColumn: 70, columns: 25, count: singlesPerGender, gender: 'female' }
  ];
  for (const { firstColumn, columns, count, gender } of regions) {
    for (let i = 0; i < count; i++) {
      const slot = Math.floor(i * columns * 19 / count);
      const x = 5 + (firstColumn + slot % columns) * 10;
      const y = 3 + Math.floor(slot / columns) * 4;
      addFish(world, gender === 'pair' ? 'male' : gender, x, y, created);
      if (gender === 'pair') addFish(world, 'female', x + 4, y, created);
    }
  }
}

function verify(world, now) {
  const { data } = world;
  const counts = { fish: Object.keys(data.fishes).length, active: 0, cancelled: 0, born: 0 };
  const paired = new Set(), catalog = fishCatalog(data);
  for (const record of Object.values(data.breeding)) {
    counts[record.status]++;
    assert(validBreedingRecord(record, data), record.id);
    assert(record.at <= now, record.id);
    if (record.status === 'born') {
      assert.equal(catalog.get(record.baby.id)?.alive, false);
      assert.deepEqual(catalog.get(record.baby.id)?.parents, [record.male, record.female]);
    }
    if (record.status !== 'active') continue;
    assert.equal(record.at, now === start ? record.started : now, record.id);
    assert(record.started <= start, record.id);
    assert(record.ends > now, record.id);
    for (const [role, id] of [['male', record.male], ['female', record.female]]) {
      assert(!paired.has(id), id);
      paired.add(id);
      const { x, y, facing } = data.fishes[id];
      assert.deepEqual(record.pose[role], { x, y, facing });
    }
  }
  assert.deepEqual(counts, expected);
  assert.equal(data.tick, now);
  assert.equal(data.contactAt, now);
  assert.equal([...catalog.values()].filter(fish => fish.alive).length, expected.fish);
  for (const [position, occupants] of world.fishOccupants()) {
    const [x, y] = position.split(',').map(Number);
    assert(world.waterAt(x, y), position);
    assert.equal(occupants.size, 1, position);
  }
  return counts;
}

const world = new World(start, seed, { populate: false });
world.data.roots[seed] = world.data.terrain.createdAt = historyStart;
const created = start - preparationMs;
if (fixedRegions) {
  placeInRegions(world, created);
  // Reuse the same historical fish IDs and records at every live population.
  sequence = baseline.fish;
} else {
  for (let i = 0; i < expected.fish - expected.active; i++) {
    const x = 5 + i % 64 * 15, y = 7 + Math.floor(i / 64) * 10;
    addFish(world, i < expected.active || i % 2 === 0 ? 'male' : 'female', x, y, created);
    if (i < expected.active) addFish(world, 'female', x + 4, y, created);
  }
}
for (let batch = 0; batch < historyScale; batch++) addHistory(world, batch);
bindPairs(world, start, preparationMs);
const before = verify(world, start);

const movement = ({ days }) => Object.values(days).reduce((sum, distance) => sum + distance, 0);
for (let step = 1; step <= warmupSteps; step++) world.step(start + step * CONFIG.step);
const movementBefore = new Map(Object.entries(world.data.travel).map(([id, travel]) => [id, movement(travel)]));

const times = [];
for (let step = 1; step <= measuredSteps; step++) {
  const now = start + (warmupSteps + step) * CONFIG.step;
  const begin = performance.now();
  world.step(now);
  times.push(performance.now() - begin);
  assert.equal(world.data.tick, now);
}

const after = verify(world, start + (warmupSteps + measuredSteps) * CONFIG.step);
const moved = Object.entries(world.data.travel).filter(([id, travel]) => movement(travel) > movementBefore.get(id)).length;
assert(moved > 0, 'No fish moved during the measured steps');
const copyStart = performance.now();
const snapshot = world.serialize();
const snapshotCopyMs = performance.now() - copyStart;
assert.equal(Object.keys(snapshot.breeding).length, after.active + after.cancelled + after.born);
const breedingJsonBytes = Buffer.byteLength(JSON.stringify(snapshot.breeding));
const state = JSON.stringify(world.data, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
  : value);
const sorted = [...times].sort((a, b) => a - b), middle = (sorted.length - 1) / 2;
const median = (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
console.log(JSON.stringify({
  node: process.version,
  seed,
  start,
  fixture: 'Synthetic history generated by the breeding rules. Retired fish keep origins and birth records. Their bodies and unrelated history are omitted.',
  layout: fixedRegions ? 'Fixed sea and placement regions. More fish increase density. Singles are separated by gender to keep new pairs out of the measured steps.' : 'Original placement',
  before,
  after,
  warmup_steps: warmupSteps,
  measured_steps: times.length,
  step_ms: { min: sorted[0], median, p95: sorted[Math.ceil(.95 * sorted.length) - 1], max: sorted.at(-1), samples: times },
  snapshot_copy_ms: snapshotCopyMs,
  breeding_json_bytes: breedingJsonBytes,
  moved_fish: moved,
  state_sha256: createHash('sha256').update(state).digest('hex')
}, null, 2));
