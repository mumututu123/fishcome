const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'test-output'), children = [], errors = [], born = Math.floor(Date.now() / 60000) * 60000;
const exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'); let browser;
async function helper(port) { const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); const end = Date.now() + 20000; while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('启动器未就绪'); }
async function context(initial = born + 1000) { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await c.addInitScript(initial => { let clock = initial; try { clock = Number(localStorage.getItem('bubble-test-clock')) || initial; } catch {} window.bubbleTestNow = clock; window.bubbleClockStart = performance.now(); Date.now = () => Math.floor(window.bubbleTestNow + performance.now() - window.bubbleClockStart); }, initial); return c; }
async function open(c, port, nick) { const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(`http://127.0.0.1:${port}/`); if (nick) { await p.locator('#nickInput').fill(nick); await p.locator('#welcomeForm .primary').click(); } await p.waitForFunction(() => window.tide); return p; }
async function clock(p, now) { await p.evaluate(now => { window.bubbleTestNow = now; window.bubbleClockStart = performance.now(); localStorage.setItem('bubble-test-clock', String(now)); }, now); }
async function rendered(p, id, expected) {
  const result = await p.evaluate(async id => { const { Renderer } = await import('./renderer.js'), { World } = await import('./engine.js'), { bubbleState } = await import('./bubbles.js'); const w = new World(); w.data = tide.world.data; const state = bubbleState(w.data.bubbles[id], Date.now()); if (!state) return null; const r = new Renderer(document.createElement('canvas')), calls = [], original = r.glyph.bind(r); r.camera = { x: state.x + (state.size - 1) / 2, y: state.y + (state.size - 1) / 2 }; r.glyph = (...args) => { if (args[1] === '泡') calls.push({ color: args[2], x: args[3], y: args[4] }); original(...args); }; r.draw(w); return { size: state.size, glyphs: calls.length, colors: calls.map(call => call.color) }; }, id);
  assert(result); assert.equal(result.size, expected); assert.equal(result.glyphs, expected * expected); assert(result.colors.every(color => color === '#ffffff'));
}
async function pan(p, id) { const target = await p.evaluate(async id => { const { bubbleState } = await import('./bubbles.js'); const state = bubbleState(tide.world.data.bubbles[id], Date.now()), view = tide.view; return { dx: (view.camera.x - state.x) * 18 * view.scale, dy: (view.camera.y - state.y - state.size / 2) * 18 * view.scale }; }, id); await p.mouse.move(700, 350); await p.mouse.down(); await p.mouse.move(700 + target.dx, 350 + target.dy, { steps: 3 }); await p.mouse.up(); }
async function main() {
  fs.mkdirSync(output, { recursive: true }); for (const port of [39751, 39752, 39753]) await helper(port);
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true }); const ca = await context(), cb = await context();
  let a = await open(ca, 39751, '气泡测试'), b = await open(cb, 39752, '气泡邻居'); await a.close();
  const setup = await ca.newPage(); await setup.goto('http://127.0.0.1:39751/welcome.html');
  const fixture = await setup.evaluate(async born => {
    const { World, hash } = await import('./engine.js'), { bubbleRoll, bubbleId } = await import('./bubbles.js'), { HOUR, GREENS, growthRoll, weedId } = await import('./seaweed.js'), { makeTerrain } = await import('./geography.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), checkpoint = await get('checkpoint'), x = 624, minute = Math.floor(born / 60000); let world;
    do { world = new World(born, undefined, { populate: false }); } while (world.floorAt(x) < 96);
    const root = world.id, depth = world.floorAt(x) - 1, source = `floor:${x}`; let hour = Math.floor(born / HOUR) - 100000, id;
    do { hour++; id = weedId(source, hour, hash); } while (!growthRoll(source, hour, hash) || !bubbleRoll(id, minute, depth));
    const createdAt = (hour - 1) * HOUR; world.data.roots[root] = createdAt; world.data.terrain = makeTerrain(root, createdAt); world.data.tick = Date.now(); world.data.seaweedHour = Math.floor(Date.now() / HOUR); world.data.bubbleMinute = minute - 1;
    world.data.chars[id] = { id, kind: 'seaweed', entity: id, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x, y: depth, created: hour * HOUR, path: [], wild: { source, hour, plant: id, index: 0, x, y: depth } };
    const sender = new Network(identity, {}, () => {}, () => {}); sender.sign = await signer(identity); const cell = (x, y) => ({ x, y, ch: 'Q', color: '#88aacc' });
    async function apply(body) { const op = { id: crypto.randomUUID(), actor: identity.actor, nick: identity.nick, t: Date.now(), roots: [world.id], ...body }, result = world.apply({ ...op, proof: await sender.makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error); return op.id; }
    const fish = await apply({ kind: 'fish', x, y: depth - 26, cells: [cell(0, 0), cell(0, 1)], cost: 2 });
    await apply({ kind: 'scene', x: x - 1, y: depth - 27, cells: [...Array.from({ length: 3 }, (_, x) => cell(x, 0)), ...Array.from({ length: 3 }, (_, x) => cell(x, 3)), cell(0, 1), cell(0, 2), cell(2, 1), cell(2, 2)], cost: 10 });
    await set('checkpoint', { ...checkpoint, world: world.serialize(), lastOnlineAt: Date.now() }); return { bubble: bubbleId(id, minute), source: id, fish, depth };
  }, born); await setup.close(); a = await open(ca, 39751); await clock(a, born + 10000); await clock(b, born + 10000); await a.waitForFunction(id => !!tide.world.data.bubbles[id], fixture.bubble);
  await b.locator('#connect').click(); await b.locator('#peerUrl').fill('http://127.0.0.1:39751'); await b.locator('#connectionForm .primary').click(); await b.waitForFunction(id => !!tide.world.data.bubbles[id], fixture.bubble); await a.waitForFunction(() => tide.balance() === 18);
  const quota = await a.evaluate(() => tide.balance()); const initial = await a.evaluate(id => tide.world.data.bubbles[id], fixture.bubble); assert.equal(initial.born, born); assert.deepEqual(await b.evaluate(id => tide.world.data.bubbles[id], fixture.bubble), initial);
  const backupClock = born + 50000; let backup;
  for (const [rise, size] of [[10000, 1], [25000, 2], [50000, 3], [75000, 4]]) {
    for (const p of [a, b]) await clock(p, born + rise); await a.waitForFunction(now => tide.world.data.tick >= now - 500, born + rise); await b.waitForFunction(now => tide.world.data.tick >= now - 1000, born + rise);
    for (const p of [a, b]) await rendered(p, fixture.bubble, size); await pan(a, fixture.bubble); await a.screenshot({ path: path.join(output, `bubbles-${size}x${size}.png`) }); assert.equal(await a.evaluate(() => tide.balance()), quota);
    if (size === 2) assert.equal(await a.evaluate(id => tide.world.data.fishes[id].y, fixture.fish), fixture.depth - 26);
    if (size === 3) backup = await a.evaluate(async () => { const { get } = await import('./storage.js'); return { identity: await get('identity'), checkpoint: { world: tide.world.data, lastOnlineAt: Date.now(), at: Date.now() } }; });
  }
  const imported = await context(backupClock), importPage = await imported.newPage(); await importPage.goto('http://127.0.0.1:39753/welcome.html'); await importPage.evaluate(async backup => (await import('./storage.js')).putMany([['identity', backup.identity], ['checkpoint', backup.checkpoint], ['known', []], ['histories', {}]]), backup); await importPage.close(); const restored = await open(imported, 39753); assert.equal(await restored.evaluate(id => tide.world.data.bubbles[id].born, fixture.bubble), born); await rendered(restored, fixture.bubble, 3); assert.equal(await restored.evaluate(() => tide.balance()), quota); await restored.close(); await imported.close();
  const surfaced = born + (fixture.depth + 5) * 1000; for (const p of [a, b]) await clock(p, surfaced); await a.waitForFunction(id => !tide.world.data.bubbles[id], fixture.bubble); await b.waitForFunction(id => !tide.world.data.bubbles[id], fixture.bubble);
  assert.equal(await a.evaluate(id => tide.world.data.chars[id].kind, fixture.source), 'seaweed'); assert.equal(await a.evaluate(id => Object.values(tide.world.data.chars).filter(cell => cell.kind === 'fish' && cell.entity === id).length, fixture.fish), 2); assert.equal(await a.evaluate(() => tide.balance()), quota);
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(output, 'browser-bubbles-results.json'), JSON.stringify({ passed: true, glyph: '泡', color: '#ffffff', sizes: [1, 2, 3, 4], checks: ['minute emission', 'WebRTC sync', 'rendered square glyph counts', 'fish and scenery penetration', 'quota unchanged', 'backup restores birth and size', 'surface deletes entire bubble'], errors }, null, 2)); console.log('海草分钟发泡、白色1×1到4×4字符渲染、无碰撞、WebRTC同步、配额不变、备份恢复及触海面整体消失通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
