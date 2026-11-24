const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'test-output'), children = [], errors = [];
const exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'); let browser;
async function helper(port) {
  const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child);
  const until = Date.now() + 20000; while (Date.now() < until) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('启动器未就绪');
}
async function open(context, port, nick) { const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(`http://127.0.0.1:${port}/`); if (nick) { await p.locator('#nickInput').fill(nick); await p.locator('#welcomeForm .primary').click(); } await p.waitForFunction(() => window.tide); return p; }
async function main() {
  fs.mkdirSync(output, { recursive: true }); for (const port of [39831, 39832]) await helper(port);
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const ca = await browser.newContext({ viewport: { width: 1440, height: 900 } }), cb = await browser.newContext(); let a = await open(ca, 39831, '限食测试'); await a.close();
  const setup = await ca.newPage(); await setup.goto('http://127.0.0.1:39831/welcome.html');
  const fixture = await setup.evaluate(async () => {
    const { World } = await import('./engine.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), now = Date.now(), w = new World(now, undefined, { populate: false }); identity.registration.joined = true;
    const sender = new Network(identity, {}, () => {}, () => {}); sender.sign = await signer(identity);
    async function apply(body) { const op = { id: crypto.randomUUID(), actor: identity.actor, nick: identity.nick, roots: w.roots, t: now, ...body }; const result = w.apply({ ...op, proof: await sender.makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error); return op.id; }
    const fish = await apply({ kind: 'fish', name: '小鱼', gender: 'male', x: 380, y: 1, cells: [{ x: 0, y: 0, ch: 'Q', color: '#88aacc' }, { x: 1, y: 0, ch: 'Q', color: '#88aacc' }], cost: 2 });
    const foods = [await apply({ kind: 'food', x: 380, y: 0, ch: '食', color: '#ffffff', cost: 1 }), await apply({ kind: 'food', x: 381, y: 0, ch: '粮', color: '#ffffff', cost: 1 })];
    await set('identity', identity); await set('checkpoint', { world: w.serialize(), lastOnlineAt: now }); await set('known', []); return { fish, foods };
  }); await setup.close(); a = await open(ca, 39831);
  await a.waitForFunction(id => !!tide.world.data.fishes[id].lastMealAt, fixture.fish);
  let state = await a.evaluate(f => ({ fish: tide.world.data.fishes[f.fish], eaten: f.foods.filter(id => tide.world.data.chars[id].kind === 'fish').length }), fixture); assert.equal(state.eaten, 1);
  const lastMeal = state.fish.lastMealAt; await a.locator('#myFish').click(); await a.locator(`.fishCard[data-fish="${fixture.fish}"]`).click(); assert.match(await a.locator('#fishLastMeal').textContent(), /已吃饱.*分钟后可再进食/);
  await a.screenshot({ path: path.join(output, 'feeding-cooldown.png') }); await a.reload(); await a.waitForFunction(() => window.tide);
  assert.equal(await a.evaluate(id => tide.world.data.fishes[id].lastMealAt, fixture.fish), lastMeal);
  const b = await open(cb, 39832, '限食邻居'); await b.locator('#connect').click(); await b.locator('#peerUrl').fill('http://127.0.0.1:39831'); await b.locator('#connectionForm .primary').click();
  await b.waitForFunction(id => !!tide.world.data.fishes[id], fixture.fish); assert.equal(await b.evaluate(id => tide.world.data.fishes[id].lastMealAt, fixture.fish), lastMeal);
  await a.close(); await b.waitForFunction(() => tide.network.leader === tide.network.node, null, { timeout: 30000 });
  assert.equal(await b.evaluate(f => f.foods.filter(id => tide.world.data.chars[id].kind === 'fish').length, fixture), 1);
  assert.equal(errors.length, 0, errors.join('\n'));
  fs.writeFileSync(path.join(output, 'feeding-browser-results.json'), JSON.stringify({ passed: true, checks: ['同一步只吃一颗', '观察面板冷却提示', '刷新保留', 'WebRTC同步', '协调者接替后仍只吃一颗'], errors }, null, 2)); console.log('Hourly feeding browser checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
