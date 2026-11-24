const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), children = [], errors = [], output = path.join(project, 'test-output'), exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'); let browser;
async function helper(port) { const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); const end = Date.now() + 20000; while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('启动器未就绪'); }
async function open(context, port, nick) { const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`http://127.0.0.1:${port}/`); if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); } await page.waitForFunction(() => window.tide); return page; }
async function allInWater(page) { assert(await page.evaluate(() => { const data = tide.world.data, width = data.terrain.depths.length, wrap = x => (x % width + width) % width; return Object.values(data.chars).every(c => { if (c.kind === 'burn') return true; const entity = c.kind === 'fish' ? data.fishes[c.entity] : c.kind === 'scene' ? data.scenes[c.entity] : null, x = wrap(entity ? entity.x + (c.kind === 'fish' ? entity.facing : 1) * c.x : c.x), y = entity ? entity.y + c.y : c.y; return y >= 0 && y < data.terrain.depths[x]; }); })); }
async function main() {
  fs.mkdirSync(output, { recursive: true }); await helper(39641); await helper(39642);
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const ca = await browser.newContext({ viewport: { width: 1440, height: 900 } }), cb = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(ca, 39641, '海底昵称测试'), b = await open(cb, 39642, '环海伙伴'); await a.close();
  const setup = await ca.newPage(); await setup.goto('http://127.0.0.1:39641/welcome.html');
  const fixture = await setup.evaluate(async () => {
    const { World, hash } = await import('./engine.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), checkpoint = await get('checkpoint'), now = Date.now(), [root, createdAt] = Object.entries(checkpoint.world.roots)[0], world = new World(createdAt, root), sender = new Network(identity, {}, () => {}, () => {}); sender.sign = await signer(identity);
    world.data.tick = now; world.data.seaweedHour = Math.floor(now / 3600000);
    function directed(dx) { while (true) { const id = crypto.randomUUID(), value = hash(`${id}:0`); if ([-1, 0, 1][value % 3] === dx && [-1, 0, 1][Math.floor(value / 3) % 3] === 0) return id; } }
    async function apply(body) { const op = { id: crypto.randomUUID(), actor: identity.actor, nick: '海＊＊试', t: now, roots: [world.id], ...body }; const result = world.apply({ ...op, proof: await sender.makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error); return op.id; }
    const cells = [{ x: 0, y: 0, ch: 'Q', color: '#88aacc' }, { x: 0, y: 1, ch: 'Q', color: '#88aacc' }];
    const east = await apply({ id: directed(1), kind: 'fish', x: 999, y: 20, cells, cost: 2 }), west = await apply({ id: directed(-1), kind: 'fish', x: 0, y: 24, cells, cost: 2 }), publicFish = await apply({ id: directed(0), kind: 'fish', x: 390, y: 20, cells, cost: 2 }), legacy = await apply({ id: directed(0), kind: 'fish', x: 600, y: 40, cells, cost: 2 });
    const scene = await apply({ kind: 'scene', x: 603, y: 40, cells, cost: 2 }), meal = await apply({ kind: 'food', x: 604, y: 0, ch: '.', color: '#88aacc', cost: 1 });
    world.data.fishes[legacy].y = 114; world.data.scenes[scene].y = 110; world.data.chars[meal].y = 119;
    delete world.data.terrain; await set('checkpoint', { ...checkpoint, world: world.serialize(), lastOnlineAt: now }); return { east, west, publicFish, legacy, scene, meal, actor: identity.actor };
  }); await setup.close(); a = await open(ca, 39641);
  await a.waitForFunction(ids => { const data = tide.world.data, fish = data.fishes[ids.legacy], scene = data.scenes[ids.scene]; return fish.y + 1 < data.terrain.depths[fish.x] && scene.y + 1 < data.terrain.depths[scene.x]; }, fixture); await allInWater(a);
  const terrain = await a.evaluate(() => tide.world.data.terrain); assert.equal(terrain.depths.length, 1000); assert(terrain.depths.every(value => value >= 80 && value <= 100));
  await a.waitForFunction(ids => tide.world.data.fishes[ids.east].x < 10 && tide.world.data.fishes[ids.west].x > 990, fixture);
  assert.equal(await a.evaluate(() => tide.identity.nick), '海底昵称测试'); await b.locator('#connect').click(); await b.locator('#peerUrl').fill('http://127.0.0.1:39641'); await b.locator('#connectionForm .primary').click();
  await b.waitForFunction(() => tide.world.counts.fish === 4 && tide.network.peers.length > 0); assert.deepEqual(await b.evaluate(() => tide.world.data.terrain), terrain);
  await a.locator('#chatInput').fill('完整昵称发言'); await a.locator('#chatForm button').click(); await b.waitForFunction(() => [...document.querySelectorAll('#chatMessages .message')].some(line => line.textContent.includes('完整昵称发言') && line.querySelector('.name').textContent === '海底昵称测试'));
  await b.locator('#chatInput').fill('环海回复'); await b.locator('#chatForm button').click(); await a.waitForFunction(() => [...document.querySelectorAll('#chatMessages .name')].some(name => name.textContent === '环海伙伴'));
  const fishPoint = await b.evaluate(id => { const view = tide.view, fish = tide.world.data.fishes[id]; return { x: innerWidth / 2 + (fish.x - view.camera.x + .5) * 18 * view.scale, y: innerHeight / 2 + (fish.y - view.camera.y + .5) * 18 * view.scale }; }, fixture.publicFish); await b.mouse.click(fishPoint.x, fishPoint.y); await b.waitForFunction(() => document.getElementById('objectInfo').textContent.includes('海底昵称测试'));
  const status = await (await fetch('http://127.0.0.1:39641/status')).json(); assert(status.clients.some(client => client.nick === '海底昵称测试'));
  await a.locator('#seabed').click(); await a.screenshot({ path: path.join(output, 'seabed-curve.png') });
  await a.locator('#myFish').click(); await a.locator(`[data-fish="${fixture.east}"]`).click(); assert.equal(await a.evaluate(() => tide.view.followingFish), null); await a.locator('#followFish').click(); assert.equal(await a.evaluate(() => tide.view.followingFish), fixture.east); await a.screenshot({ path: path.join(output, 'wrapped-fish-following.png') });
  await a.reload(); await a.waitForFunction(() => window.tide && tide.world.counts.fish === 4); assert.deepEqual(await a.evaluate(() => tide.world.data.terrain), terrain); await allInWater(a);
  const rendererChecks = await a.evaluate(async () => { const { Renderer } = await import('./renderer.js'), { World } = await import('./engine.js'); const canvas = document.createElement('canvas'), renderer = new Renderer(canvas); renderer.camera = { x: 999, y: 20 }; const near = renderer.screen(0, 20), zero = renderer.screen(999, 20), hit = renderer.point(near.x + 1, near.y + 1); const world = new World(); return { distance: near.x - zero.x, x: hit.x, snapshot: renderer.snapshot(world).startsWith('data:image/') }; }); assert.equal(rendererChecks.distance, 18); assert.equal(rendererChecks.x, 0); assert(rendererChecks.snapshot);
  // Dragging the actual world camera can cross the same seam in both directions.
  const camera = await a.evaluate(() => tide.view.camera); await a.mouse.move(700, 350); await a.mouse.down(); await a.mouse.move(700 + (camera.x - 1002) * 18, 350, { steps: 3 }); await a.mouse.up(); const wrapped = await a.evaluate(() => tide.view.camera.x); assert(wrapped >= 0 && wrapped < 1000); assert(Math.abs(wrapped - 2) < 1);
  await a.setViewportSize({ width: 390, height: 844 }); await a.locator('#seabed').click(); await a.screenshot({ path: path.join(output, 'seabed-curve-mobile.png') });
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(output, 'browser-geography-results.json'), JSON.stringify({ passed: true, width: terrain.depths.length, minDepth: Math.min(...terrain.depths), maxDepth: Math.max(...terrain.depths), checks: ['full nicknames', 'legacy checkpoint migration', 'fixed terrain reload and WebRTC merge', 'east/west wrap', 'follow and camera seam', 'render and snapshot'], errors }, null, 2)); console.log('完整昵称、旧存档迁移、80–100格固定海底、WebRTC地形一致、左右穿越、跟随/相机接缝、刷新与快照通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
