import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [file, reference, candidate = '.'] = process.argv.slice(2);
if (!file || !reference) throw new Error('Usage: node scripts/replay-swimming.mjs <backup.json> <reference checkout> [candidate checkout]');
const backup = JSON.parse(await readFile(file));
const initial = backup.checkpoint?.world ?? backup.world;
const lastOnlineAt = backup.checkpoint?.lastOnlineAt ?? backup.lastOnlineAt ?? initial.tick;
const scenarios = [
  { name: 'ordinary', start: 1795859990000, steps: 72 },
  { name: 'hour', start: 1795867190136, steps: 36 },
  { name: 'wrapped', start: 1795859990000, steps: 20 },
  { name: 'fractional', start: 1795859990000, steps: 20 },
  { name: 'fed', start: 1795859990000, steps: 20 }
];

function setScenario(world, name) {
  const fish = Object.values(world.data.fishes);
  if (name === 'wrapped') {
    fish[0].x += 3000;
    fish[1].x -= 2000;
    fish[2].x = Number.MAX_SAFE_INTEGER - 2099;
    fish[3].y = -0;
  }
  if (name === 'fractional') fish[0].x += 0.25;
  if (name === 'fed') for (const resident of fish) {
    resident.lastFed = resident.lastMealAt = world.data.tick;
    resident.hungerAt = world.data.tick + 86400000;
  }
}

async function replay(checkout, scenario) {
  const load = name => import(pathToFileURL(resolve(checkout, 'www', name + '.js')).href);
  const [{ ArchiveStore }, { loadReplicaArchives }, { restoreCheckpoint }, { CONFIG },
    { SimulationClient, subscribeSimulationChanges }, { WorkerSimulation }] = await Promise.all(
    ['archive', 'replica', 'lifecycle', 'engine', 'simulation-client', 'simulation-worker'].map(load));
  const archive = new ArchiveStore();
  await loadReplicaArchives(initial, archive, id => backup.archiveChunks[id]);
  const restored = restoreCheckpoint({ world: structuredClone(initial), lastOnlineAt }, scenario.start);
  assert(!restored.expired);
  const { world } = restored;
  world.attachArchives(archive);
  setScenario(world, scenario.name);
  const controller = new WorkerSimulation();
  const client = new SimulationClient(() => ({
    postMessage(message) { setImmediate(() => this.onmessage({ data: { result: structuredClone(controller.receive(structuredClone(message))) } })); },
    terminate() {}
  }));
  let patch;
  const unsubscribe = subscribeSimulationChanges((target, change) => {
    if (target === world && Number.isFinite(change?.values.tick)) patch = change;
  });
  const hashes = [], times = [];
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    await client.open(world, () => true);
    for (let i = 0; i < scenario.steps; i++) {
      const tick = world.data.tick + CONFIG.step, before = performance.now();
      await client.advance(world, tick);
      times.push(performance.now() - before);
      assert.equal(world.data.tick, tick);
      assert.equal(patch?.values.tick, tick);
      hashes.push({ tick, world: hash(world.data), travel: hash(world.data.travel), swims: hash(patch.swims ?? null), foodRevision: world.foodRevision });
    }
  } finally {
    unsubscribe();
    client.close();
  }
  return { hashes, times };
}

for (const scenario of scenarios) {
  const expected = await replay(reference, scenario);
  const actual = await replay(candidate, scenario);
  for (let i = 0; i < scenario.steps; i++) {
    assert.deepEqual(actual.hashes[i], expected.hashes[i], scenario.name + ' diverged at ' + expected.hashes[i].tick);
  }
  const peak = sample => Math.max(...sample.times.slice(12)).toFixed(2);
  console.log(scenario.name + ' matched all ' + scenario.steps + ' steps. Worker and commit max (ms) ' + peak(expected) + ' -> ' + peak(actual));
}
