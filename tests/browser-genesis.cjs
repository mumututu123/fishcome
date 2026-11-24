const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'test-output'), children = [], errors = [];
const exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'); let browser;
async function helper(port) { const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); const end = Date.now() + 20000; while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('启动器未就绪'); }
async function open(context, port, nick) { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${port}/`); if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); } await page.waitForFunction(() => window.tide); await page.evaluate(async () => { const { Network } = await import('./network.js'), receive = Network.prototype.receive; window.replicaErrors = []; Network.prototype.receive = async function(...args) { try { return await receive.apply(this, args); } catch (error) { window.replicaErrors.push(error.message); throw error; } }; }); return page; }
async function healthy(page) {
  assert(await page.evaluate(async () => {
    const { initialSources, validInitialOp } = await import('./genesis.js'), { validWildCell } = await import('./seaweed.js'), { CONFIG, hash } = await import('./engine.js');
    const data = tide.world.data, sources = initialSources(data.roots), occupied = new Set(), wrap = x => (x % 1000 + 1000) % 1000;
    for (const op of Object.values(data.ops).filter(op => op.genesis !== undefined)) if (!validInitialOp(op, sources)) return false;
    for (const cell of Object.values(data.chars)) {
      if (cell.wild && !validWildCell(cell, CONFIG, hash, sources)) return false;
      if (cell.kind !== 'fish') continue;
      const fish = data.fishes[cell.entity], x = wrap(fish.x + fish.facing * cell.x), y = fish.y + cell.y, key = `${x},${y}`;
      if (occupied.has(key) || y < 0 || y >= data.terrain.depths[x]) return false; occupied.add(key);
    }
    return true;
  }));
}
async function main() {
  fs.mkdirSync(output, { recursive: true }); for (const port of [39761, 39762, 39763]) await helper(port);
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const ca = await browser.newContext({ viewport: { width: 1440, height: 900 } }), cb = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(ca, 39761, '新生海测试'), b = await open(cb, 39762, '新生海伙伴');
  const initialA = await a.evaluate(() => tide.world.data), initialB = await b.evaluate(() => tide.world.data);
  const idsA = Object.keys(initialA.fishes), idsB = Object.keys(initialB.fishes), ids = [...idsA, ...idsB];
  for (const page of [a, b]) { const data = await page.evaluate(() => tide.world.data); assert(Object.keys(data.fishes).length >= 2 && Object.keys(data.fishes).length <= 10); assert(Object.values(data.fishes).every(fish => fish.name === '默默无名的鱼')); assert.equal(await page.evaluate(() => tide.balance()), 20); await healthy(page); }
  await a.locator('#myFish').click(); assert.equal(await a.locator('#myFishList .fish-card').count(), 0); await a.keyboard.press('Escape');
  await b.locator('#connect').click(); await b.locator('#peerUrl').fill('http://127.0.0.1:39761'); await b.locator('#connectionForm .primary').click();
  try { for (const page of [a, b]) await page.waitForFunction(ids => ids.every(id => !!tide.world.data.fishes[id]), ids); } catch (error) { for (const page of [a, b]) console.error(await page.evaluate(() => ({ network: tide.network, roots: tide.world.data.roots, fish: Object.keys(tide.world.data.fishes), errors: window.replicaErrors, status: document.getElementById('networkStatus').textContent, toast: document.getElementById('toast').textContent }))); throw error; }
  for (let sample = 0; sample < 16; sample++) { await healthy(a); await healthy(b); await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal(await a.evaluate(() => tide.world.counts.fish), ids.length); assert.equal(await b.evaluate(() => tide.world.counts.fish), ids.length);
  assert(await a.evaluate(initial => Object.values(tide.world.data.fishes).some(fish => initial[fish.id] && (fish.x !== initial[fish.id].x || fish.y !== initial[fish.id].y)), initialA.fishes));
  const opA = await a.evaluate(() => Object.values(tide.world.data.ops).filter(op => op.genesis).sort((a, b) => a.id.localeCompare(b.id))), opB = await b.evaluate(() => Object.values(tide.world.data.ops).filter(op => op.genesis).sort((a, b) => a.id.localeCompare(b.id))); assert.deepEqual(opA, opB);
  const target = await a.evaluate(() => { const data = tide.world.data, fish = Object.values(data.fishes)[0], cell = Object.values(data.chars).find(cell => cell.kind === 'fish' && cell.entity === fish.id); return { id: fish.id, x: fish.x + fish.facing * cell.x, y: fish.y + cell.y }; });
  const pan = await a.evaluate(target => ({ dx: (tide.view.camera.x - target.x) * 18 * tide.view.scale, dy: (tide.view.camera.y - target.y) * 18 * tide.view.scale }), target);
  await a.mouse.move(720, 450); await a.mouse.down(); await a.mouse.move(720 + pan.dx, 450 + pan.dy, { steps: 5 }); await a.mouse.up();
  // Use the current fish position after panning, since initial fish swim normally.
  const point = await a.evaluate(id => { const data = tide.world.data, fish = data.fishes[id], cell = Object.values(data.chars).find(cell => cell.kind === 'fish' && cell.entity === id), view = tide.view, x = fish.x + fish.facing * cell.x, delta = (x - view.camera.x + 1500) % 1000 - 500; return { x: innerWidth / 2 + (delta + .5) * 18 * view.scale, y: innerHeight / 2 + (fish.y + cell.y + .5 - view.camera.y) * 18 * view.scale }; }, target.id);
  await a.mouse.click(point.x, point.y); await a.waitForFunction(() => document.getElementById('objectTitle').textContent === '默默无名的鱼');
  await a.screenshot({ path: path.join(output, 'genesis-fish-profile.png') });
  const backup = await a.evaluate(async () => { const { get } = await import('./storage.js'); return { format: 'tide-backup-1', identity: await get('identity'), histories: {}, known: [], checkpoint: { world: tide.world.data, lastOnlineAt: Date.now(), at: Date.now() } }; });
  const imported = await browser.newContext({ viewport: { width: 1440, height: 900 } }), setup = await imported.newPage(); await setup.goto('http://127.0.0.1:39763/welcome.html'); await setup.evaluate(async backup => (await import('./storage.js')).putMany([['identity', backup.identity], ['checkpoint', backup.checkpoint]]), backup); await setup.close(); const restored = await open(imported, 39763); await healthy(restored); assert.deepEqual(Object.keys(await restored.evaluate(() => tide.world.data.fishes)).sort(), ids.sort());
  await a.reload(); await a.waitForFunction(() => window.tide); await healthy(a); assert.deepEqual(Object.keys(await a.evaluate(() => tide.world.data.fishes)).sort(), ids.sort());
  const bad = structuredClone(backup); Object.values(bad.checkpoint.world.ops).find(op => op.genesis).name = '篡改的鱼'; const badPath = path.join(output, 'genesis-tampered-backup.json'); fs.writeFileSync(badPath, JSON.stringify(bad));
  await restored.locator('#importBackup').setInputFiles(badPath); await restored.waitForFunction(() => document.getElementById('toast').textContent.includes('初始鱼记录被修改')); assert.deepEqual(Object.keys(await restored.evaluate(() => tide.world.data.fishes)).sort(), ids.sort());
  assert.equal(errors.length, 0, errors.join('\n')); fs.writeFileSync(path.join(output, 'browser-genesis-results.json'), JSON.stringify({ initialFish: [idsA.length, idsB.length], mergedFish: ids.length, initialGrass: [Object.values(initialA.chars).filter(cell => cell.kind === 'seaweed').length, Object.values(initialB.chars).filter(cell => cell.kind === 'seaweed').length], signedReplicaValidation: true, movementAndCollision: true, backupAndReload: true, tamperingRejected: true, errors }, null, 2));
  console.log('初始海草和2–10条鱼、原生WebRTC合流、正常游动与碰撞、名称面板、存档恢复及篡改拒绝通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
