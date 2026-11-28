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

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  profile: { type: 'string' }, source: { type: 'string' }, seconds: { type: 'string', default: '10' },
  'full-updates': { type: 'string' }, drop: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help) {
  console.log('用法：node tests/browser-dense-peers.cjs [120|5000] [--seconds=35] [--full-updates=0|1] [--drop] [--profile=跟随端.cpuprofile]');
  console.log('默认使用仓库发行构建工具，临时构建两套启动器。也可用 TIDE_DENSE_LAUNCHER_A 和 TIDE_DENSE_LAUNCHER_B 指定两套隔离的启动器，另以 --source=对照工作区指定网页来源。');
  console.log('--drop 蓄意漏发一个已提交的半秒更新，检查后续能否继续同步。');
  process.exit(0);
}
const count = Number(positionals[0] || 120);
const seconds = Number(values.seconds);
const expectedFull = values['full-updates'] === undefined ? undefined : Number(values['full-updates']);
assert(positionals.length < 2 && Number.isSafeInteger(count) && count >= 2 && count <= 5500);
assert(Number.isSafeInteger(seconds) && seconds >= 6 && seconds <= 90);
assert(expectedFull === undefined || Number.isSafeInteger(expectedFull) && expectedFull >= 0);
const launchers = [process.env.TIDE_DENSE_LAUNCHER_A, process.env.TIDE_DENSE_LAUNCHER_B];
assert(!launchers.some(Boolean) || launchers.every(Boolean) && path.dirname(launchers[0]) !== path.dirname(launchers[1]), '请指定两个独立临时目录中的启动器');
assert(!values.source || launchers.every(Boolean), '--source 需要相同规则的显式启动器');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const www = values.source ? path.resolve(values.source, 'www') : path.resolve(__dirname, '../www');
const browsers = [], children = [], observed = [], errors = [];
const phaseModules = { '/archive.js': 'compactKnown', '/replica.js': 'verifyReplica', '/storage.js': 'putMany' };
const instrument = `
const testData = { frames: [], steps: [], applied: [], sends: [], receives: [], merges: [], saves: [] };
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
Network.prototype.broadcast = async function (kind, body, ...args) {
  if (kind !== 'world') return originalBroadcast.call(this, kind, body, ...args);
  const at = Date.now();
  if (window.denseDropNext && body.delta) {
    window.denseDropNext = false;
    testData.sends.push({ tick: body.world.tick, delta: true, at, done: at, dropped: true });
    return;
  }
  try { return await originalBroadcast.call(this, kind, body, ...args); }
  finally { testData.sends.push({ tick: body.world.tick, delta: body.delta, at, done: Date.now() }); }
};
const originalSave = save;
save = async (...args) => {
  const tick = world.data.tick, start = performance.now();
  try { return await originalSave(...args); }
  finally { testData.saves.push({ tick, ms: performance.now() - start, at: Date.now() }); }
};
subscribeSimulationChanges((target, patch) => {
  if (target !== world || !Number.isFinite(patch?.values.tick)) return;
  (amLeader() ? testData.steps : testData.applied).push({ tick: patch.values.tick, at: Date.now() });
});
for (const [object, method, name] of [
  [World.prototype, 'merge', 'World.merge'], [pictures, 'prepare', 'pictures.prepare'], [renderer, 'cellIndex', 'renderer.cellIndex']
]) {
  const original = object[method];
  object[method] = function (...args) {
    const previous = method === 'merge' && this === world && this.data.tick;
    const result = window.denseObserve(name, original, this, args);
    if (previous && !amLeader() && this.data.tick > previous) testData.applied.push({ tick: this.data.tick, at: Date.now() });
    return result;
  };
}
const originalDraw = renderer.draw.bind(renderer);
let lastFrame = 0;
renderer.draw = (...args) => {
  const at = performance.now();
  originalDraw(...args);
  testData.frames.push({ at: Date.now(), frame: lastFrame ? at - lastFrame : 0, draw: performance.now()-at,
    visible: Math.floor((renderer.paintedFish?.length || 0) / 3) });
  lastFrame = at;
};
window.denseSurvey = () => ({ ...testData, node: network?.node, leader: network && leader(), peers: network?.live().length,
  tick: world.data.tick, fish: Object.keys(world.data.fishes).length, rejected: network?.stats.rejected,
  phases: window.densePhases, longTasks: window.denseLongTasks,
  logs: diagnostics.list().filter(log => log.level === 'warn' || log.level === 'error').slice(-10) });
window.denseJoinSettled = () => {
  if (!network?.replicaPeers().length) return false;
  const full = testData.receives.filter(row => ['hello', 'merge'].includes(row.kind) || row.kind === 'world' && !row.delta).at(-1);
  return full && Date.now() - full.at >= 800 && !network.replicas.outgoing.size &&
    [...network.replicas.incoming.values()].every(state => state.kind === 'world' || state.kind === 'live');
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
  await context.addInitScript(() => {
    window.densePhases = []; window.denseLongTasks = [];
    const longTasks = new PerformanceObserver(list => {
      for (const task of list.getEntries()) window.denseLongTasks.push({ at: performance.timeOrigin + task.startTime, ms: task.duration });
    });
    longTasks.observe({ type: 'longtask', buffered: true });
    window.denseObserve = (phase, action, receiver, args) => {
      const start = performance.now(), at = performance.timeOrigin + start;
      const result = Reflect.apply(action, receiver, args), sync = performance.now() - start;
      const done = () => { window.densePhases.push({ phase, at, sync, total: performance.now() - start }); };
      if (result instanceof Promise) result.then(done, done); else done();
      return result;
    };
  });
  await context.route(`${origin}/**`, async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: '<title>密集海验收</title>' });
    if (pathname === '/capacity-fish.mjs') return route.fulfill({ contentType: 'text/javascript', path: path.join(__dirname, 'capacity-fish.mjs') });
    if (pathname.startsWith('/local/') || pathname === '/health') return route.continue();
    const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(assets + path.sep)) return route.fulfill({ status: 404 });
    try {
      if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file, 'utf8') + instrument });
      if (Object.hasOwn(phaseModules, pathname)) {
        const name = phaseModules[pathname];
        const observe = `\nif (globalThis.denseObserve) { const original = ${name}; ${name} = (...args) => globalThis.denseObserve('${name}', original, undefined, args); }`;
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
  return { n, min: round(sorted[0]), median: round(median), p95: round(sorted[Math.ceil(n * .95) - 1]), max: round(sorted.at(-1)) };
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
      .map(({ phase, at, sync, total }) => ({ phase, startAfterMs: Math.round(at - from.at), syncMs: Math.round(sync), totalMs: Math.round(total) })),
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
  console.log(`fixture ready ${count}`);
  const began = Date.now();
  const cold = await Promise.all([[a, urlA], [b, urlB]].map(async ([page, url]) => {
    await page.goto(url + '/');
    await page.waitForFunction(() => window.tide && denseSurvey().frames.some(frame => frame.visible > 0), null, { polling: 50, timeout: 40000 });
    return Date.now() - began;
  }));
  console.log(`app ready ${cold.join(', ')}`);
  await b.locator('#connect').click();
  await b.locator('#peerUrl').fill(urlA);
  const joining = Date.now();
  await b.locator('#connectionForm .primary').click();
  await Promise.all([a, b].map(page => page.waitForFunction(count => {
    const event = denseSurvey();
    return event.peers > 0 && event.fish === count && event.receives.some(message => message.kind === 'hello' && !message.failed);
  }, count, { polling: 100, timeout: count < 200 ? 20000 : 95000 })));
  const joined = Date.now();
  await Promise.all([a, b].map(page => page.waitForFunction(() => denseJoinSettled(), null, { polling: 125, timeout: 45000 })));
  const recent = Date.now();
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
  if (values.drop) dropTimer = setTimeout(() => (firstLeads ? a : b).evaluate(() => { window.denseDropNext = true; }).catch(() => {}), 2500);
  try { await pause(seconds * 1000); }
  finally { clearTimeout(dropTimer); }
  const ended = Date.now(), sampled = event => event.at >= recent && event.at <= ended;
  let profileSummary;
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    await profiler.detach();
    await writeFile(values.profile, JSON.stringify(profile));
    profileSummary = profileTimes(profile);
  }
  const pages = await Promise.all([a, b].map(page => page.evaluate(() => denseSurvey())));
  const saved = await b.evaluate(async ({ joinedFish, archiveId }) => {
    const { get } = await import('/storage.js');
    const checkpoint = await get('checkpoint', { observeCheckpoint: false });
    return { fish: !!checkpoint.world.fishes[joinedFish], archive: !!checkpoint.world.archives.chunks[archiveId],
      archivedBytes: (await get('archive:' + archiveId))?.length || 0, tick: checkpoint.world.tick };
  }, { joinedFish: fixture.joinedFish, archiveId: fixture.archiveId });
  assert(saved.fish && saved.archive && saved.archivedBytes > 0, JSON.stringify(saved));
  const coordinator = pages.find(data => data.leader === data.node), follower = pages.find(data => data.leader !== data.node);
  assert(coordinator && follower, '加入后没有共同协调者');
  const leaderSteps = coordinator.steps.filter(sampled);
  const received = follower.receives.filter(event => event.kind === 'world' && sampled(event) && !event.failed && event.after > event.before);
  const transport = received.map(event => event.at - coordinator.sends.find(send => send.tick === event.tick)?.at).filter(Number.isFinite);
  const actualSteps = [...new Map(follower.applied.filter(sampled).map(event => [event.tick, event])).values()];
  const appliedAfterSend = actualSteps.map(event => event.at - coordinator.sends.find(send => send.tick === event.tick)?.at).filter(Number.isFinite);
  const leaderProgress = progress(leaderSteps, recent, ended), followerProgress = progress(actualSteps, recent, ended);
  const summaries = pages.map(page => {
    const frames = page.frames.filter(sampled), noFish = frames.filter(frame => !frame.visible).length;
    const phases = {};
    for (const row of page.phases.filter(sampled)) (phases[row.phase] ||= []).push(row);
    return { leader: page.node === page.leader, frames: stats(frames.map(event => event.frame)), draw: stats(frames.map(event => event.draw)),
      visible: stats(frames.map(event => event.visible)), noFish, rejected: page.rejected, saves: stats(page.saves.filter(sampled).map(event => event.ms)),
      phases: Object.fromEntries(Object.entries(phases).map(([name, rows]) => [name, { sync: stats(rows.map(row => row.sync)), total: stats(rows.map(row => row.total)) }])),
      longestTasks: page.longTasks.filter(sampled).sort((a, b) => b.ms - a.ms).slice(0, 8),
      failed: page.receives.filter(event => event.failed), logs: page.logs };
  });
  const dropped = coordinator.sends.filter(event => event.dropped && sampled(event));
  const recovered = dropped.length === 1 && actualSteps.some(event => event.tick < dropped[0].tick) &&
    !actualSteps.some(event => event.tick === dropped[0].tick) && actualSteps.some(event => event.tick > dropped[0].tick);
  const fullUpdates = follower.receives.filter(event => event.kind === 'world' && sampled(event) && !event.delta && !event.failed).length;
  console.log(JSON.stringify({ count, cold, joinedMs: joined - joining, settledMs: recent - joining, steadyMs: ended - recent,
    saved, leaderProgress, followerProgress,
    stepGaps: stats(leaderSteps.slice(1).map((step, index) => step.at - leaderSteps[index].at)),
    tickGaps: [...new Set(leaderSteps.slice(1).map((step, index) => step.tick - leaderSteps[index].tick))],
    receiveCount: received.length, deltaCount: received.filter(event => event.delta).length, fullUpdates, receiveMs: stats(received.map(event => event.ms)),
    followerSteps: actualSteps.length, sendToCommittedMs: stats(appliedAfterSend), sendToFinishedMs: stats(transport),
    followerStepGaps: stats(actualSteps.slice(1).map((step, index) => step.at - actualSteps[index].at)),
    followerTickGaps: stats(actualSteps.slice(1).map((step, index) => step.tick - actualSteps[index].tick)),
    longestFollowerGap: gapDetails(actualSteps, coordinator, follower),
    receiveTickGaps: [...new Set(received.slice(1).map((event, index) => event.after - received[index].after))],
    helloMs: pages.map(page => page.merges.filter(event => event.type === 'hello').map(event => event.ms)), ...(values.drop ? { dropped, recovered } : {}),
    summaries, profileStartedAt, profileSummary, errors }, null, 2));
  assertProgress(leaderProgress, ended - recent, '主端');
  assertProgress(followerProgress, ended - recent, '跟随端');
  assert(leaderSteps.slice(1).every((step, index) => step.tick - leaderSteps[index].tick === 500), '生态步时间跳跃');
  assert(actualSteps.slice(1).every((step, index) => step.tick > actualSteps[index].tick && (step.tick - actualSteps[index].tick) % 500 === 0), '跟随端收到非半秒边界的世界步');
  if (values.drop) assert(recovered, '跟随端应跳过未发布的更新并继续提交');
  if (expectedFull !== undefined) assert.equal(fullUpdates, expectedFull, '测试区间的定期全量同步次数不符');
  assert(pages.every(page => page.peers === 1), '两端在观测结束时仍应直连');
  assert(summaries.every(page => page.frames.n >= 20 && page.noFish === 0 && page.rejected === 0), '画面中断或接收拒绝');
  assert.deepEqual(errors, []);
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
