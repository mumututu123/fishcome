const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), children = [], errors = [];
const ports = [39321, 39322]; let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { const end = Date.now() + 20000; while (Date.now() < end) { if (await check()) return; await pause(150); } throw new Error(message); }
async function open(context, port, nick) {
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);
  if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); }
  await page.waitForFunction(() => window.tide); return page;
}
async function main() {
  for (const port of ports) {
    const child = spawn(process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'), ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child);
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, '启动器没有就绪');
  }
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const first = await browser.newContext({ viewport: { width: 1440, height: 900 } }), second = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(first, ports[0], '海草测试'); await a.close();
  const setup = await first.newPage(); await setup.goto(`http://127.0.0.1:${ports[0]}/welcome.html`);
  const ids = await setup.evaluate(async () => {
    const { World, CONFIG, hash } = await import('./engine.js'), { HOUR, GREENS, growthRoll, weedId } = await import('./seaweed.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const checkpoint = await get('checkpoint'), identity = await get('identity'), now = Date.now(), world = new World(now, Object.keys(checkpoint.world.roots)[0]);
    let source = 'floor:600', hour = Math.floor(now / HOUR) - 10000, plant; const ids = [];
    for (let index = 0; index < 4; index++) {
      while (!growthRoll(source, ++hour, hash)) {}
      const id = weedId(source, hour, hash); plant ||= id;
      world.data.chars[id] = { id, kind: 'seaweed', entity: plant, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x: 600, y: world.floorAt(600) - 1 - index, created: hour * HOUR, path: [], moveAt: now, wild: { source, hour, plant, index, x: 600, y: world.floorAt(600) - 1 - index } };
      ids.push(id); source = `tip:${id}`;
    }
    const network = new Network(identity, {}, () => {}, () => {}); network.sign = await signer(identity);
    const op = { id: crypto.randomUUID(), actor: identity.actor, nick: '海＊试', t: now, roots: [world.id], kind: 'scene', x: 601, y: Math.min(world.floorAt(600), world.floorAt(601)) - 5, cells: Array.from({ length: 4 }, (_, y) => ({ x: 0, y, ch: '#', color: '#aabbcc' })), cost: 4 };
    const result = world.apply({ ...op, proof: await network.makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error);
    checkpoint.world = world.serialize(); checkpoint.lastOnlineAt = now; await set('checkpoint', checkpoint); return ids;
  }); await setup.close();
  a = await open(first, ports[0]); const b = await open(second, ports[1], '海草邻居');
  await a.locator('#seabed').click();
  const poses = new Set(); for (let i = 0; i < 15; i++) { const xs = await a.evaluate(ids => ids.map(id => tide.world.data.chars[id].x), ids); poses.add(xs.join(',')); assert(xs.every(x => x <= 600), '摆动穿过右侧造景'); await pause(300); }
  assert(poses.size > 1, '浏览器中应持续摆动');
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); await a.screenshot({ path: path.join(project, 'test-output', 'seaweed.png') });
  await b.locator('#connect').click(); await b.locator('#peerUrl').fill(`http://127.0.0.1:${ports[0]}`); await b.locator('#connectionForm .primary').click();
  await b.waitForFunction(ids => ids.every(id => tide.world.data.chars[id]?.kind === 'seaweed'), ids, { timeout: 20000 });
  await a.locator('#makeFish').click(); const grid = await a.locator('#gridCanvas').boundingBox();
  for (const x of [7.5, 8.5]) await a.mouse.click(grid.x + x * grid.width / 15, grid.y + 7.5 * grid.height / 15);
  await a.locator('#placeDrawing').click();
  const point = await a.evaluate(() => { const view = tide.view, size = 18 * view.scale; return { x: innerWidth / 2 + (598.5 - view.camera.x) * size, y: innerHeight / 2 + (Math.min(tide.world.data.terrain.depths[598], tide.world.data.terrain.depths[600]) - 1.5 - view.camera.y) * size }; });
  await a.mouse.click(point.x, point.y);
  for (const page of [a, b]) await page.waitForFunction(ids => ids.some(id => tide.world.data.chars[id]?.kind === 'fish'), ids, { timeout: 20000 });
  const fed = await a.evaluate(ids => ids.map(id => tide.world.data.chars[id]).filter(c => c.kind === 'fish').map(c => ({ id: c.id, entity: c.entity, ch: c.ch, color: c.color, eats: c.path.filter(p => p.reason === 'eat').length })), ids);
  assert(fed.length > 0); assert(fed.every(c => c.ch === '草' && c.eats === 1));
  await a.reload(); await a.waitForFunction(() => window.tide);
  await a.waitForFunction(ids => ids.some(id => tide.world.data.chars[id]?.kind === 'fish'), ids);
  await a.locator('#myFish').click(); assert((await a.locator('#myFishList').textContent()).includes('近24小时进食'));
  assert.deepEqual(errors, []); console.log('海草渲染与摆动、造景碰撞、WebRTC合流、鱼吃海草及刷新恢复通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
