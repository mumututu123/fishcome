const { spawn } = require('node:child_process');
const { launcherPath } = require('./release-fixtures.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), children = [], errors = [], exe = launcherPath; let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function helper(port) { const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); const end = Date.now() + 20000; while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await pause(150); } throw new Error('启动器未就绪'); }
async function open(context, port, nick) { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${port}/`); if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); } await page.waitForFunction(() => window.tide); return page; }
async function unique(page, count) { const result = await page.evaluate(() => { const data = tide.world.data, occupied = new Set(); let overlap = false; for (const c of Object.values(data.chars)) if (c.kind === 'fish') { const fish = data.fishes[c.entity], k = `${fish.x + fish.facing * c.x},${fish.y + c.y}`; if (occupied.has(k)) overlap = true; occupied.add(k); } return { overlap, fish: tide.world.counts.fish, chars: occupied.size }; }); assert.equal(result.overlap, false); assert.equal(result.fish, count); return result; }
async function draw(page) { await page.locator('#makeFish').click(); await page.keyboard.type('o'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('o'); await page.locator('#placeDrawing').click(); }
async function point(page, x, y) { return page.evaluate(({ x, y }) => ({ x: innerWidth / 2 + (x - tide.view.camera.x + .5) * 18 * tide.view.scale, y: innerHeight / 2 + (y - tide.view.camera.y + .5) * 18 * tide.view.scale }), { x, y }); }
async function main() {
  await helper(39541); await helper(39542); fs.mkdirSync(path.join(project, 'test-output'), { recursive: true });
  browser = await chromium.launch({ headless: true });
  const first = await browser.newContext({ viewport: { width: 1440, height: 900 } }), second = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(first, 39541, '碰撞甲'), b = await open(second, 39542, '碰撞乙'); await a.close(); await b.close();
  const setupB = await second.newPage(); await setupB.goto('http://127.0.0.1:39542/welcome.html'); const otherIdentity = await setupB.evaluate(async () => {
    const { World } = await import('./engine.js'), { get, set } = await import('./storage.js'), previous = await get('checkpoint'), now = Date.now();
    await set('checkpoint', { ...previous, world: new World(now, Object.keys(previous.world.roots)[0], { populate: false }).serialize(), lastOnlineAt: now }); return get('identity');
  }); await setupB.close();
  const setup = await first.newPage(); await setup.goto('http://127.0.0.1:39541/welcome.html');
  const ids = await setup.evaluate(async otherIdentity => {
    const { World, hash, maskNick } = await import('./engine.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), previous = await get('checkpoint'), now = Date.now(), world = new World(now, Object.keys(previous.world.roots)[0], { populate: false }), senders = [identity, otherIdentity].map(identity => new Network(identity, {}, () => {}, () => {}));
    for (let i = 0; i < 2; i++) senders[i].sign = await signer(i ? otherIdentity : identity);
    const cell = (x, y) => ({ x, y, ch: 'Q', color: '#8be7df' });
    async function apply(index, body) { const author = index ? otherIdentity : identity, op = { id: crypto.randomUUID(), actor: author.actor, nick: maskNick(author.nick), t: now, roots: [world.id], ...body }; const result = world.apply({ ...op, proof: await senders[index].makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error); return op.id; }
    function directed(dx) { while (true) { const id = crypto.randomUUID(), h = hash(`${id}:0`); if ([-1, 0, 1][h % 3] === dx && [-1, 0, 1][Math.floor(h / 3) % 3] === 0) return id; } }
    const left = await apply(0, { id: directed(1), kind: 'fish', x: 390, y: 20, cells: [cell(0, 0), cell(1, 0)], cost: 2 }), right = await apply(1, { id: directed(-1), kind: 'fish', x: 393, y: 20, cells: [cell(0, 0), cell(1, 0)], cost: 2 });
    await apply(0, { kind: 'scene', x: 389, y: 19, cells: [...Array.from({ length: 4 }, (_, x) => cell(x, 0)), cell(0, 1)], cost: 5 });
    await apply(1, { kind: 'scene', x: 389, y: 19, cells: [...Array.from({ length: 4 }, (_, x) => cell(x, 2)), cell(3, 1)], cost: 5 });
    // Reproduce an older checkpoint in which fish could occupy each other's cells.
    world.data.fishes[right].x = 390;
    await set('checkpoint', { ...previous, world: world.serialize(), lastOnlineAt: now }); return { left, right };
  }, otherIdentity); await setup.close();
  a = await open(first, 39541); await a.waitForFunction(() => { const data = tide.world.data, points = Object.values(data.chars).filter(c => c.kind === 'fish').map(c => `${data.fishes[c.entity].x + data.fishes[c.entity].facing * c.x},${data.fishes[c.entity].y + c.y}`); return new Set(points).size === 4; }); await unique(a, 2);
  b = await open(second, 39542); await b.locator('#connect').click(); await b.locator('#peerUrl').fill('http://127.0.0.1:39541'); await b.locator('#connectionForm .primary').click(); await b.waitForFunction(() => tide.world.counts.fish === 2 && tide.network.peers.length > 0);
  for (let i = 0; i < 8; i++) { for (const page of [a, b]) await unique(page, 2); await pause(500); }
  const before = await a.evaluate(() => tide.balance()); await draw(a);
  const position = await point(a, 390, 20);
  await a.mouse.move(position.x, position.y); await a.screenshot({ path: path.join(project, 'test-output', 'fish-collision-placement.png') }); await a.mouse.click(position.x, position.y); await a.waitForFunction(() => document.getElementById('toast').textContent.includes('其他鱼')); assert.equal(await a.evaluate(() => tide.balance()), before); await unique(a, 2);
  await draw(a); const free = await point(a, 400, 30); await a.mouse.click(free.x, free.y); for (const page of [a, b]) await page.waitForFunction(() => tide.world.counts.fish === 3); assert.equal(await a.evaluate(() => tide.balance()), before - 2); for (const page of [a, b]) await unique(page, 3);
  const node = await a.evaluate(() => tide.network.node), otherNode = await b.evaluate(() => tide.network.node); await a.waitForFunction(nodes => nodes.includes(tide.network.leader), [node, otherNode]);
  const leader = await a.evaluate(() => tide.network.leader); await b.waitForFunction(expected => tide.network.leader === expected, leader); const remaining = leader === node ? b : a;
  await (leader === node ? a : b).close(); await remaining.waitForFunction(previous => tide.network.leader !== previous, leader); await unique(remaining, 3);
  await remaining.reload(); await remaining.waitForFunction(() => window.tide && tide.world.counts.fish === 3); await unique(remaining, 3);
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(project, 'test-output', 'browser-fish-collision-results.json'), JSON.stringify({ passed: true, checks: ['old overlap repair', 'continuous collision', 'WebRTC replicas', 'overlap placement rejects without charge', 'free placement', 'reload', 'coordinator takeover'], errors }, null, 2)); console.log('旧存档重叠修复、鱼体碰撞持续无重叠、真实WebRTC同步、重叠投放拒绝且不扣费、正常投放、刷新与协调者接替通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
