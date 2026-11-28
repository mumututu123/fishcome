const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const { unpackZip, launcherName, withReleaseFixtures } = require('./release-fixtures.cjs');
const { recordDraw, frameSummary, startTrace, readPresentations } = require('./browser-refresh-budget.cjs');

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  profile: { type: 'string' }, source: { type: 'string' }, seconds: { type: 'string', default: '10' },
  'full-updates': { type: 'string' }, drop: { type: 'boolean' }, 'drop-steps': { type: 'string' }, help: { type: 'boolean' },
  backup: { type: 'string' }, trace: { type: 'string' }, report: { type: 'string' }, 'refresh-budget': { type: 'boolean' },
  'archive-rounds': { type: 'string', default: '0' }, 'plain-live': { type: 'string' },
  'forget-live-base': { type: 'boolean' }, 'switch-leader': { type: 'boolean' }, 'rebuild-viewport': { type: 'boolean' },
  'step-boundaries-only': { type: 'boolean' }
} });
if (values.help) {
  console.log('用法：node tests/browser-dense-peers.cjs [鱼数] [--seconds=35] [--full-updates=0|1] [--drop] [--profile=跟随端.cpuprofile]');
  console.log('默认使用仓库发行构建工具，临时构建两套启动器。也可用 TIDE_DENSE_LAUNCHER_A 和 TIDE_DENSE_LAUNCHER_B 指定两套隔离的启动器，另以 --source=对照工作区指定网页来源。');
  console.log('--drop 蓄意漏发一个已提交的半秒更新，检查后续能否继续同步。');
  console.log('--drop --drop-steps=3 连续漏发三步，检查下一次更新能否一起补全。');
  console.log('--backup=本地存档 使用真实存档和归档；--trace=本地跟踪文件 记录浏览器呈现；--report=汇总文件 保存验收数据；--refresh-budget 严格检查每次刷新不超过 20 毫秒（需 --trace）。');
  console.log('--archive-rounds=3 在观测期间连续生成并同步 3 个新归档包（需 --backup）。');
  console.log('--plain-live=A|B|both 模拟不支持紧凑发送的端；--forget-live-base 模拟跟随端遗失上一版本；--switch-leader 在观测后切换协调端。');
  console.log('--rebuild-viewport 用接收端旧的整表画面索引方式对照。');
  console.log('--step-boundaries-only 关闭各阶段的细分计时，保留请求、提交和呈现时间，用于对照观测开销。');
  process.exit(0);
}
const backup = values.backup && JSON.parse(readFileSync(values.backup, 'utf8'));
const count = backup ? Object.keys(backup.world.fishes).length : Number(positionals[0] || 120);
const seconds = Number(values.seconds);
const expectedFull = values['full-updates'] === undefined ? undefined : Number(values['full-updates']);
const archiveRounds = Number(values['archive-rounds']);
const dropSteps = Number(values['drop-steps'] ?? 1);
assert(Number.isSafeInteger(dropSteps) && dropSteps >= 1 && dropSteps <= 3 && (!values['drop-steps'] || values.drop));
assert(positionals.length < 2 && Number.isSafeInteger(count) && count >= 2 && count <= 5500);
assert(Number.isSafeInteger(seconds) && seconds >= 6 && seconds <= 90);
assert(expectedFull === undefined || Number.isSafeInteger(expectedFull) && expectedFull >= 0);
assert(!backup || !positionals.length, '使用真实存档时，鱼数从存档读取');
assert(!values['refresh-budget'] || values.trace, '严格验收需要记录浏览器呈现');
assert(Number.isSafeInteger(archiveRounds) && archiveRounds >= 0 && archiveRounds <= seconds / 2 && (!archiveRounds || backup), '归档轮次须为非负整数，每轮至少预留两秒，写新归档需要真实存档');
assert(!values['plain-live'] || ['A', 'B', 'both'].includes(values['plain-live']), '--plain-live 应为 A、B 或 both');
assert(!values['forget-live-base'] || !values['plain-live'], '遗失基准测试需要两端支持紧凑发送');
const launchers = [process.env.TIDE_DENSE_LAUNCHER_A, process.env.TIDE_DENSE_LAUNCHER_B];
assert(!launchers.some(Boolean) || launchers.every(Boolean) && path.dirname(launchers[0]) !== path.dirname(launchers[1]), '请指定两个独立临时目录中的启动器');
assert(!values.source || launchers.every(Boolean), '--source 需要相同规则的显式启动器');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const www = values.source ? path.resolve(values.source, 'www') : path.resolve(__dirname, '../www');
const browsers = [], children = [], observed = [], errors = [];
const phaseModules = {
  '/archive.js': { compactKnown: '' },
  '/replica.js': { verifyReplica: 'args[3]?.context' },
  '/storage.js': { putMany: '' },
  '/simulation-delta.js': { expandSimulationPatch: 'args[1].values.tick' },
  '/checkpoint-pages.js': { beforeCheckpointPatch: 'args[1].values.tick', noteCheckpointChanges: 'args[1]?.values.tick' },
  '/world-broadcast.js': { captureStep: 'args[0].tick' },
  '/replica-row-delta.js': { encodeReplicaRowDelta: 'args[0].world.tick' }
};
const observeCommit = `
const reportApplied = simulationApplied;
simulationApplied = (world, patch) => {
  globalThis.denseCommitted?.(world, patch, performance.timeOrigin + performance.now());
  return reportApplied(world, patch);
};
`;
const observeReplicaPages = `
const sendLivePacket = ReplicaTransfers.prototype.sendLivePacket;
ReplicaTransfers.prototype.sendLivePacket = async function (peer, lane, body) {
  const startAt = Date.now(), start = performance.now();
  const id = await sendLivePacket.call(this, peer, lane, body);
  window.denseLiveTransfers.push({ tick: body.world.tick, compact: Boolean(body.rowBase), resent: !id, startAt,
    at: Date.now(), ms: performance.now() - start });
  return id;
};
const receivePage = ReplicaTransfers.prototype.receive;
ReplicaTransfers.prototype.receive = async function (message, peer) {
  if (window.denseForgetArmed && message.body.kind === 'live' && message.body.index === 0 &&
      message.body.text.split('\\n', 1)[0].includes('"rowBase":')) {
    this.rowsReceived.delete(peer);
    window.denseForgetArmed = false;
  }
  const state = this.incoming.get(message.from + ':' + message.body.id);
  const next = state?.next, end = state?.endIndex;
  try { return await receivePage.call(this, message, peer); }
  catch (error) {
    window.denseReplicaFailures.push({ kind: message.body.kind, index: message.body.index, last: message.body.last,
      next, end, error: error.message });
    throw error;
  }
};
`;
const observeFirstReplicaPage = `
const measuredPages = replicaPages;
replicaPages = function* (body, frame) {
  const pages = measuredPages(body, frame);
  const first = window.denseObserve('replicaFirstPage', pages.next, pages, [], body.world.tick);
  if (!first.done) yield first.value;
  yield* pages;
};
`;
const instrument = `
const testData = { frames: [], steps: [], stepRequests: [], applied: [], sends: [], receives: [], merges: [], worldMerges: [], repairs: [], saves: [], liveBytes: [] };
const stepRequests = new WeakMap();
const originalRequest = SimulationClient.prototype.request;
SimulationClient.prototype.request = function (message) {
  if (message.kind !== 'step') return originalRequest.call(this, message);
  const sequence = testData.stepRequests.length;
  if (${Boolean(values.trace)}) {
    const name = 'tide.request.' + window.densePage + '.' + sequence;
    performance.mark(name);
    performance.clearMarks(name);
  }
  const start = performance.now(), row = { sequence, startAt: performance.timeOrigin + start, tick: message.base + CONFIG.step };
  stepRequests.set(message, { row, start });
  testData.stepRequests.push(row);
  const reply = originalRequest.call(this, message);
  const resolve = this.pending.resolve;
  this.pending.resolve = result => {
    row.reply = performance.now() - start;
    row.rule = result?.ruleTime;
    if (result?.workerTiming) {
      const [entered, leaving] = result.workerTiming;
      row.toWorker = entered - row.startAt;
      row.inWorker = leaving - entered;
      row.fromWorker = row.startAt + row.reply - leaving;
    }
    if (row.rule !== undefined) window.densePhases.push({ phase: 'worker.rules', context: row.tick,
      at: row.startAt + row.reply, total: row.rule, sync: row.rule });
    resolve(result);
  };
  return reply;
};
const originalCompute = SimulationClient.prototype.compute;
SimulationClient.prototype.compute = async function (target, message, ownsWorld) {
  let result;
  try { return result = await originalCompute.call(this, target, message, ownsWorld); }
  finally {
    const request = stepRequests.get(message), end = performance.now();
    if (request) Object.assign(request.row, { ms: end - request.start, committed: Boolean(result && target === world) });
  }
};
const originalOnMessage = onMessage;
onMessage = async (message, peer) => {
  const at = Date.now(), start = performance.now();
  const before = world.data.tick;
  let failed = false;
  try { return await originalOnMessage(message, peer); }
  catch (error) { failed = true; throw error; }
  finally {
    if (['hello', 'merge', 'world', 'archiveChunk'].includes(message.kind)) testData.receives.push({ kind: message.kind,
      tick: message.body.world?.tick, delta: message.body.delta, before, after: world.data.tick,
      ...(message.kind === 'world' && message.body.delta && { rows: Object.fromEntries(['fishes', 'chars', 'breeding', 'contacts', 'travel', 'ops', 'scenes'].map(field => [field, Object.keys(message.body.world[field] || {}).length])) }),
      startAt: at, at: Date.now(), ms: performance.now() - start, failed });
  }
};
const originalMergeReplica = mergeReplica;
mergeReplica = async (...args) => {
  const start = performance.now();
  let failed = false;
  try { return await originalMergeReplica(...args); }
  catch (error) { failed = true; throw error; }
  finally { testData.merges.push({ type: args[2], tick: args[0].tick, ms: performance.now() - start, failed }); }
};
const originalBroadcast = Network.prototype.broadcast;
let lastWorldSent = -Infinity, suppressedTick, dropsRemaining = ${dropSteps};
Network.prototype.broadcast = async function (kind, body, ...args) {
  if (kind === 'replicaRequest') testData.repairs.push({ at: Date.now(), correlated: !!body.request });
  if (kind !== 'world') return originalBroadcast.call(this, kind, body, ...args);
  const at = Date.now();
  if (window.denseDropNext && body.delta && body.world.tick > lastWorldSent && body.world.tick !== suppressedTick) {
    window.denseDropNext = --dropsRemaining > 0;
    suppressedTick = body.world.tick;
    window.denseDropped?.();
    window.denseDropped = null;
  }
  // An archive may publish the same logical step a second time.
  if (body.delta && body.world.tick === suppressedTick) {
    testData.sends.push({ tick: body.world.tick, delta: true, at, done: at, dropped: true });
    return;
  }
  lastWorldSent = Math.max(lastWorldSent, body.world.tick);
  try { return await originalBroadcast.call(this, kind, body, ...args); }
  finally { testData.sends.push({ tick: body.world.tick, delta: body.delta, at, done: Date.now() }); }
};
const originalEncode = Network.prototype.encode;
Network.prototype.encode = async function (message) {
  const encoded = await originalEncode.call(this, message);
  if (message.kind === 'replicaPage' && message.body.kind === 'live') {
    testData.liveBytes.push({ at: Date.now(), bytes: encoded.byteLength + Math.ceil(encoded.byteLength / 16000) * 44 });
  }
  return encoded;
};
const originalSave = save;
save = async (...args) => {
  const tick = world.data.tick, start = performance.now();
  try { return await originalSave(...args); }
  finally { testData.saves.push({ tick, ms: performance.now() - start, at: Date.now() }); }
};
window.denseCommitted = (target, patch, at) => {
  if (target !== world || !Number.isFinite(patch?.values.tick)) return;
  const request = testData.stepRequests.at(-1);
  if (request?.tick === patch.values.tick && request.authority === undefined) request.authority = at - request.startAt;
  (amLeader() ? testData.steps : testData.applied).push({ tick: patch.values.tick, at });
};
for (const [object, method, name] of [
  [World.prototype, 'merge', 'World.merge'], [pictures, 'prepare', 'pictures.prepare'], [renderer, 'cellIndex', 'renderer.cellIndex'],
  [renderer, 'applyMergedChars', 'renderer.applyMergedChars'], [renderer, 'worldChanged', 'renderer.worldChanged'],
  [worldBroadcast, 'send', 'WorldBroadcast.send'], [Network.prototype, 'broadcast', 'Network.broadcast']
]) {
  const original = object[method];
  if (typeof original !== 'function') continue;
  object[method] = function (...args) {
    const previous = method === 'merge' && this === world && this.data.tick;
    if (!previous) {
      const tick = method === 'worldChanged' ? args[1]?.values.tick : method === 'send' ? args[1].tick
        : method === 'broadcast' && args[0] === 'world' ? args[1].world.tick : undefined;
      return window.denseObserve(name, original, this, args, tick);
    }
    const archiveCount = Object.keys(this.data.archives?.chunks || {}).length;
    const start = performance.now(), at = performance.timeOrigin + start;
    const result = window.denseObserve(name, original, this, args), ms = performance.now() - start;
    const [incoming, archived, origin] = args;
    testData.worldMerges.push({ at, ms, before: previous, after: this.data.tick, incomingTick: incoming.tick,
      replicaDelta: origin === 'replica', newArchives: Object.keys(this.data.archives?.chunks || {}).length - archiveCount,
      incomingChars: Object.keys(incoming.chars).length, incomingOps: Object.keys(incoming.ops).length,
      incomingScenes: Object.keys(incoming.scenes).length, incomingBreeding: Object.keys(incoming.breeding || {}).length,
      archiveChars: Object.keys(archived?.chars || {}).length, archiveOps: Object.keys(archived?.ops || {}).length });
    if (previous && !amLeader() && this.data.tick > previous) testData.applied.push({ tick: this.data.tick, at: Date.now() });
    return result;
  };
}
if (${Boolean(values['rebuild-viewport'])}) renderer.applyMergedChars = () => {};
(${recordDraw.toString()})(renderer, testData.frames, window.densePage, ${Boolean(values.trace)});
window.denseSurvey = () => ({ ...testData, node: network?.node, leader: network && leader(), peers: network?.live().length,
  simulationFailure: simulation.failure?.error?.message,
  page: window.densePage, timeOrigin: performance.timeOrigin,
  tick: world.data.tick, fish: Object.keys(world.data.fishes).length, rejected: network?.stats.rejected,
  phases: window.densePhases, longTasks: window.denseLongTasks, replicaFailures: window.denseReplicaFailures,
  liveTransfers: window.denseLiveTransfers,
  logs: diagnostics.list().filter(log => log.level === 'warn' || log.level === 'error').slice(-10) });
window.denseJoinSettled = () => {
  if (!network?.replicaPeers().length) return false;
  const full = testData.receives.filter(row => ['hello', 'merge'].includes(row.kind) || row.kind === 'world' && !row.delta).at(-1);
  return full && Date.now() - full.at >= 800 && !network.replicas.outgoing.size &&
    [...network.replicas.incoming.values()].every(state => state.kind === 'world' || state.kind === 'live');
};
window.denseArchiveRound = async (serial, dropStep) => {
  if (!amLeader()) throw new Error('归档轮次开始时协调端已切换');
  const t = Date.now() - 8 * ARCHIVE.period;
  const op = { id: identity.actor + ':hour:' + serial, actor: identity.actor, nick: identity.nick,
    roots: world.roots, kind: 'earn', t, cost: 0, serial };
  const proof = await network.makeEnvelope('op', op);
  if (dropStep) await new Promise(resolve => { window.denseDropped = resolve; window.denseDropNext = true; });
  const result = await simulation.atStepBoundary(() => world.apply({ ...op, proof }));
  if (!result?.ok || result.duplicate) throw new Error('未写入本轮待归档的签名操作');
  archiveCheckAt = 0;
  await archiveWorld();
  const id = archiveStore.ids.ops.get(op.id);
  if (!id || world.data.ops[op.id] || !world.data.archives.chunks[id]) throw new Error('签名操作未移入新归档');
  return { id, at: Date.now(), tick: world.data.tick };
};
window.denseHasArchive = id => Boolean(world.data.archives.chunks[id] && archiveStore.manifests[id]);
window.denseForgetLiveBase = () => { window.denseForgetArmed = true; return true; };
window.denseReplaceLeaderVisibility = id => {
  const previous = members.get(id);
  if (!previous) throw new Error('找不到原协调端');
  if (id === network.node) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  members.set(id, { ...previous, visible: false });
};
`;

async function listenPort() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function openLauncher(exe) {
  const port = await listenPort(), url = `http://127.0.0.1:${port}`;
  const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
  children.push(child);
  let failure;
  child.once('error', error => { failure = error; });
  for (let i = 0; i < 60; i++) {
    if (failure) throw failure;
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) })).ok) return url; } catch { }
    if (child.exitCode !== null) break;
    await pause(100);
  }
  throw new Error(`启动器未启动 ${port}`);
}
async function withLaunchers(run) {
  if (launchers.every(Boolean)) return run(await Promise.all(launchers.map(openLauncher)), www);
  return withReleaseFixtures(async ({ root, buildVersion, startLauncher }) => {
    const { version } = require('../package.json');
    const first = buildVersion(version, 'dense-first');
    const second = path.join(root, 'dense-second');
    unpackZip(first.zip, second);
    const urls = await Promise.all([first.exe, path.join(second, launcherName)].map(async exe => {
      const port = await listenPort(), url = `http://127.0.0.1:${port}`;
      await startLauncher(exe, port);
      for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) })).ok) return url; } catch { }
        await pause(100);
      }
      throw new Error(`启动器未启动 ${port}`);
    }));
    return run(urls, path.join(first.dir, 'www'));
  });
}
async function openPage(browser, origin, options, assets) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ label, stepBoundariesOnly }) => {
    window.densePage = label;
    window.densePhases = []; window.denseLongTasks = []; window.denseReplicaFailures = []; window.denseLiveTransfers = [];
    const longTasks = new PerformanceObserver(list => {
      for (const task of list.getEntries()) window.denseLongTasks.push({ at: performance.timeOrigin + task.startTime, ms: task.duration });
    });
    longTasks.observe({ type: 'longtask', buffered: true });
    window.denseObserve = (phase, action, receiver, args, context) => {
      if (stepBoundariesOnly) return Reflect.apply(action, receiver, args);
      const start = performance.now(), at = performance.timeOrigin + start;
      const result = Reflect.apply(action, receiver, args), sync = performance.now() - start;
      const done = () => { window.densePhases.push({ phase, context, at, sync, total: performance.now() - start }); };
      if (result instanceof Promise) result.then(done, done); else done();
      return result;
    };
  }, { label: options, stepBoundariesOnly: values['step-boundaries-only'] });
  await context.route(`${origin}/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<title>密集海验收</title>' });
    if (pathname === '/capacity-fish.mjs') return route.fulfill({ contentType: 'text/javascript', path: path.join(__dirname, 'capacity-fish.mjs') });
    if (pathname.startsWith('/local/') || pathname === '/health') return route.continue();
    const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(assets + path.sep)) return route.fulfill({ status: 404 });
    try {
      if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file, 'utf8') + instrument });
      if (pathname === '/replica-stream.js') return route.fulfill({ contentType: 'text/javascript',
        body: readFileSync(file, 'utf8') + observeReplicaPages + (values['step-boundaries-only'] ? '' : observeFirstReplicaPage) });
      if (pathname === '/simulation-changes.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file, 'utf8') + observeCommit });
      if (pathname === '/simulation-worker.js') return route.fulfill({
        contentType: 'text/javascript', body: readFileSync(file, 'utf8') + `
const timedStep = World.prototype.step;
const timedReceive = WorkerSimulation.prototype.receive;
let ruleTime;
World.prototype.step = function (...args) {
  const start = performance.now(), result = timedStep.apply(this, args);
  ruleTime = performance.now() - start;
  return result;
};
WorkerSimulation.prototype.receive = function (message) {
  const entered = performance.timeOrigin + performance.now();
  const result = timedReceive.call(this, message);
  if (message.kind === 'step') {
    result.ruleTime = ruleTime;
    result.workerTiming = [entered, performance.timeOrigin + performance.now()];
  }
  return result;
};` });
      if (pathname === '/network.js' && ['both', options].includes(values['plain-live'])) {
        const source = readFileSync(file, 'utf8').replace('const replicaRowsVersion = 1;', 'const replicaRowsVersion = 0;');
        return route.fulfill({ contentType: 'text/javascript', body: source });
      }
      if (!values['step-boundaries-only'] && Object.hasOwn(phaseModules, pathname)) {
        const observe = Object.entries(phaseModules[pathname]).map(([name, context]) => {
          const argument = context ? ', ' + context : '';
          return `\nif (globalThis.denseObserve) { const original = ${name}; ${name} = (...args) => globalThis.denseObserve('${name}', original, undefined, args${argument}); }`;
        }).join('');
        return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file, 'utf8') + observe });
      }
      return await route.fulfill({ path: file });
    } catch { return route.fulfill({ status: 404 }); }
  });
  const page = await context.newPage();
  observed.push(page);
  page.on('pageerror', error => errors.push(`${options}: ${error.message}`));
  await page.goto(origin + '/fixture');
  return page;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  if (!n) return { n };
  const round = ms => Math.round(ms * 10) / 10, middle = Math.floor(n / 2);
  const median = n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n, min: round(sorted[0]), median: round(median), p95: round(sorted[Math.ceil(n * .95) - 1]),
    p99: round(sorted[Math.ceil(n * .99) - 1]), max: round(sorted.at(-1)) };
}

function gapDetails(steps, coordinator, follower) {
  let gap;
  for (let i = 1; i < steps.length; i++) {
    const from = steps[i - 1], to = steps[i], ms = to.at - from.at;
    if (!gap || ms > gap.ms) gap = { from, to, ms };
  }
  if (!gap) return;
  const { from, to, ms } = gap;
  const during = event => event.at > from.at && event.at <= to.at;
  const overlap = (start, end) => Math.max(0, Math.min(end, to.at) - Math.max(start, from.at));
  return {
    ms, from, to,
    leaderCommits: coordinator.steps.filter(during).map(({ tick, at }) => ({ tick, afterMs: at - from.at })),
    publications: coordinator.sends.filter(during).map(({ tick, delta, at, dropped }) => ({ tick, delta, afterMs: at - from.at, dropped })),
    pendingReceives: follower.receives.filter(row => row.kind === 'world' && overlap(row.startAt, row.at) > 0)
      .map(({ tick, delta, startAt, at }) => ({ tick, delta, startAfterMs: startAt - from.at, endAfterMs: at - from.at })),
    overlappingPhases: follower.phases.filter(row => row.phase !== 'renderer.cellIndex' && overlap(row.at, row.at + row.total) >= 5)
      .map(({ phase, context, at, sync, total }) => ({ phase, context, startAfterMs: Math.round(at - from.at), syncMs: Math.round(sync), totalMs: Math.round(total) })),
    overlappingMerges: follower.worldMerges.filter(row => overlap(row.at, row.at + row.ms) >= 5)
      .map(({ at, ...row }) => ({ ...row, afterMs: Math.round(at - from.at) })),
    longTasks: follower.longTasks.filter(task => overlap(task.at, task.at + task.ms) > 0)
      .map(task => ({ startAfterMs: Math.round(task.at - from.at), ms: task.ms }))
  };
}

function progress(steps, start, end) {
  const stamps = [start, ...steps.map(step => step.at), end];
  return {
    commits: steps.length,
    logicalMs: steps.length ? steps.at(-1).tick - steps[0].tick : 0,
    maxUncommittedMs: Math.max(...stamps.slice(1).map((at, index) => at - stamps[index]))
  };
}

function assertProgress(result, elapsed, label) {
  assert(result.commits >= 9, `${label}的有效提交少于 9 次`);
  assert(result.maxUncommittedMs < 2000, `${label}有 ${result.maxUncommittedMs} 毫秒未提交任何新世界步`);
  assert(result.logicalMs >= elapsed - 2500, `${label}在 ${elapsed} 毫秒中只推进 ${result.logicalMs} 毫秒`);
}

async function main([urlA, urlB], assets) {
  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const [a, b] = await Promise.all([openPage(browser, urlA, 'A', assets), openPage(browser, urlB, 'B', assets)]);
  const fixture = backup ? await seedBackup([a, b]) : await seedSynthetic(a, b);
  console.log(`fixture ready ${count}`);
  const began = Date.now();
  const cold = await Promise.all([[a, urlA], [b, urlB]].map(async ([page, url]) => {
    await page.goto(url + '/');
    await page.waitForFunction(() => window.tide && denseSurvey().frames.some(frame => frame.visible > 0), null, { polling: 50, timeout: 60000 });
    return Date.now() - began;
  }));
  console.log(`app ready ${cold.join(', ')}`);
  await b.locator('#connect').click();
  await b.locator('#peerUrl').fill(urlA);
  const joining = Date.now();
  await b.locator('#connectionForm .primary').click();
  await Promise.all([a, b].map(page => page.waitForFunction(({ count, real }) => {
    const event = denseSurvey();
    return event.peers > 0 && (real ? event.fish > 0 : event.fish === count) &&
      event.receives.some(message => message.kind === 'hello' && !message.failed);
  }, { count, real: Boolean(backup) }, { polling: 100, timeout: count < 200 ? 20000 : 95000 })));
  const joined = Date.now();
  await Promise.all([a, b].map(page => page.waitForFunction(() => denseJoinSettled(), null, { polling: 125, timeout: 45000 })));
  const stopTrace = values.trace && await startTrace(browser);
  if (stopTrace) await pause(300);
  const recent = Date.now();
  await survey({ a, b, fixture, cold, joining, joined, recent, stopTrace, browserVersion: browser.version() });
}

async function seedBackup(pages) {
  const { world, lastOnlineAt, archiveChunks } = backup;
  const archiveIds = Object.keys(world.archives?.chunks || {});
  assert(archiveIds.length && archiveIds.every(id => archiveChunks?.[id]?.length), '存档缺少历史归档内容');
  await Promise.all(pages.map((page, index) => page.evaluate(async ({ world, lastOnlineAt, archiveChunks, index }) => {
    const { newIdentity, putMany } = await import('/storage.js');
    await newIdentity(`验收${index + 1}`);
    await putMany([['checkpoint', { world, at: world.tick, lastOnlineAt }],
      ...Object.entries(archiveChunks).map(([id, bytes]) => ['archive:' + id, bytes])]);
  }, { world, lastOnlineAt, archiveChunks, index })));
  return { archiveIds };
}

async function seedSynthetic(a, b) {
  const text = await a.evaluate(async count => {
    const { makeFishWorld } = await import('/capacity-fish.mjs');
    const { World, CONFIG } = await import('/engine.js');
    const { newIdentity, actorId, putMany } = await import('/storage.js');
    const { Network } = await import('/network.js');
    const { encodeArchive, ARCHIVE_FIELDS } = await import('/archive.js');
    const { verifyReplica } = await import('/replica.js');
    const encoder = new TextEncoder();
    await newIdentity('验收甲');
    const body = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), ch: i === 3 ? 'o' : '鱼', color: '#8be7df' }));
    const world = makeFishWorld(World, count, CONFIG.width, { body, spacingX: 4, spacingY: 3, rows: 22, mixedGenders: true });
    const ops = Object.values(world.data.ops);
    const authors = Math.ceil(count / 2);
    let archive;
    for (let offset = 0; offset < authors; offset += 40) {
      await Promise.all(Array.from({ length: Math.min(40, authors - offset) }, async (_, index) => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const pub = await crypto.subtle.exportKey('jwk', pair.publicKey), actor = await actorId(pub);
        const author = new Network({ pub, actor }, {}, () => {}, () => {});
        author.sign = async value => {
          const signed = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, encoder.encode(JSON.stringify(value)));
          return btoa(String.fromCharCode(...new Uint8Array(signed)));
        };
        const first = (offset + index) * 2;
        for (const op of ops.slice(first, first + 2)) {
          op.actor = actor;
          world.data.fishes[op.id].actor = actor;
          for (let i = 0; i < body.length; i++) world.data.chars[op.id + ':' + i].payer = actor;
          op.proof = await author.makeEnvelope('op', op);
        }
        if (!first) {
          const earn = { id: actor + ':hour:1', actor, nick: '验收归档', roots: [world.id], kind: 'earn', t: world.data.tick, cost: 0, serial: 1 };
          const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
          records.ops[earn.id] = { ...earn, proof: await author.makeEnvelope('op', earn) };
          archive = await encodeArchive(records, world.data.roots);
        }
      }));
    }
    world.data.archives.chunks[archive.manifest.id] = archive.manifest;
    await verifyReplica(world.data);
    const checkpoint = { world: world.serialize(), at: Date.now(), lastOnlineAt: Date.now() };
    await putMany([['checkpoint', checkpoint], ['archive:' + archive.manifest.id, archive.encoded]]);
    const saved = JSON.parse(JSON.stringify(checkpoint));
    const last = ops.at(-1).id;
    delete saved.world.fishes[last]; delete saved.world.ops[last]; delete saved.world.travel[last];
    for (let i = 0; i < body.length; i++) delete saved.world.chars[last + ':' + i];
    delete saved.world.archives.chunks[archive.manifest.id];
    return JSON.stringify({ checkpoint: saved, joinedFish: last, archiveId: archive.manifest.id });
  }, count);
  const fixture = JSON.parse(text);
  await b.evaluate(async checkpoint => {
    const { newIdentity, putMany } = await import('/storage.js');
    await newIdentity('验收乙');
    await putMany([['checkpoint', checkpoint]]);
  }, fixture.checkpoint);
  return { joinedFish: fixture.joinedFish, archiveIds: [fixture.archiveId] };
}

async function survey({ a, b, fixture, cold, joining, joined, recent, stopTrace, browserVersion }) {
  const firstLeads = await a.evaluate(() => { const { node, leader } = denseSurvey(); return node === leader; });
  let profiler, profileStartedAt;
  if (values.profile) {
    const followerPage = firstLeads ? b : a;
    profiler = await followerPage.context().newCDPSession(followerPage);
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
    profileStartedAt = Date.now();
  }
  let dropTimer;
  if (values.drop && !archiveRounds) dropTimer = setTimeout(() => (firstLeads ? a : b).evaluate(() => { window.denseDropNext = true; }).catch(() => {}), 2500);
  const forgotten = values['forget-live-base'] && pause(3200).then(() => (firstLeads ? b : a).evaluate(() => denseForgetLiveBase()));
  const archiveRun = runArchiveRounds(archiveRounds, firstLeads ? a : b, firstLeads ? b : a, fixture.archiveIds);
  // Keep reporting the acceptance metrics if an in-window archive round fails.
  const archiveResult = archiveRun.then(rounds => ({ rounds }), error => ({ error: error.message }));
  try { await pause(seconds * 1000); }
  finally { clearTimeout(dropTimer); }
  const ended = Date.now(), sampled = event => event.at >= recent && event.at <= ended;
  await Promise.all([a, b].map(page => page.waitForFunction(end => denseSurvey().frames.at(-1)?.at >= end, ended, { polling: 50, timeout: 10000 })));
  if (stopTrace) await pause(200);
  const trace = stopTrace && await stopTrace(values.trace);
  const { rounds = [], error: archiveError } = await archiveResult;
  let profileSummary;
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    await profiler.detach();
    await writeFile(values.profile, JSON.stringify(profile));
    profileSummary = profileTimes(profile);
  }
  const pages = await Promise.all([a, b].map(page => page.evaluate(() => denseSurvey())));
  const archiveIds = [...fixture.archiveIds, ...rounds.map(round => round.id)];
  const saved = await Promise.all((backup ? [a, b] : [b]).map(page => page.evaluate(async ({ joinedFish, archiveIds }) => {
    const { get } = await import('/storage.js');
    const checkpoint = await get('checkpoint', { observeCheckpoint: false });
    const payloads = await Promise.all(archiveIds.map(async id => checkpoint.world.archives.chunks[id] ? atob(await get('archive:' + id) || '').length : 0));
    return { fish: joinedFish ? !!checkpoint.world.fishes[joinedFish] : Object.keys(checkpoint.world.fishes).length,
      archiveCount: payloads.filter(Boolean).length, archivedBytes: payloads.reduce((sum, n) => sum + n, 0), tick: checkpoint.world.tick };
  }, { joinedFish: fixture.joinedFish, archiveIds })));
  assert(saved.every(row => row.fish && row.archiveCount === archiveIds.length && row.archivedBytes > 0), JSON.stringify(saved));
  const coordinator = pages.find(data => data.leader === data.node), follower = pages.find(data => data.leader !== data.node);
  assert(coordinator && follower, '加入后没有共同协调者');
  const leaderSteps = coordinator.steps.filter(sampled);
  const received = follower.receives.filter(event => event.kind === 'world' && sampled(event) && !event.failed && event.after > event.before);
  const sentAt = new Map();
  for (const send of coordinator.sends) if (!send.dropped && !sentAt.has(send.tick)) sentAt.set(send.tick, send.at);
  const elapsedAfterSend = (event, timestamp) => timestamp - sentAt.get(event.tick);
  const matchedLatency = ms => Number.isFinite(ms) && ms >= 0;
  const transport = received.map(event => elapsedAfterSend(event, event.at)).filter(matchedLatency);
  const sendToMessage = received.map(event => elapsedAfterSend(event, event.startAt)).filter(matchedLatency);
  const actualSteps = [...new Map(follower.applied.filter(sampled).map(event => [event.tick, event])).values()];
  const appliedAfterSend = actualSteps.map(event => elapsedAfterSend(event, event.at)).filter(matchedLatency);
  const leaderProgress = progress(leaderSteps, recent, ended), followerProgress = progress(actualSteps, recent, ended);
  const requests = coordinator.stepRequests.filter(row => row.startAt >= recent && row.startAt < ended);
  if (trace) {
    const prefix = 'tide.request.' + coordinator.page + '.';
    const stamps = new Map(trace.traceEvents.filter(event => event.name.startsWith(prefix))
      .map(event => [Number(event.name.slice(prefix.length)), event.args.data.callTime]));
    for (const request of requests) request.traceAt = stamps.get(request.sequence);
  }
  const completed = requests.filter(row => row.committed).map(row => row.ms);
  const over20 = completed.filter(ms => ms > 20).length;
  const stepComplete = { ...stats(completed), requested: requests.length, aborted: requests.filter(row => row.committed === false).length,
    pending: requests.filter(row => row.committed === undefined).length,
    over20, over20Pct: completed.length && Math.round(over20 / completed.length * 10000) / 100 };
  const committed = requests.filter(row => row.committed);
  const authority = committed.map(row => row.authority).filter(Number.isFinite);
  const stepStages = {
    toWorker: stats(committed.map(row => row.toWorker).filter(Number.isFinite)),
    inWorker: stats(committed.map(row => row.inWorker).filter(Number.isFinite)),
    fromWorker: stats(committed.map(row => row.fromWorker).filter(Number.isFinite)),
    requestToReply: stats(committed.map(row => row.reply)),
    replyToAuthority: stats(committed.map(row => row.authority - row.reply)),
    requestToAuthority: { ...stats(authority), over20: authority.filter(ms => ms > 20).length, missing: committed.length - authority.length },
    authorityToNotificationsDone: stats(committed.map(row => row.ms - row.authority))
  };
  const stepsByTick = new Map(requests.map(request => [request.tick, request]));
  for (const phase of coordinator.phases.filter(sampled)) {
    const request = stepsByTick.get(phase.context);
    if (request && phase.at >= request.startAt && !Object.hasOwn(request.phases ??= {}, phase.phase)) request.phases[phase.phase] = phase.sync;
  }
  const summaries = pages.map(page => {
    const frames = page.frames.filter(sampled), noFish = frames.filter(frame => !frame.visible).length;
    const phases = {};
    for (const row of page.phases.filter(sampled)) (phases[row.phase] ||= []).push(row);
    const presentations = trace && readPresentations(trace.traceEvents, page, recent, ended);
    return { leader: page.node === page.leader, fish: page.fish, simulationFailure: page.simulationFailure,
      ...frameSummary(page, presentations, recent, ended, coordinator.steps, requests),
      visible: stats(frames.map(event => event.visible)), noFish, rejected: page.rejected, saves: stats(page.saves.filter(sampled).map(event => event.ms)),
      phases: Object.fromEntries(Object.entries(phases).map(([name, rows]) => [name, { sync: stats(rows.map(row => row.sync)), total: stats(rows.map(row => row.total)) }])),
      longestTasks: page.longTasks.filter(sampled).sort((a, b) => b.ms - a.ms).slice(0, 8),
      failed: page.receives.filter(event => event.failed), replicaFailures: page.replicaFailures, logs: page.logs };
  });
  const dropped = coordinator.sends.filter(event => event.dropped && sampled(event));
  const droppedTicks = new Set(dropped.map(event => event.tick));
  const resumedTick = dropped.at(-1)?.tick + 500;
  const resumed = actualSteps.find(event => event.tick === resumedTick);
  const resumeSent = coordinator.sends.find(event => event.tick === resumedTick && !event.dropped);
  const resumeMs = resumed && resumeSent ? resumed.at - resumeSent.at : undefined;
  const recovered = droppedTicks.size === dropSteps && actualSteps.some(event => event.tick < dropped[0].tick) &&
    !actualSteps.some(event => droppedTicks.has(event.tick)) && actualSteps.some(event => event.tick > dropped.at(-1).tick);
  const fullUpdates = follower.receives.filter(event => event.kind === 'world' && sampled(event) && !event.delta && !event.failed).length;
  const transfers = coordinator.liveTransfers.filter(sampled);
  const liveWire = { bytes: coordinator.liveBytes.filter(sampled).reduce((sum, row) => sum + row.bytes, 0),
    plain: transfers.filter(row => !row.compact).length, compact: transfers.filter(row => row.compact && !row.resent).length,
    missingBase: transfers.filter(row => row.resent).length, elapsed: stats(transfers.map(row => row.ms)) };
  const switched = values['switch-leader'] && await switchLeader([a, b], coordinator.node, follower.node);
  const replicaRows = Object.fromEntries(['fishes', 'chars', 'breeding', 'contacts', 'travel', 'ops', 'scenes']
    .map(field => [field, stats(received.flatMap(row => row.rows ? [row.rows[field]] : []))]));
  const report = JSON.stringify({ count, realBackup: Boolean(backup), browserVersion, cold, joinedMs: joined - joining, settledMs: recent - joining, steadyMs: ended - recent,
    saved, liveWire, ...(switched ? { switched } : {}),
    repairs: pages.map(page => ({ leader: page.node === page.leader,
      requested: page.repairs.filter(sampled).map(row => ({ afterMs: row.at - recent, correlated: row.correlated })),
      incoming: page.receives.filter(row => row.kind === 'merge' && sampled(row)).map(row => ({ afterMs: row.startAt - recent, ms: row.ms })) })),
    archiveRounds: rounds.map(({ at, tick, deliveredAt }) => ({ afterMs: at - recent, tick, deliveredAfterMs: deliveredAt - recent })), archiveError,
    leaderProgress, followerProgress, stepComplete, stepStages, slowestStep: committed.reduce((slowest, row) =>
      !slowest || row.ms > slowest.ms ? row : slowest, null), stepSamples: requests, replicaRows,
    requestGaps: stats(requests.slice(1).map((row, index) => row.startAt - requests[index].startAt)),
    stepGaps: stats(leaderSteps.slice(1).map((step, index) => step.at - leaderSteps[index].at)),
    tickGaps: [...new Set(leaderSteps.slice(1).map((step, index) => step.tick - leaderSteps[index].tick))],
    receiveCount: received.length, deltaCount: received.filter(event => event.delta).length, fullUpdates, receiveMs: stats(received.map(event => event.ms)),
    followerSteps: actualSteps.length, sendToMessageMs: stats(sendToMessage), sendToCommittedMs: stats(appliedAfterSend), sendToFinishedMs: stats(transport),
    followerStepGaps: stats(actualSteps.slice(1).map((step, index) => step.at - actualSteps[index].at)),
    followerTickGaps: stats(actualSteps.slice(1).map((step, index) => step.tick - actualSteps[index].tick)),
    longestFollowerGap: gapDetails(actualSteps, coordinator, follower),
    receiveTickGaps: [...new Set(received.slice(1).map((event, index) => event.after - received[index].after))],
    helloMs: pages.map(page => page.merges.filter(event => event.type === 'hello').map(event => event.ms)), ...(values.drop ? { dropped, recovered, resumeMs } : {}),
    summaries, profileStartedAt, profileSummary, errors }, null, 2);
  if (values.report) await writeFile(values.report, report + '\n');
  console.log(report);
  assertProgress(leaderProgress, ended - recent, '主端');
  if (dropSteps > 1 && resumed && resumeSent) {
    // Keep the full physical gap in the report. Check normal continuity up to
    // the blackout and again from the first publication actually available.
    const before = actualSteps.filter(row => row.tick < dropped[0].tick), after = actualSteps.filter(row => row.tick >= resumedTick);
    assert(before.length && before.at(-1).tick === dropped[0].tick - 500, '漏发前的最后一步应已提交');
    const prior = progress(before, recent, dropped[0].at), following = progress(after, resumeSent.at, ended);
    assertProgress({ ...followerProgress, maxUncommittedMs: Math.max(prior.maxUncommittedMs, following.maxUncommittedMs) }, ended - recent, '跟随端可收包期间');
  } else assertProgress(followerProgress, ended - recent, '跟随端');
  assert(leaderSteps.slice(1).every((step, index) => step.tick - leaderSteps[index].tick === 500), '生态步时间跳跃');
  assert(actualSteps.slice(1).every((step, index) => step.tick > actualSteps[index].tick && (step.tick - actualSteps[index].tick) % 500 === 0), '跟随端收到非半秒边界的世界步');
  if (values.drop) assert(recovered, '跟随端应跳过未发布的更新并继续提交');
  if (values.drop && archiveRounds) {
    assert(dropped.length > dropSteps, '归档必须实际重发已漏掉的同一步');
    assert.equal(follower.repairs.filter(sampled).length, 0, '已知伙伴漏收的变化应直接补齐');
    assert(resumeMs >= 0 && resumeMs < 500, '首个恢复发布的更新应在下一次半秒结算前完成提交');
    assert(!follower.receives.some(row => sampled(row) && row.kind === 'merge'), '直连伙伴应在原有实时通道恢复');
  }
  if (values['plain-live']) assert(liveWire.plain > 0 && liveWire.compact === 0 && liveWire.missingBase === 0, '旧版应继续接收原实时分块');
  if (forgotten) assert(await forgotten && liveWire.missingBase === 1 && liveWire.plain > 0 && liveWire.compact > 0, '遗失版本后应先重放原分块再恢复紧凑发送');
  if (expectedFull !== undefined) assert.equal(fullUpdates, expectedFull, '测试区间的定期全量同步次数不符');
  assert(pages.every(page => page.peers === 1), '两端在观测结束时仍应直连');
  assert(summaries.every(page => page.frames.n >= 20 && page.noFish === 0 && page.rejected === 0), '画面中断或接收拒绝');
  assert.deepEqual(errors, []);
  assert.equal(stepStages.requestToAuthority.missing, 0, '完成的生态请求缺少权威状态写入时间');
  assert(!archiveError && rounds.every(round => sampled(round) && round.deliveredAt <= ended), archiveError || '至少一轮归档未在采样期间传递');
  if (values['refresh-budget']) assert(stepComplete.n >= 9 && stepComplete.n === stepComplete.requested && stepComplete.over20 === 0 &&
    requests.slice(1).every((row, i) => row.tick - requests[i].tick === 500) && summaries.every(page => page.draw.over20 === 0 &&
    [page.presented, page.visibleMotion].every(row => row.over20 === 0 && row.n >= 20 && row.startCovered && row.endCovered) &&
    page.requestToConfirmedFrame.over20 === 0 && page.requestToConfirmedFrame.requestsWithoutObservedFrame === 0),
    '单步提交、实际呈现间隔或请求至同一步首张确认画面超过 20 毫秒');
}

async function switchLeader(pages, oldLeader, newLeader) {
  const before = await Promise.all(pages.map(page => page.evaluate(() => denseSurvey().tick)));
  await Promise.all(pages.map(page => page.evaluate(old => denseReplaceLeaderVisibility(old), oldLeader)));
  await Promise.all(pages.map(page => page.waitForFunction(({ newLeader, tick }) => {
    const state = denseSurvey();
    return state.leader === newLeader && state.tick >= tick + 1500 && state.peers === 1;
  }, { newLeader, tick: Math.max(...before) }, { polling: 100, timeout: 15000 })));
  return { progressed: await Promise.all(pages.map(page => page.evaluate(() => denseSurvey().tick))).then(ticks => ticks.map((tick, i) => tick - before[i])) };
}

async function runArchiveRounds(count, leader, follower, known) {
  const written = new Set(known), rounds = [];
  const start = Date.now();
  for (let i = 0; i < count; i++) {
    // Exercise a burst of adjacent archives, then repeat during the following
    // part of the run so later saves and heartbeats overlap archive traffic too.
    const group = Math.floor(i / 3), groups = Math.ceil(count / 3);
    const due = start + seconds * 1000 * group / groups + 1000 * (i % 3 + 1);
    await pause(Math.max(0, due - Date.now()));
    const round = await leader.evaluate(([serial, dropStep]) => denseArchiveRound(serial, dropStep),
      [100000 + i, values.drop && i === Math.min(1, count - 1)]);
    assert(!written.has(round.id), '本轮归档重复使用了旧包');
    written.add(round.id);
    await follower.waitForFunction(id => denseHasArchive(id), round.id, { polling: 100, timeout: 12000 });
    rounds.push({ ...round, deliveredAt: Date.now() });
  }
  return rounds;
}

function profileTimes(profile) {
  const names = new Map(profile.nodes.map(({ id, callFrame: frame }) => [id, `${frame.functionName || '(anonymous)'} ${frame.url ? frame.url.split('/').at(-1) + ':' + (frame.lineNumber + 1) : ''}`.trim()]));
  const time = new Map();
  for (const [index, sample] of profile.samples.entries()) {
    const name = names.get(sample);
    if (name !== '(idle)') time.set(name, (time.get(name) || 0) + profile.timeDeltas[index]);
  }
  return [...time].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, microseconds]) => ({ name, estimatedMs: Math.round(microseconds / 1000) }));
}

withLaunchers((urls, assets) => main(urls, assets).catch(async error => {
  console.error(error, errors);
  for (const page of observed) {
    try { console.error(await page.evaluate(() => {
      const state = window.denseSurvey?.();
      return { toast: document.querySelector('#toast')?.textContent, network: document.querySelector('#networkStatus')?.textContent, notice: document.querySelector('#startupNotice')?.textContent?.trim(),
        state: state && { fish: state.fish, lastFrame: state.frames.at(-1), steps: state.steps.length, peers: state.peers, logs: state.logs, recentReceives: state.receives.slice(-3) } };
    })); } catch { }
  }
  throw error;
}).finally(async () => {
  await Promise.allSettled(browsers.map(browser => browser.close()));
})).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(children.map(async child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    if (child.kill()) await exited;
  }));
});
