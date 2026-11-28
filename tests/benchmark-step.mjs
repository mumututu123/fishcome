import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  checkpoint: { type: 'string' }, source: { type: 'string' }, reference: { type: 'string' }, fish: { type: 'string' },
  'resume-at': { type: 'string' }, 'reference-paths': { type: 'boolean' },
  budget: { type: 'string' }, samples: { type: 'boolean' }, pace: { type: 'boolean' }, 'delivery-control': { type: 'boolean' },
  steps: { type: 'string', default: '24' }, warmup: { type: 'string', default: '6' }, help: { type: 'boolean' }
} });
if (values.help) {
  console.log('用法：node tests/benchmark-step.mjs [--steps=24] [--warmup=6] [--fish=5000 | --checkpoint=备份.json] [--source=被测工作区] [--reference=原版工作区] [--budget=20] [--samples] [--pace]');
  console.log('--resume-at=含时区的时间 从备份恢复到指定时刻，保留离线期间到期的自然事件；默认按备份本身的时刻复播。');
  console.log('--delivery-control 增跑空消息和预计算整步的独立交付对照。20 毫秒验收仍按正常生态步计时。');
  console.log('--reference-paths 同时比对参考版本的逐鱼游动路径，适用于游动展示规则相同的版本。');
  process.exit(0);
}
const steps = Number(values.steps), warmup = Number(values.warmup), fish = Number(values.fish ?? 5000);
const budget = Number(values.budget ?? 20);
assert(Number.isFinite(budget) && budget > 0);
assert(Number.isSafeInteger(steps) && steps > 0, '--steps 必须为正整数');
assert(Number.isSafeInteger(warmup) && warmup >= 0, '--warmup 必须为非负整数');
assert(Number.isSafeInteger(fish) && fish > 0 && fish <= 5500, '--fish 必须介于 1 和 5500');
assert(!(values.checkpoint && values.fish), '--checkpoint 与 --fish 只选一个');
const resumeAt = values['resume-at'] === undefined ? undefined : Date.parse(values['resume-at']);
assert(resumeAt === undefined || values.checkpoint && Number.isFinite(resumeAt) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(values['resume-at']), '--resume-at 需要真实备份和含时区的有效日期');

let checkpoint;
if (values.checkpoint) {
  const input = JSON.parse(await readFile(values.checkpoint, 'utf8'));
  const world = input.checkpoint?.world ?? input.world ?? input;
  assert(world?.protocol === 1 && Number.isFinite(world.tick) && world.fishes && world.chars, '文件没有可读取的鱼来世界');
  const archiveChunks = Object.fromEntries(Object.keys(world.archives?.chunks || {}).map(id => [id, input.archiveChunks?.[id]]));
  checkpoint = { world, archiveChunks, lastOnlineAt: input.checkpoint?.lastOnlineAt ?? input.lastOnlineAt ?? world.tick, resumeAt };
}
const www = values.source ? resolve(values.source, 'www') : fileURLToPath(new URL('../www', import.meta.url));
const reference = values.reference ? resolve(values.reference, 'www') : www;
const capacityFish = new URL('./capacity-fish.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TIDE_TEST_MODULES ? resolve(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8').end('<!doctype html><title>世界生态性能检查</title>');
    return;
  }
  const asset = request.url === '/capacity-fish.mjs' ? capacityFish
    : /^\/reference\/[a-z0-9-]+\.js$/.test(request.url) ? resolve(reference, request.url.slice('/reference/'.length))
    : request.url === '/measured-worker.mjs' ? new URL('./measured-worker.mjs', import.meta.url)
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
  const report = await page.evaluate(async ({ checkpoint, fish, steps, warmup, budget, separateReference, referencePaths, samples, pace, deliveryControl }) => {
    const { World, CONFIG } = await import('/engine.js');
    const { SimulationClient, subscribeSimulationChanges } = await import('/simulation-client.js');
    const { ArchiveStore } = await import('/archive.js');
    const { World: ReferenceWorld } = separateReference ? await import('/reference/engine.js') : { World };
    const archives = new ArchiveStore();
    let ecology;
    if (checkpoint) {
      const { restoreCheckpoint } = separateReference ? await import('/reference/lifecycle.js') : await import('/lifecycle.js');
      const { loadReplicaArchives } = await import('/replica.js');
      const { world, archiveChunks, lastOnlineAt, resumeAt } = checkpoint;
      await loadReplicaArchives(world, archives, id => archiveChunks[id]);
      const restored = restoreCheckpoint({ world, lastOnlineAt: resumeAt === undefined ? world.tick : lastOnlineAt }, resumeAt ?? world.tick);
      if (restored.expired) throw new Error('指定时间已超出这片海的离线寿命，无法以此存档验证原鱼群');
      ecology = restored.world;
    } else {
      const { makeFishWorld } = await import('/capacity-fish.mjs');
      const body = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), ch: i === 3 ? 'o' : '鱼', color: '#8be7df' }));
      ecology = makeFishWorld(ReferenceWorld, fish, CONFIG.width, {
        now: Date.UTC(2025, 5, 15, 12, 17), body, spacingX: 4, spacingY: 3, rows: 22, mixedGenders: true
      });
    }
    const start = ecology.data.tick;
    ecology.attachArchives(archives);
    function copyWorld() {
      const world = new World(start, undefined, { populate: false });
      world.data = structuredClone(ecology.data);
      world.attachArchives(archives);
      return world;
    }
    const initial = { fish: Object.keys(ecology.data.fishes).length, cells: Object.keys(ecology.data.chars).length,
      archiveChunks: Object.keys(ecology.data.archives?.chunks || {}).length };

    function mismatch(path) { throw new Error('两条生态入口的结果不同 ' + path.join('.')); }
    function compare(a, b, path) {
      if (Object.is(a, b)) return;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) mismatch(path);
      if (Array.isArray(a) && a.length !== b.length) mismatch(path);
      const keys = Object.keys(a), other = Object.keys(b);
      if (keys.length !== other.length) mismatch(path);
      const field = path.at(-1);
      if (['chars', 'fishes', 'contacts', 'bonds', 'stories'].includes(field) || path.includes('bonds')) {
        if (keys.some((key, i) => key !== other[i])) mismatch([...path, '顺序']);
      }
      for (const key of keys) {
        path.push(key);
        if (!Object.hasOwn(b, key)) mismatch(path);
        compare(a[key], b[key], path);
        path.pop();
      }
    }
    const rounded = ms => Math.round(ms * 10) / 10;
    function stats(times) {
      const sorted = [...times].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return { median: rounded(median), p95: rounded(sorted[Math.ceil(sorted.length * .95) - 1]),
        max: rounded(sorted.at(-1)), overBudget: times.filter(ms => ms > budget).length };
    }

    let receivedAt, workerTimes;
    const simulation = new SimulationClient(() => {
      const worker = new Worker('/measured-worker.mjs', { type: 'module' });
      worker.addEventListener('message', event => {
        receivedAt = performance.now();
        workerTimes = event.data.result?.measurement;
      });
      return worker;
    });
    const ecologies = [], roundTrips = [];
    const phases = { workerRules: [], workerOther: [], deliveryAndDispatch: [], mainCommit: [] };
    const committed = copyWorld();
    const openStart = performance.now();
    let workerOpenMs;
    try {
      if (!await simulation.open(committed, () => true)) throw new Error('后台模拟未初始化');
      workerOpenMs = performance.now() - openStart;
      const first = performance.now();
      for (let i = 1; i <= warmup + steps; i++) {
        const now = start + i * CONFIG.step;
        if (pace) {
          const wait = first + (i - 1) * CONFIG.step - performance.now();
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        const at = performance.now();
        await simulation.advance(committed, now);
        const end = performance.now();
        if (committed.data.tick !== now || workerTimes?.tick !== now) throw new Error(`第 ${i} 步没有提交`);
        if (i <= warmup) continue;
        roundTrips.push(end - at);
        phases.workerRules.push(workerTimes.rules);
        phases.workerOther.push(workerTimes.handle - workerTimes.rules);
        phases.deliveryAndDispatch.push(receivedAt - at - workerTimes.handle);
        phases.mainCommit.push(end - receivedAt);
      }
    } finally { simulation.close(); }

    let deliveryControlMs;
    if (deliveryControl) {
      const control = copyWorld(), client = new SimulationClient(() => new Worker('/measured-worker.mjs', { type: 'module' }));
      const ping = [], compute = [], deliver = [];
      try {
        await client.open(control, () => true);
        const first = performance.now();
        for (let i = 1; i <= warmup + steps; i++) {
          const due = first + (i - 1) * CONFIG.step, tick = start + i * CONFIG.step;
          if (pace && due > performance.now()) await new Promise(resolve => setTimeout(resolve, due - performance.now()));
          const at = performance.now();
          const reply = await client.request({ kind: 'delivery-ping' });
          const pingMs = performance.now() - at;
          if (reply.tick !== control.data.tick) throw new Error('空消息返回的世界步不符');
          const prepared = await client.request({ kind: 'prepare-delivery', base: control.data.tick });
          const ready = performance.now();
          await client.advance(control, tick);
          const delivered = performance.now() - ready;
          if (control.data.tick !== tick) throw new Error('预计算对照没有交付当前步');
          if (i > warmup) { ping.push(pingMs); compute.push(prepared.elapsed); deliver.push(delivered); }
        }
        compare(committed.data, control.data, ['预计算对照的最终世界']);
        compare(committed.foodRevision, control.foodRevision, ['预计算对照的进食版本']);
        deliveryControlMs = { emptyRoundTrip: stats(ping), prepareFullStep: stats(compute), deliverPreparedStep: stats(deliver) };
      } finally { client.close(); }
    }

    // Run the full reference replay separately so its snapshots, allocations and
    // deep comparisons cannot stall a timed callback on the UI thread.
    const replay = copyWorld(), verified = new SimulationClient();
    // Older rules can clear every visual path when just one body changes.
    // Compare persisted state with the requested reference and display paths
    // with the current public simulation, independent of the worker and UI.
    const pathWorld = separateReference && !referencePaths ? copyWorld() : ecology;
    let patches = 0, workerSwims;
    const unsubscribe = subscribeSimulationChanges((world, patch) => {
      if (world === replay && patch && Number.isFinite(patch.values.tick)) { patches++; workerSwims = patch.swims; }
    });
    try {
      if (!await verified.open(replay, () => true)) throw new Error('复核模拟未初始化');
      for (let i = 1; i <= warmup + steps; i++) {
        const now = start + i * CONFIG.step, swims = [], at = performance.now();
        ecology.step(now, pathWorld === ecology ? swims : []);
        if (i > warmup) ecologies.push(performance.now() - at);
        if (pathWorld !== ecology) pathWorld.step(now, swims);
        await verified.advance(replay, now);
        if (replay.data.tick !== now || patches !== i) throw new Error(`第 ${i} 步复核时没有提交`);
        compare(ecology.data, replay.data, [`第 ${i} 步`]);
        compare(ecology.foodRevision, replay.foodRevision, [`第 ${i} 步`, 'foodRevision']);
        compare(swims, workerSwims || [], [`第 ${i} 步`, 'swims']);
      }
      compare(committed.data, replay.data, ['计时与独立复核的最终世界']);
      if (pathWorld !== ecology) compare(pathWorld.data, ecology.data, ['画面路径与原规则的最终世界']);
      return { initial, steps, warmup, paced: pace, ...(checkpoint?.resumeAt === undefined ? {} : { resumeAt: checkpoint.resumeAt }), checkedSteps: patches, stepIntervalMs: CONFIG.step, workerOpenMs: rounded(workerOpenMs),
        ...(samples ? { samples: roundTrips.map((wall, i) => ({
          total: rounded(wall), ...Object.fromEntries(Object.entries(phases).map(([phase, times]) => [phase, rounded(times[i])]))
        })) } : {}),
        budgetMs: budget, ecologyMs: stats(ecologies), workerSubmitMs: stats(roundTrips),
        phaseMs: Object.fromEntries(Object.entries(phases).map(([phase, times]) => [phase, stats(times)])), deliveryControlMs };
    } finally { unsubscribe(); verified.close(); }
  }, { checkpoint, fish, steps, warmup, budget, separateReference: !!values.reference, referencePaths: values['reference-paths'], samples: values.samples, pace: !!values.pace, deliveryControl: values['delivery-control'] });
  assert.deepEqual(errors, []);
  assert.equal(workers, values['delivery-control'] ? 3 : 2, '计时、交付对照和状态复核应使用各自的后台线程');
  console.log(JSON.stringify({ browser: browser.version(), sample: checkpoint ? 'checkpoint' : 'generated', ...report }, null, 2));
  if (values.budget !== undefined) assert.equal(report.workerSubmitMs.overBudget, 0, '有完整生态步超过指定耗时');
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
