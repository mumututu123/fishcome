import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  checkpoint: { type: 'string' }, source: { type: 'string' }, fish: { type: 'string' },
  steps: { type: 'string', default: '24' }, warmup: { type: 'string', default: '6' }, help: { type: 'boolean' }
} });
if (values.help) {
  console.log('用法：node tests/benchmark-step.mjs [--steps=24] [--warmup=6] [--fish=5000 | --checkpoint=备份.json] [--source=另一工作区]');
  process.exit(0);
}
const steps = Number(values.steps), warmup = Number(values.warmup), fish = Number(values.fish ?? 5000);
assert(Number.isSafeInteger(steps) && steps > 0, '--steps 必须为正整数');
assert(Number.isSafeInteger(warmup) && warmup >= 0, '--warmup 必须为非负整数');
assert(Number.isSafeInteger(fish) && fish > 0 && fish <= 5500, '--fish 必须介于 1 和 5500');
assert(!(values.checkpoint && values.fish), '--checkpoint 与 --fish 只选一个');

let checkpoint;
if (values.checkpoint) {
  const input = JSON.parse(await readFile(values.checkpoint, 'utf8'));
  const world = input.checkpoint?.world ?? input.world ?? input;
  assert(world?.protocol === 1 && Number.isFinite(world.tick) && world.fishes && world.chars, '文件没有可读取的鱼来世界');
  const archiveChunks = Object.fromEntries(Object.keys(world.archives?.chunks || {}).map(id => [id, input.archiveChunks?.[id]]));
  checkpoint = { world, archiveChunks };
}
const www = values.source ? resolve(values.source, 'www') : fileURLToPath(new URL('../www', import.meta.url));
const capacityFish = new URL('./capacity-fish.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TIDE_TEST_MODULES ? resolve(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8').end('<!doctype html><title>世界生态性能检查</title>');
    return;
  }
  const asset = request.url === '/capacity-fish.mjs' ? capacityFish
    : /^\/[a-z0-9-]+\.js$/.test(request.url) ? resolve(www, request.url.slice(1)) : null;
  if (!asset) { response.writeHead(404).end(); return; }
  try { response.setHeader('content-type', 'text/javascript; charset=utf-8').end(await readFile(asset)); }
  catch { response.writeHead(404).end(); }
});

let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.TIDE_TEST_BROWSER ? { executablePath: process.env.TIDE_TEST_BROWSER } : {}) });
  const page = await browser.newPage();
  let workers = 0;
  const errors = [];
  page.on('worker', () => workers++);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report = await page.evaluate(async ({ checkpoint, fish, steps, warmup }) => {
    const { World, CONFIG } = await import('/engine.js');
    const { SimulationClient, subscribeSimulationChanges } = await import('/simulation-client.js');
    const { ArchiveStore } = await import('/archive.js');
    const archives = new ArchiveStore();
    let ecology;
    if (checkpoint) {
      const { restoreCheckpoint } = await import('/lifecycle.js');
      const { loadReplicaArchives } = await import('/replica.js');
      const { world, archiveChunks } = checkpoint;
      await loadReplicaArchives(world, archives, id => archiveChunks[id]);
      ecology = restoreCheckpoint({ world, lastOnlineAt: world.tick }, world.tick).world;
    } else {
      const { makeFishWorld } = await import('/capacity-fish.mjs');
      const body = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), ch: i === 3 ? 'o' : '鱼', color: '#8be7df' }));
      ecology = makeFishWorld(World, fish, CONFIG.width, {
        now: Date.UTC(2025, 5, 15, 12, 17), body, spacingX: 4, spacingY: 3, rows: 22, mixedGenders: true
      });
    }
    const start = ecology.data.tick;
    const committed = new World(start, undefined, { populate: false });
    committed.data = structuredClone(ecology.data);
    for (const world of [ecology, committed]) world.attachArchives(archives);
    const initial = { fish: Object.keys(ecology.data.fishes).length, cells: Object.keys(ecology.data.chars).length,
      archiveChunks: Object.keys(ecology.data.archives?.chunks || {}).length };

    function mismatch(path) { throw new Error('两条生态入口的结果不同 ' + path.join('.')); }
    function compare(a, b, path) {
      if (Object.is(a, b)) return;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) mismatch(path);
      if (Array.isArray(a) && a.length !== b.length) mismatch(path);
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) mismatch(path);
      for (const key of keys) {
        path.push(key);
        if (!Object.hasOwn(b, key)) mismatch(path);
        compare(a[key], b[key], path);
        path.pop();
      }
    }
    const rounded = ms => Math.round(ms * 10) / 10;
    function stats(times) {
      const sorted = times.sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return { median: rounded(median), p95: rounded(sorted[Math.ceil(sorted.length * .95) - 1]), max: rounded(sorted.at(-1)) };
    }

    const simulation = new SimulationClient();
    const ecologies = [], roundTrips = [];
    let patches = 0, workerSwims;
    const unsubscribe = subscribeSimulationChanges((world, patch) => {
      if (world === committed && patch && Number.isFinite(patch.values.tick)) { patches++; workerSwims = patch.swims; }
    });
    try {
      const openStart = performance.now();
      if (!await simulation.open(committed, () => true)) throw new Error('后台模拟未初始化');
      const workerOpenMs = performance.now() - openStart;
      for (let i = 1; i <= warmup + steps; i++) {
        const now = start + i * CONFIG.step, swims = [];
        let ecologyMs, workerMs;
        const direct = () => {
          const at = performance.now();
          ecology.step(now, swims);
          ecologyMs = performance.now() - at;
        };
        const background = async () => {
          const at = performance.now();
          await simulation.advance(committed, now);
          workerMs = performance.now() - at;
        };
        if (i % 2) { direct(); await background(); } else { await background(); direct(); }
        if (committed.data.tick !== now || patches !== i) throw new Error(`第 ${i} 步没有提交`);
        compare(ecology.data, committed.data, [`第 ${i} 步`]);
        compare(ecology.foodRevision, committed.foodRevision, [`第 ${i} 步`, 'foodRevision']);
        compare(swims, workerSwims || [], [`第 ${i} 步`, 'swims']);
        if (i > warmup) { ecologies.push(ecologyMs); roundTrips.push(workerMs); }
      }
      return { initial, steps, warmup, checkedSteps: patches, stepIntervalMs: CONFIG.step, workerOpenMs: rounded(workerOpenMs),
        ecologyMs: stats(ecologies), workerSubmitMs: stats(roundTrips) };
    } finally { unsubscribe(); simulation.close(); }
  }, { checkpoint, fish, steps, warmup });
  assert.deepEqual(errors, []);
  assert.equal(workers, 1, '测量期间应只有一个真实 Worker');
  console.log(JSON.stringify({ browser: browser.version(), sample: checkpoint ? 'checkpoint' : 'generated', ...report }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
