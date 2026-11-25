const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'test-output'), clients = new Map(), errors = [];
let origin, browser;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost'), route = url.pathname;
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (route === '/local/meta') return json({ token: 'test', url: origin });
  if (route === '/local/events') {
    const client = clients.get(url.searchParams.get('node')); if (!client) { response.writeHead(404); return response.end(); }
    client.response = response; client.active = true; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); response.on('close', () => client.active = false); return;
  }
  if (route.startsWith('/local/')) {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : {};
    if (route === '/local/register') clients.set(body.node, { id: body.node, nick: body.nick, active: false });
    if (route === '/local/unregister' && clients.has(body.node)) clients.get(body.node).active = false;
    if (route === '/local/probe') return json({ ok: true, clients: [...clients.values()].filter(c => c.active).map(c => ({ id: c.id, nick: c.nick, peers: 0, url: origin })), hints: [] });
    if (route === '/local/relay') { const target = clients.get(body.signal.to); if (!target?.active) return json({ ok: false }); target.response.write(`data: ${JSON.stringify({ ...body.signal, fromUrl: origin })}\n\n`); }
    return json({ ok: true, clients: [], hints: [] });
  }
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); return response.end(); }
  response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file));
});
async function open(context) { const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await page.waitForFunction(() => window.tide); return page; }
async function main() {
  fs.mkdirSync(output, { recursive: true }); await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const fixedTime = Math.floor(Date.now() / 360000) * 360000 + 10000, results = [];
  let bottleContext, bottlePage, bottleFixture;
  for (const kind of ['whale', 'hiccup', 'bottle', 'meeting', 'blossom', 'meteor', 'radio', 'parade']) {
    const viewTime = fixedTime + (kind === 'radio' ? 14000 : 0);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(time => { Date.now = () => time; }, viewTime);
    const setup = await context.newPage(); await setup.goto(origin + '/welcome.html');
    const fixture = await setup.evaluate(async ({ kind, fixedTime }) => {
      const { World, hash } = await import('./engine.js'), { newIdentity, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
      const { eventSchedule, updateEvents, activeEvent } = await import('./random-events.js'), { lifeContext, recordStory, pairKey } = await import('./life.js');
      const { HOUR, weedId, growthRoll, GREENS } = await import('./seaweed.js');
      const me = await newIdentity('随机事件观察员'); me.registration.joined = true;
      const born = fixedTime - 3 * 3600000, slot = Math.floor(fixedTime / 360000); let seed, schedule;
      do { seed = crypto.randomUUID(); schedule = eventSchedule({ [seed]: born }, seed, slot); } while (!schedule || schedule.kind !== kind || !schedule.rare);
      const w = new World(born, seed, { populate: false }), n = new Network(me, {}, () => {}, () => {}); n.sign = await signer(me);
      const cells = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: '鱼', color: '#88aacc' }], fishes = [];
      for (let i = 0; i < 4; i++) {
        const op = { id: crypto.randomUUID(), actor: me.actor, nick: me.nick, roots: w.roots, t: born, kind: 'fish', name: `鱼${i}`, x: 371 + i * 3, y: 23, gender: 'male', cells, cost: 2 };
        const proof = await n.makeEnvelope('op', op); const result = w.apply({ ...op, proof }); if (!result.ok) throw new Error(result.error); fishes.push(op.id);
      }
      for (const a of fishes) for (const b of fishes) if (a < b) w.data.life.bonds[pairKey(a, b)] = { a, b, seconds: 50, run: 0, at: fixedTime, lastNear: fixedTime };
      for (let x = 372; x < 379; x++) {
        const source = `floor:${x}`, depth = w.floorAt(x) - 1; let hour = Math.floor((schedule.started - HOUR) / HOUR); while (!growthRoll(source, hour, hash)) hour--;
        const id = weedId(source, hour, hash); w.data.chars[id] = { id, kind: 'seaweed', entity: id, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x, y: depth, created: hour * HOUR, path: [], wild: { source, hour, plant: id, index: 0, x, y: depth } };
      }
      updateEvents(w, schedule.started + 500, lifeContext(w, schedule.started + 500, w.sceneryMap(), w.fishGroups()), true, recordStory);
      const event = activeEvent(w.data, fixedTime); if (!event) throw new Error('事件没有出现：' + kind);
      w.data.life.at = fixedTime; w.data.tick = fixedTime; me.lifeSeenAt = fixedTime;
      await set('identity', me); await set('known', []); await set('checkpoint', { world: w.serialize(), lastOnlineAt: fixedTime });
      return { id: event.id, fishes, plants: event.plants, counts: w.counts(), balance: w.wallet(me.actor) };
    }, { kind, fixedTime: viewTime }); await setup.close();
    let page = await open(context); await page.locator('#ambientPeek').waitFor({ state: 'visible' }); assert.match(await page.locator('#ambientPeek').textContent(), /看看/);
    await page.locator('#ambientPeek').click();
    if (kind === 'bottle' || kind === 'radio') {
      await page.locator('#eventDetails').waitFor({ state: 'visible' }); const text = await page.locator('#eventText').textContent();
      assert(kind === 'bottle' ? text === '？' : text.includes('主播去吃草了')); assert(await page.locator('#sceneActions').isHidden());
      if (kind === 'bottle') { assert.match(await page.locator('#objectInfo').textContent(), /全文完/); await page.locator('#closeInspector').click(); const p = await page.evaluate(async () => { const { activeEvent, eventPosition } = await import('./random-events.js'); const e = activeEvent(tide.world.data, Date.now()), p = eventPosition(e, Date.now()), view = tide.view, size = 18 * view.scale; return { x: innerWidth / 2 + ((p.x - view.camera.x + 1500) % 1000 - 500 + .5) * size, y: innerHeight / 2 + (p.y - view.camera.y + .5) * size }; }); await page.mouse.click(p.x, p.y); assert(await page.locator('#eventDetails').isVisible(), '漂流瓶在水中不能点击'); }
    }
    const visibleGlyphs = await page.evaluate(async () => {
      const { activeEvent } = await import('./random-events.js'), { eventGlyphs } = await import('./random-event-visuals.js'), { Renderer } = await import('./renderer.js'), { World } = await import('./engine.js');
      const data = tide.world.data, e = activeEvent(data, Date.now()), glyphs = eventGlyphs(data, e, Date.now());
      const w = new World(Date.now(), undefined, { populate: false }); w.data = data; const r = new Renderer(document.createElement('canvas')); r.camera = tide.view.camera; const rendered = [], original = r.glyph; r.glyph = function(...args) { rendered.push(args[1]); return original.apply(this, args); }; r.draw(w);
      return { count: glyphs.length, rendered, rare: e.rare };
    }); assert(visibleGlyphs.count > 0); assert(visibleGlyphs.rare); assert(visibleGlyphs.rendered.length > 0);
    await page.screenshot({ path: path.join(output, `random-${kind}-desktop.png`) });
    if (kind === 'whale') { await page.setViewportSize({ width: 390, height: 844 }); const peek = await page.locator('#ambientPeek').boundingBox(); assert(peek.x >= 70 && peek.x + peek.width <= 390, '手机事件入口超出屏幕或遮挡工具'); await page.screenshot({ path: path.join(output, 'random-whale-mobile.png') }); }
    if (kind === 'bottle' || kind === 'radio') { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, `random-${kind}-mobile.png`) }); const box = await page.locator('#inspector').boundingBox(); assert(box.x >= 0 && box.x + box.width <= 390); }
    assert.deepEqual(await page.evaluate(() => tide.world.counts), fixture.counts); assert.equal(await page.evaluate(() => tide.balance()), fixture.balance);
    if (kind === 'hiccup') {
      const plantPeerContext = await browser.newContext(); await plantPeerContext.addInitScript(time => { Date.now = () => time; }, viewTime);
      const plantSetup = await plantPeerContext.newPage(); await plantSetup.goto(origin + '/welcome.html'); await plantSetup.evaluate(async () => { const { newIdentity, set } = await import('./storage.js'); const me = await newIdentity('海草事件同伴'); me.registration.joined = true; await set('identity', me); }); await plantSetup.close();
      const plantPeer = await open(plantPeerContext); await plantPeer.locator('#connect').click(); await plantPeer.locator('#peerUrl').fill(origin); await plantPeer.locator('#connectionForm .primary').click();
      await plantPeer.waitForFunction(f => !!tide.world.data.life.events[f.id] && f.plants.every(id => !!tide.world.data.chars[id]?.wild), fixture);
      assert.deepEqual(await plantPeer.evaluate(id => tide.world.data.life.events[id], fixture.id), await page.evaluate(id => tide.world.data.life.events[id], fixture.id)); await plantPeerContext.close();
    }
    if (kind === 'bottle') { bottleContext = context; bottlePage = page; bottleFixture = fixture; } else await context.close();
    results.push({ kind, glyphs: visibleGlyphs.count, passed: true });
  }
  // Real WebRTC carries the chosen plan; a new coordinator does not choose a new letter.
  const peerContext = await browser.newContext(); await peerContext.addInitScript(time => { Date.now = () => time; }, fixedTime);
  const peerSetup = await peerContext.newPage(); await peerSetup.goto(origin + '/welcome.html'); await peerSetup.evaluate(async () => { const { newIdentity, set } = await import('./storage.js'); const me = await newIdentity('事件同伴'); me.registration.joined = true; await set('identity', me); }); await peerSetup.close();
  const peer = await open(peerContext); await peer.locator('#connect').click(); await peer.locator('#peerUrl').fill(origin); await peer.locator('#connectionForm .primary').click(); await peer.waitForFunction(id => !!tide.world.data.life.events[id], bottleFixture.id);
  assert.deepEqual(await peer.evaluate(id => tide.world.data.life.events[id], bottleFixture.id), await bottlePage.evaluate(id => tide.world.data.life.events[id], bottleFixture.id));
  await bottlePage.close(); await peer.waitForFunction(() => tide.network.leader === tide.network.node); assert(await peer.evaluate(async id => (await import('./random-events.js')).activeEvent(tide.world.data, Date.now())?.id === id, bottleFixture.id));
  bottlePage = await open(bottleContext); assert(await bottlePage.evaluate(async id => (await import('./random-events.js')).activeEvent(tide.world.data, Date.now())?.id === id, bottleFixture.id)); assert.equal(await bottlePage.evaluate(() => tide.balance()), bottleFixture.balance);
  assert.equal(errors.length, 0, errors.join('\n')); fs.writeFileSync(path.join(output, 'random-events-browser-results.json'), JSON.stringify({ passed: true, events: results, checks: ['八种事件实际渲染及稀有变体', '漂流瓶水中点击及电台阅读', '桌面及手机布局', '字符数与余额不变', '真实WebRTC完整计划同步', '协调者接替及刷新保持原事件'], errors }, null, 2)); console.log('Random event browser checks passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); server.close(); });
