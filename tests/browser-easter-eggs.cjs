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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const setup = await context.newPage(); await setup.goto(origin + '/welcome.html');
  const fixture = await setup.evaluate(async () => {
    const { World } = await import('./engine.js'), { newIdentity, get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const { updateContacts, finishBreeding } = await import('./breeding.js'), { lifeContext, updateLife, recordStory } = await import('./life.js');
    const { ancestralGlyph } = await import('./easter-eggs.js');
    const me = await newIdentity('彩蛋观察员'); me.registration.joined = true;
    const n = new Network(me, {}, () => {}, () => {}); n.sign = await signer(me);
    const now = Date.now(), born = now - 5 * 3600000, w = new World(born, undefined, { populate: false });
    async function apply(body, at = born) { const op = { id: crypto.randomUUID(), actor: me.actor, nick: me.nick, roots: w.roots, t: at, ...body }; const proof = await n.makeEnvelope('op', op); const result = w.apply({ ...op, proof }); if (!result.ok) throw new Error(result.error); return op.id; }
    for (let serial = 1; serial <= 60; serial++) await apply({ id: `${me.actor}:hour:${serial}`, kind: 'earn', serial, cost: 0 }); me.serial = 60;
    const body = Array.from({ length: 14 }, (_, i) => ({ x: i % 7, y: Math.floor(i / 7), ch: i === 10 ? '木' : 'o', color: '#88aacc' }));
    let descendant = await apply({ kind: 'fish', x: 500, y: 40, gender: 'male', cells: body, name: '木的祖先', cost: 14 }), at = born;
    const glyphId = w.fishCells(descendant).find(c => c.ch === '木').id;
    const transition = (c, next, event) => { Object.assign(c, next); c.path.push({ ...event, target: next.entity || '', x: next.x, y: next.y }); };
    for (let generation = 0; generation < 3; generation++) {
      const parent = w.data.fishes[descendant], wood = w.data.chars[glyphId], gender = w.fishOrigin(descendant).gender;
      const partner = await apply({ kind: 'fish', x: parent.x, y: parent.y + (wood.y === 0 ? -2 : 2), gender: gender === 'male' ? 'female' : 'male', cells: body.map(c => ({ ...c, ch: 'o' })), name: '一位亲鱼', cost: 14 }, at);
      for (let ms = 0; ms <= 5000; ms += 500) updateContacts(w, at + ms, w.fishGroups(), w.sceneryMap());
      const r = Object.values(w.data.breeding).find(r => r.status === 'active' && [r.male, r.female].includes(descendant)); if (!r) throw new Error('没有配对');
      at = r.ends; finishBreeding(w, at, transition); if (r.status !== 'born') throw new Error('没有出生');
      for (const id of [descendant, partner]) { w.data.fishes[id].x = 650 + generation * 30; w.data.fishes[id].posAt = at; }
      descendant = r.baby.id;
    }
    if (!ancestralGlyph(w.data, descendant)) throw new Error('真实三代继承没有识别');
    const small = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: '木', color: '#88aacc' }];
    const observer = await apply({ kind: 'fish', x: 370, y: 23, gender: 'male', cells: small, cost: 2 }, now - 60000);
    const friend = await apply({ kind: 'fish', x: 376, y: 23, gender: 'male', cells: small, cost: 2 }, now - 60000);
    const scene = await apply({ kind: 'scene', x: 373, y: 28, cells: small, cost: 2 }, now - 60000);
    w.data.life.at = now - 60000;
    for (let s = 1; s <= 45; s++) updateLife(w, now - 60000 + s * 1000, lifeContext(w, now - 60000 + s * 1000, w.sceneryMap(), w.fishGroups()));
    await apply({ kind: 'sceneMove', scene, x: 430, y: 28, cost: 0 }, now - 14000);
    updateLife(w, now - 14000, lifeContext(w, now - 14000, w.sceneryMap(), w.fishGroups()));
    w.data.fishes[observer].x = 400; updateLife(w, now - 13000, lifeContext(w, now - 13000, w.sceneryMap(), w.fishGroups()));
    w.data.fishes[observer].x = 370; updateLife(w, now - 12000, lifeContext(w, now - 12000, w.sceneryMap(), w.fishGroups()));
    const message = await n.makeEnvelope('chat', { nick: me.nick, text: '木👩‍🚀 <script>window.memoryExecuted=1</script>', t: born - 1000, roots: [crypto.randomUUID()] });
    w.data.chatSources[message.id] = message; w.reconcileChatFloor(now);
    w.data.tick = now; me.lifeSeenAt = now; await set('identity', me); await set('known', []); await set('checkpoint', { world: w.serialize(), lastOnlineAt: now });
    return { descendant, observer, scene, memory: Object.values(w.data.chars).find(c => c.chat && c.ch === '木').id, balance: w.wallet(me.actor), text: message.body.text };
  }); await setup.close();
  let page = await open(context);
  await page.locator('#myFish').click(); await page.locator(`.fishCard[data-fish="${fixture.descendant}"]`).click();
  assert.match(await page.locator('#fishHeirloom').textContent(), /木.*木的祖先.*4 代/); await page.screenshot({ path: path.join(output, 'easter-inheritance-desktop.png') });
  await page.locator('#closeInspector').click(); await page.locator('#myFish').click(); await page.locator('#pedigreeTab').click(); await page.locator('#pedigreeRoot').selectOption(fixture.descendant);
  assert.match(await page.locator('#pedigreeHeirloom').textContent(), /4 代/); await page.screenshot({ path: path.join(output, 'easter-pedigree-desktop.png') }); await page.locator('#closeMyFish').click();
  await page.locator('#myFish').click(); await page.locator('#myFishStories').click(); assert.match(await page.locator('#lifeStories').textContent(), /风景换了/); await page.locator('#closeLife').click();
  async function clickMemory() {
    const p = await page.evaluate(id => { const c = tide.world.data.chars[id], camera = tide.view.camera, size = 18 * tide.view.scale; let dx = (c.x - camera.x + 1500) % 1000 - 500; return { x: innerWidth / 2 + (dx + .5) * size, y: innerHeight / 2 + (c.y - camera.y + .5) * size }; }, fixture.memory); await page.mouse.click(p.x, p.y);
  }
  // Drag the world so the memory is visible in clear water beside the tools.
  async function frameMemory() {
    await page.locator('#seabed').click();
    const delta = await page.evaluate(id => { const c = tide.world.data.chars[id], camera = tide.view.camera, size = 18 * tide.view.scale; return { x: -(((c.x - camera.x + 1500) % 1000 - 500) * size), y: -(c.y - camera.y) * size }; }, fixture.memory);
    await page.mouse.move(600, 500); await page.mouse.down(); await page.mouse.move(600 + delta.x, 500 + delta.y, { steps: 3 }); await page.mouse.up();
  }
  await frameMemory(); await clickMemory(); await page.locator('#chatMemory').waitFor({ state: 'visible' }); await page.locator('#memoryDetails summary').click();
  assert.equal(await page.locator('#memoryText').textContent(), fixture.text); assert.equal(await page.locator('#memoryText script').count(), 0); assert.equal(await page.evaluate(() => window.memoryExecuted), undefined);
  await page.screenshot({ path: path.join(output, 'easter-archaeology-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'easter-archaeology-mobile.png') }); const box = await page.locator('#inspector').boundingBox(); assert(box.x >= 0 && box.x + box.width <= 390);
  await page.locator('#closeInspector').click(); await page.locator('#myFish').click(); await page.locator('#pedigreeTab').click(); await page.locator('#pedigreeRoot').selectOption(fixture.descendant); assert(await page.locator('#pedigreeHeirloom').isVisible()); await page.screenshot({ path: path.join(output, 'easter-pedigree-mobile.png') }); await page.locator('#closeMyFish').click();
  await page.close(); page = await open(context); assert.equal(await page.evaluate(() => tide.balance()), fixture.balance); assert(await page.evaluate(async id => !!(await import('./easter-eggs.js')).ancestralGlyph(tide.world.data, id), fixture.descendant));
  const peerContext = await browser.newContext(); const peerSetup = await peerContext.newPage(); await peerSetup.goto(origin + '/welcome.html');
  await peerSetup.evaluate(async () => { const { newIdentity, set } = await import('./storage.js'); const identity = await newIdentity('彩蛋同伴'); identity.registration.joined = true; await set('identity', identity); }); await peerSetup.close();
  const peer = await open(peerContext); await peer.locator('#connect').click(); await peer.locator('#peerUrl').fill(origin); await peer.locator('#connectionForm .primary').click();
  await peer.waitForFunction(fixture => !!tide.world.data.life.haunts[fixture.observer] && !!tide.world.data.chars[fixture.memory] && !!tide.world.data.fishes[fixture.descendant], fixture);
  assert(await peer.evaluate(async id => !!(await import('./easter-eggs.js')).ancestralGlyph(tide.world.data, id), fixture.descendant));
  await page.close(); await peer.waitForFunction(() => tide.network.leader === tide.network.node);
  assert(await peer.evaluate(() => Object.values(tide.world.data.life.stories).some(s => s.kind === 'revisit')));
  await peer.setViewportSize({ width: 1440, height: 900 });
  const rendered = await peer.evaluate(async () => {
    const { World } = await import('./engine.js'), { Renderer } = await import('./renderer.js'), { bubbleGlyph } = await import('./bubbles.js');
    const { recordStory, pairKey } = await import('./life.js'), { hasFriendSecret } = await import('./easter-eggs.js'), { CHAT_FLOOR } = await import('./chat.js');
    const now = Date.now(), w = new World(now - 60000, undefined, { populate: false }), cells = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: '木', color: '#88aacc' }];
    const other = crypto.randomUUID(); let id, story;
    do { id = crypto.randomUUID(); story = { id: `reunion:${id}:${other}:${Math.floor((now - 2000) / 600000)}`, kind: 'reunion', fish: id, other, at: now - 2000 }; } while (!hasFriendSecret(story));
    for (const [fish, x] of [[id, 383], [other, 391]]) w.apply({ id: fish, kind: 'fish', actor: fish, nick: '鱼', cells, cost: 2, t: now - 60000, x, y: 30 });
    recordStory(w, 'reunion', id, now - 2000, { other }); const [a, b] = [id, other].sort(); w.data.life.bonds[pairKey(a, b)] = { a, b, seconds: 45, lastNear: now, at: now, run: 0 };
    w.data.scenes[CHAT_FLOOR] = { x: 0, y: 0 }; w.data.chars.old = { id: 'old', ch: '木', color: '#719987', kind: 'scene', entity: CHAT_FLOOR, x: 385, y: 31, chat: 'old-message' };
    for (const [i, ch] of ['咕', '噜', '？'].entries()) { let n = 0, bubble; do { bubble = { id: `visual:${ch}:${n++}`, born: now - 30000, x: 365 + i * 6, depth: 62 }; } while (bubbleGlyph(bubble) !== ch); w.data.bubbles[bubble.id] = bubble; }
    const r = new Renderer(document.createElement('canvas')); r.camera = { x: 380, y: 30 }; const glyphs = [], original = r.glyph; r.glyph = function(...args) { glyphs.push({ ch: args[1], color: args[2] }); return original.apply(this, args); };
    r.draw(w); return { png: r.canvas.toDataURL('image/png').split(',')[1], glyphs };
  });
  for (const ch of ['咕', '噜', '？', '久']) assert(rendered.glyphs.some(g => g.ch === ch)); assert(rendered.glyphs.some(g => g.ch === '木' && g.color === '#d7efe1'));
  fs.writeFileSync(path.join(output, 'easter-ambient-desktop.png'), Buffer.from(rendered.png, 'base64'));
  assert.equal(errors.length, 0, errors.join('\n')); fs.writeFileSync(path.join(output, 'easter-browser-results.json'), JSON.stringify({ passed: true, checks: ['真实三代鱼元继承', '观察与鱼谱展示', '旧地重游故事', '海底考古全文及安全文本', '桌面及手机布局', '刷新存档与余额', '真实WebRTC同步及协调者接替', '气泡暗号及海底回声绘制'], errors }, null, 2)); console.log('Easter egg browser checks passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); server.close(); });
