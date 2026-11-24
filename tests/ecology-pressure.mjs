import { World, CONFIG, chooseClaim } from '../www/engine.js';
import { newEcology } from '../www/ecology.js';
import { newLife, spawnPlankton, LIFE } from '../www/life.js';
import { ARCHIVE, ArchiveStore, archivePlan, archiveChunks, compactKnown, emptyArchiveState } from '../www/archive.js';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const hours = 30 * 24, start = Math.floor((Date.now() - hours * 3600000) / 3600000) * 3600000, w = new World(start, undefined, { populate: false });
w.data.ecology = newEcology(start); w.data.life = newLife(start); w.data.archives = emptyArchiveState(start); const store = new ArchiveStore(), samples = [], timings = [];
w.attachArchives(store);
// A deterministic resource-pressure fixture: 100 continuing actors earn and spend 1/hour.
// This probes hourly ecology/archiving, not continuous swimming or 100 actual browsers.
for (let hour = 1; hour <= hours; hour++) {
  const at = start + hour * 3600000;
  for (let i = 0; i < 100; i++) {
    const actor = `pressure-${i}`, earn = `${actor}:hour:${hour}`, id = crypto.randomUUID(), x = (hour * 17 + i * 9) % 1000;
    w.data.ops[earn] = { id: earn, actor, nick: actor, roots: w.roots, t: at, kind: 'earn', serial: hour, cost: 0 }; w.data.ops[id] = { id, actor, nick: actor, roots: w.roots, t: at - CONFIG.foodLife, kind: 'food', cost: 1, ch: '食', color: '#ffffff', x, y: 0 };
    w.data.chars[id] = { id, payer: actor, ch: '食', color: '#ffffff', kind: 'food', entity: '', x, y: w.floorAt(x) - 1, born: at - CONFIG.foodLife, created: at - CONFIG.foodLife, fall: 0, path: [] }; w.data.participants[actor] = actor;
  }
  for (let slot = at - 3600000; slot < at; slot += LIFE.weatherPeriod) spawnPlankton(w, slot);
  const before = performance.now(); w.step(at); timings.push(performance.now() - before);
  if (hour % 24 === 0) {
    const plan = archivePlan(w.data, at, { pressure: Buffer.byteLength(JSON.stringify(w.data)) >= ARCHIVE.threshold }), chunks = await archiveChunks(plan, w.data.roots);
    for (const chunk of chunks) { await store.ingest(chunk, chooseClaim); w.data.archives.chunks[chunk.manifest.id] = chunk.manifest; }
    await compactKnown(w, store); w.data.archives.at = at;
    const characters = Object.values(w.data.chars), sample = { day: hour / 24, seaweed: characters.filter(c => c.kind === 'seaweed').length, sediment: characters.filter(c => c.kind === 'scene').length, hotCharacters: characters.length, hotOps: Object.keys(w.data.ops).length, archives: Object.keys(w.data.archives.chunks).length, bytes: Buffer.byteLength(JSON.stringify(w.serialize())) };
    assert(sample.hotCharacters <= 100000); assert.equal(w.wallet('pressure-0'), 20); samples.push(sample);
    if (hour % (5 * 24) === 0) console.log(`生态压力第 ${hour / 24} 天：海草 ${sample.seaweed}，沉积 ${sample.sediment}，日常字符 ${sample.hotCharacters}`);
  }
}
timings.sort((a, b) => a - b); const result = { mode: '30-day hourly ecological pressure with 100 food glyphs/hour; no real browsers or continuous fish motion', samples, stepMs: { median: timings[Math.floor(timings.length / 2)], p95: timings[Math.floor(timings.length * .95)], max: timings.at(-1) } };
mkdirSync(new URL('../test-output/', import.meta.url), { recursive: true }); writeFileSync(new URL('../test-output/ecology-pressure.json', import.meta.url), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ final: samples.at(-1), stepMs: result.stepMs }, null, 2));
