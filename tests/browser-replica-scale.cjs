const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const www = path.resolve(__dirname, '../www');
const count = Number(process.argv[2] || 100000);
assert(Number.isSafeInteger(count) && count > 0);
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.setHeader('content-type', 'text/html').end('<!doctype html><title>联机容量验证</title>');
  if (!/^\/[a-z0-9-]+\.js$/.test(req.url)) return res.writeHead(404).end();
  res.setHeader('content-type', 'text/javascript');
  fs.createReadStream(path.join(www, req.url.slice(1))).on('error', () => res.destroy()).pipe(res);
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

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const left = await browser.newPage(), right = await browser.newPage();
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
