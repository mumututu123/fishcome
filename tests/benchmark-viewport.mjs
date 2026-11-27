import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ViewportCells } from '../www/viewport.js';

const { values } = parseArgs({ options: { reference: { type: 'string' } } });
assert(values.reference, '用 --reference=原版工作区 指定旧视口实现');
const { ViewportCells: Reference } = await import(pathToFileURL(resolve(values.reference, 'www/viewport.js')));
const count = 256, steps = 48, rounds = 5;
const initial = { chars: {}, fishes: {}, scenes: {} };
for (let i = 0; i < count; i++) {
  const id = String(i);
  initial.fishes[id] = { x: i * 37 % 1000, y: i * 11 % 85, facing: 1 };
  for (let j = 0; j < 9; j++) {
    const key = id + '-' + j;
    initial.chars[key] = { id: key, entity: id, kind: 'fish', x: j % 3 - 1, y: Math.floor(j / 3) - 1 };
  }
}
function measure(Index) {
  const data = structuredClone(initial), index = new Index(data);
  const place = index.place.bind(index);
  let placements = 0, ms = 0;
  index.place = entry => { placements++; place(entry); };
  for (let step = 1; step <= steps; step++) {
    const set = Object.entries(data.fishes).map(([id, fish]) => {
      const x = (fish.x + 1) % 1000, facing = (step + Number(id)) % 7 ? fish.facing : -fish.facing;
      return [id, data.fishes[id] = { ...fish, x, facing }];
    });
    const start = performance.now();
    index.update({ fishes: { remove: [], set } });
    ms += performance.now() - start;
  }
  const sectors = [];
  for (let y = 0; y < 96; y += 32) for (let x = 0; x < 1000; x += 32) {
    sectors.push(index.query(x, x, y, y).map(cell => cell.id));
  }
  return { ms, placements, sectors };
}
let placements;
const times = [[], []];
for (let round = 0; round <= rounds; round++) {
  const pair = [];
  for (const i of round % 2 ? [0, 1] : [1, 0]) pair[i] = measure([Reference, ViewportCells][i]);
  assert.deepEqual(pair[0].sectors, pair[1].sectors);
  placements = pair.map(result => result.placements);
  if (round) pair.forEach((result, i) => times[i].push(Number(result.ms.toFixed(2))));
}
console.log(JSON.stringify({ fish: count, steps, rounds, placements, beforeMs: times[0], afterMs: times[1] }));
