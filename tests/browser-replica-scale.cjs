const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const www = path.resolve(__dirname, '../www');
const fishMode = process.argv[2] === '--fish';
const count = Number((fishMode ? process.argv[3] : process.argv[2]) || (fishMode ? 5000 : 100000));
const rounds = Number(process.argv[4] || 7);
assert(Number.isSafeInteger(count) && count > 0 && (!fishMode || count <= 5500));
assert(Number.isSafeInteger(rounds) && rounds > 0);
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.setHeader('content-type', 'text/html').end('<!doctype html><title>联机容量验证</title>');
  const file = req.url === '/capacity-fish.mjs' ? path.join(__dirname, 'capacity-fish.mjs')
    : /^\/[a-z0-9-]+\.js$/.test(req.url) ? path.join(www, req.url.slice(1)) : null;
  if (!file) return res.writeHead(404).end();
  res.setHeader('content-type', 'text/javascript');
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
let browser;

async function setup(page, rows, nick) {
  await page.goto('http://127.0.0.1:' + server.address().port);
  return page.evaluate(async ({ rows, nick }) => {
    const { World } = await import('./engine.js');
    const { Network } = await import('./network.js');
    const { newIdentity, signer } = await import('./storage.js');
    const identity = await newIdentity(nick);
    const source = window.world = new World(Date.UTC(2025, 0, 1), '00000000-0000-4000-8000-000000000001');
    window.sampleSize = rows;
    // Historical participants survive leaving a world. Use valid actor-shaped
    // keys so changing scale does not require overlapping fish in a small sea.
    const key = i => i.toString(16).padStart(64, '0');
    for (let i = 0; i < rows; i++) source.data.participants[key(i)] = '玩家' + i.toString(36);
    window.arrivals = [];
    window.pagesSent = { count: 0, maxChars: 0, first: [] };
    const net = window.net = new Network(identity, {}, (message) => {
      if (message.kind === 'hello' || message.kind === 'merge' || message.kind === 'world') {
        source.merge(message.body.world);
        if (message.body.base) window.catchupRows = Object.keys(message.body.world.participants).length;
        window.arrivals.push(message.kind);
      }
    }, () => {});
    net.sign = await signer(identity);
    const send = net.directControl.bind(net);
    net.directControl = async (peer, kind, packet) => {
      if (kind === 'replicaPage') {
        const stats = window.pagesSent;
        stats.count++; stats.maxChars = Math.max(stats.maxChars, packet.text.length);
        if (stats.first.length < 8) stats.first.push(packet.index);
      }
      if (kind === 'replicaReceipt' && packet.index === 2 && window.cut) {
        window.cut = false;
        net.close(peer);
        return;
      }
      return send(peer, kind, packet);
    };
    window.verifyRows = n => {
      const table = source.data.participants;
      for (let i = 0; i < n; i++) if (table[key(i)] !== '玩家' + i.toString(36)) throw new Error('行不一致 ' + i);
      return Object.keys(table).length;
    };
    return net.node;
  }, { rows, nick });
}

async function connect(left, right, from, to) {
  const { offer, id } = await left.evaluate(async remote => {
    const p = window.peer = net.make(crypto.randomUUID(), location.origin, remote);
    p.replicaPages = true;
    net.attach(p, p.pc.createDataChannel('tide'));
    await p.pc.setLocalDescription(await p.pc.createOffer()); await net.ice(p.pc);
    return { offer: p.pc.localDescription.toJSON(), id: p.id };
  }, to);
  const answer = await right.evaluate(async ({ offer, id, remote }) => {
    const p = window.peer = net.make(id, location.origin, remote);
    p.replicaPages = true;
    await p.pc.setRemoteDescription(offer);
    await p.pc.setLocalDescription(await p.pc.createAnswer()); await net.ice(p.pc);
    return p.pc.localDescription.toJSON();
  }, { offer, id, remote: from });
  await left.evaluate(answer => peer.pc.setRemoteDescription(answer), answer);
  await Promise.all([left, right].map(p => p.waitForFunction(() => peer.dc?.readyState === 'open')));
}

async function setupFish(page, fishCount) {
  await page.goto('http://127.0.0.1:' + server.address().port);
  return page.evaluate(async fishCount => {
    const { World, CONFIG } = await import('/engine.js');
    const { Network } = await import('/network.js');
    const { verifyReplica } = await import('/replica.js');
    const { newIdentity, signer } = await import('/storage.js');
    const { ReplicaSwims, WorldBroadcast } = await import('/world-broadcast.js');
    const { SimulationClient, subscribeSimulationChanges } = await import('/simulation-client.js');
    const { makeFishWorld } = await import('/capacity-fish.mjs');
    const identity = await newIdentity(fishCount ? '发送方' : '接收方');
    const now = Date.UTC(2025, 5, 15, 12, 17);
    const body = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), ch: i === 3 ? 'o' : '鱼', color: '#8be7df' }));
    const world = window.world = makeFishWorld(World, fishCount, CONFIG.width, {
      now, body, spacingX: 4, spacingY: 3, rows: 22, mixedGenders: true
    });
    const arrivals = window.arrivals = [], rejected = window.rejected = [];
    const clock = () => performance.timeOrigin + performance.now();
    const channel = new WorldBroadcast(subscribeSimulationChanges);
    const movement = new ReplicaSwims();
    const poses = window.poses = () => Object.keys(world.data.fishes).sort().map(id => {
      const { x, y, facing, cx, cy, posAt } = world.data.fishes[id];
      return [id, x, y, facing, cx, cy, posAt, Object.values(world.data.travel[id]?.days || {})];
    });
    const samples = () => {
      const fish = poses(), stride = Math.max(1, Math.floor(fish.length / 16));
      return fish.filter((_, i) => i % stride === 0);
    };
    const net = window.net = new Network(identity, {}, async message => {
      if (!['hello', 'merge', 'world'].includes(message.kind)) return;
      const data = message.body.world, started = clock();
      await verifyReplica(data, {}, undefined, { current: world.data });
      const verified = clock();
      const apply = () => world.merge(data);
      const motion = message.kind === 'world' ? movement.merge(world.data, message, apply) : apply();
      const merged = clock();
      if (message.kind === 'world') arrivals.push({
        tick: data.tick, appliedTick: world.data.tick, delta: message.body.delta,
        rows: Object.keys(data.fishes).length, verifiedMs: verified - started, mergeMs: merged - verified,
        merged, samples: samples(), animated: motion?.directions?.flat().length || 0
      });
    }, () => {}, error => rejected.push(error.message));
    net.sign = await signer(identity);
    const ops = Object.values(world.data.ops);
    for (let i = 0; i < ops.length; i += 64) await Promise.all(ops.slice(i, i + 64).map(async op => {
      op.actor = identity.actor;
      world.data.fishes[op.id].actor = identity.actor;
      for (let j = 0; j < body.length; j++) world.data.chars[op.id + ':' + j].payer = identity.actor;
      op.proof = await net.makeEnvelope('op', op);
    }));
    window.joinReplica = () => net.direct(peer, 'hello', { world: world.serialize() },
      () => channel.captureJoined(world.data, () => world.serialize()), { capturedWorld: true });
    window.sendSteps = async rounds => {
      const simulation = new SimulationClient(), sent = [];
      let sending;
      const unsubscribe = subscribeSimulationChanges((target, patch) => {
        if (target !== world || !Number.isFinite(patch?.values?.tick)) return;
        const started = clock(), bytes = net.stats.sent;
        sending = channel.send(net, world.data, Date.now(), undefined, patch.swims).then(() => ({
          started, sendMs: clock() - started, wireBytes: net.stats.sent - bytes
        }));
      });
      try {
        if (!await simulation.open(world, () => true)) throw new Error('后台模拟没有启动');
        const schedule = performance.now();
        for (let i = 0; i < rounds; i++) {
          const remaining = schedule + i * CONFIG.step - performance.now();
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          const before = clock(), tick = world.data.tick + CONFIG.step;
          await simulation.advance(world, tick);
          if (world.data.tick !== tick || !sending) throw new Error('没有提交并发送模拟步骤');
          const packet = await sending;
          sending = null;
          sent.push({ tick, ...packet, simulationMs: packet.started - before, samples: samples() });
        }
        return { sent, poses: poses() };
      } finally { unsubscribe(); simulation.close(); }
    };
    return net.node;
  }, fishCount);
}

async function fishReplica(left, right) {
  const errors = [];
  let workers = 0;
  left.on('worker', () => workers++);
  for (const page of [left, right]) page.on('pageerror', error => errors.push(error.message));
  const [from, to] = await Promise.all([setupFish(left, count), setupFish(right, 0)]);
  await connect(left, right, from, to);
  await Promise.all([left, right].map(page => page.evaluate(() => joinReplica())));
  const initial = await right.evaluate(() => ({ fish: Object.keys(world.data.fishes).length, cells: Object.keys(world.data.chars).length }));
  assert.deepEqual(initial, { fish: count, cells: count * 9 });
  const { sent, poses } = await left.evaluate(rounds => sendSteps(rounds), rounds);
  await right.waitForFunction(n => arrivals.length >= n || rejected.length, rounds);
  const received = await right.evaluate(() => ({ arrivals, poses: poses(), rejected, rejects: net.stats.rejected }));
  assert.deepEqual(received.rejected, []);
  assert.equal(received.rejects, 0);
  assert.deepEqual(errors, []);
  assert.equal(workers, 1);
  assert.deepEqual(received.arrivals.map(packet => packet.tick), sent.map(packet => packet.tick));
  const deliveries = sent.map(({ samples, started, ...packet }, i) => {
    const arrival = received.arrivals[i];
    assert.equal(arrival.delta, true, '应保留已加入后的日常增量');
    assert.equal(arrival.appliedTick, packet.tick);
    assert(arrival.rows > 0 && packet.wireBytes > 0);
    assert.deepEqual(arrival.samples, samples);
    return { ...packet, sendOffsetMs: started - sent[0].started, rows: arrival.rows,
      animated: arrival.animated, deliveryMs: arrival.merged - started,
      verifiedMs: arrival.verifiedMs, mergeMs: arrival.mergeMs };
  });
  assert.equal(received.poses.length, count);
  for (let i = 0; i < poses.length; i++) assert.deepEqual(received.poses[i], poses[i], poses[i][0]);
  const wireBytes = deliveries.reduce((sum, packet) => sum + packet.wireBytes, 0);
  console.log(JSON.stringify({ browser: browser.version(), initial, rounds, workers, rejected: received.rejects,
    missing: sent.length - received.arrivals.length, comparedFinalPoses: poses.length,
    wireBytesPerSecond: wireBytes / (rounds * .5), deliveries }, null, 2));
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const left = await browser.newPage(), right = await browser.newPage();
  if (fishMode) return fishReplica(left, right);
  const [from, to] = await Promise.all([setup(left, count, '发送方'), setup(right, 0, '接收方')]);
  await connect(left, right, from, to);
  const hello = p => p.evaluate(() => net.direct(peer, 'hello', { world: world.serialize() }, () => {
    if (window.sampleSize) world.data.participants[net.node] = '同步期间加入';
    return world.serialize();
  }));
  await right.evaluate(() => { window.cut = true; });
  const started = Date.now();
  await assert.rejects(hello(left));
  assert.deepEqual(await right.evaluate(() => arrivals), []);
  await connect(left, right, from, to);
  await Promise.all([hello(left), hello(right)]);
  const joinedMs = Date.now() - started;
  const total = await right.evaluate(n => verifyRows(n), count);
  assert(total >= count);
  await left.evaluate(() => {
    const update = new Map([['补发', '已确认']]);
    const delta = { ...world.data, participants: Object.fromEntries(update) };
    return net.broadcast('world', { delta: true, world: delta });
  });
  await right.waitForFunction(() => world.data.participants['补发'] === '已确认');
  const received = await right.evaluate(() => ({ rejected: net.stats.rejected, wireBytes: net.stats.received, catchupRows, arrivals }));
  assert.equal(received.catchupRows, 1);
  assert.equal(received.rejected, 0);
  const pages = await left.evaluate(() => pagesSent);
  assert.deepEqual(pages.first.slice(0, 4), [0, 1, 2, 2]);
  console.log(JSON.stringify({ participants: count, joinedAndResumedMs: joinedMs, pages, ...received }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); server.closeAllConnections(); server.close();
});
