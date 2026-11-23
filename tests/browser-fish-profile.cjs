const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), errors = []; let origin, browser;
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  if (route === '/local/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: origin } : { ok: true, clients: [], hints: [] })); return; }
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file));
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); let page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.locator('#nickInput').fill('鱼谱测试'); await page.locator('#welcomeForm .primary').click(); await page.waitForFunction(() => window.tide);
  await page.locator('#myFish').click(); await page.locator('#pedigreeTab').click(); assert((await page.locator('#pedigreeTree').textContent()).includes('还没有')); await page.locator('#closeMyFish').click();
  await page.locator('#makeFish').click(); const grid = await page.locator('#gridCanvas').boundingBox();
  for (const x of [7.5, 8.5, 9.5]) await page.mouse.click(grid.x + x * grid.width / 15, grid.y + 7.5 * grid.height / 15);
  assert.equal(await page.locator('#fishNameInput').inputValue(), '鱼谱测'); await page.locator('#fishNameInput').fill('阿鱼鱼'); assert(await page.locator('#placeDrawing').isEnabled());
  await page.mouse.click(grid.x + 9.5 * grid.width / 15, grid.y + 7.5 * grid.height / 15, { button: 'right' });
  assert(await page.locator('#placeDrawing').isDisabled()); assert((await page.locator('#fishNameHint').textContent()).includes('最多 2 字'));
  await page.locator('#fishNameInput').fill('阿鱼'); await page.locator('#drawTab').click(); await page.locator('#gridTab').click(); assert.equal(await page.locator('#fishNameInput').inputValue(), '阿鱼');
  await page.screenshot({ path: path.join(project, 'test-output', 'fish-name-creator.png') });
  await page.locator('#placeDrawing').click(); await page.mouse.click(600, 370); await page.waitForFunction(() => tide.world.counts.fish === 1);
  assert.equal(await page.evaluate(() => Object.values(tide.world.data.fishes)[0].name), '阿鱼');
  await page.locator('#myFish').click(); assert.equal(await page.locator('#myFishList strong').textContent(), '阿鱼'); assert((await page.locator('#myFishList .fishCardInfo').textContent()).includes('鱼谱测试'));
  await page.locator('#myFishList .fishCard').click(); assert.equal(await page.locator('#objectTitle').textContent(), '阿鱼'); await page.locator('#closeInspector').click();
  await page.locator('#makeFish').click(); const second = await page.locator('#gridCanvas').boundingBox(); for (let x = 2.5; x < 12; x++) await page.mouse.click(second.x + x * second.width / 15, second.y + 7.5 * second.height / 15);
  assert.equal(await page.locator('#fishNameInput').inputValue(), '鱼谱测试的第2条鱼'); await page.locator('#closeCreator').click(); await page.locator('#makeScene').click(); assert(await page.locator('#fishNameLabel').isHidden()); await page.locator('#closeCreator').click(); await page.close();
  const setup = await context.newPage(); await setup.goto(origin + '/welcome.html');
  const fixture = await setup.evaluate(async () => {
    const { World, maskNick } = await import('./engine.js'), { BREEDING_TIME, updateContacts, finishBreeding } = await import('./breeding.js'), { HOUR } = await import('./seaweed.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), checkpoint = await get('checkpoint'), now = Date.now(), start = now - 4 * HOUR, world = new World(start, Object.keys(checkpoint.world.roots)[0]), sender = new Network(identity, {}, () => {}, () => {}); sender.sign = await signer(identity);
    const cell = (x, y) => ({ x, y, ch: 'Q', color: '#79b8ff' });
    async function apply(body) { const op = { id: crypto.randomUUID(), actor: identity.actor, nick: maskNick(identity.nick), t: start, roots: [world.id], ...body }; const result = world.apply({ ...op, proof: await sender.makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error); return op.id; }
    const father = await apply({ kind: 'fish', name: '祖父', gender: 'male', x: 390, y: 20, cells: [0, 1, 2, 3, 4].map(x => cell(x, 0)), cost: 5 }), mother = await apply({ kind: 'fish', name: '祖母', gender: 'female', x: 395, y: 20, cells: [0, 1, 2].map(x => cell(x, 0)), cost: 3 });
    const transition = (cell, next, event) => { Object.assign(cell, next); cell.path.push({ ...event, target: next.entity || '', x: next.x, y: next.y }); };
    function bind(at) { for (let elapsed = 0; elapsed <= 5000; elapsed += 500) updateContacts(world, at + elapsed, world.fishGroups(), world.sceneryMap()); return Object.values(world.data.breeding).find(r => r.status === 'active'); }
    const first = bind(start); finishBreeding(world, first.ends, transition); const child = world.data.fishes[first.baby.id]; child.x = 390; child.y = 35;
    for (const x of [2, 3]) { const id = await apply({ kind: 'food', x: 390 + x, y: 0, ch: 'Q', color: '#ff9fc8', cost: 1 }); transition(world.data.chars[id], { kind: 'fish', entity: child.id, x, y: 0 }, { id: `eat:${id}`, t: first.ends, reason: 'eat' }); }
    const partner = await apply({ kind: 'fish', name: '伙伴', gender: child.gender === 'male' ? 'female' : 'male', x: 387, y: 35, cells: [0, 1, 2].map(x => cell(x, 0)), cost: 3 });
    const second = bind(first.ends + 10000); finishBreeding(world, second.ends, transition); if (second.status !== 'born') throw new Error('第二代出生失败');
    for (let count = 0; world.data.fishes[father] && count < 10; count++) world.starve(father, second.ends + 1000 + count * 500);
    world.data.tick = now; world.data.seaweedHour = Math.floor(now / HOUR); checkpoint.world = world.serialize(); checkpoint.lastOnlineAt = now; await set('checkpoint', checkpoint); return { father, mother, child: child.id, partner, grandchild: second.baby.id };
  }); await setup.close();
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await page.waitForFunction(() => window.tide); await page.locator('#myFish').click(); await page.locator('#pedigreeTab').click();
  await page.locator('#pedigreeRoot').selectOption(fixture.grandchild);
  assert.equal(await page.locator('[data-lineage-fish]').count(), 5); assert((await page.locator('#pedigreeCount').textContent()).includes('3 代'));
  assert(await page.locator(`[data-lineage-fish="${fixture.father}"]`).isDisabled()); assert((await page.locator(`[data-lineage-fish="${fixture.father}"]`).textContent()).includes('祖父'));
  assert(await page.locator('#pedigreeTree svg path').count() > 0);
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); await page.screenshot({ path: path.join(project, 'test-output', 'fish-pedigree.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(project, 'test-output', 'fish-pedigree-mobile.png') });
  assert(await page.locator('#pedigreeTree').evaluate(node => node.scrollWidth > node.clientWidth)); await page.locator('#pedigreeTree').evaluate(node => { node.scrollLeft = 100; }); assert(await page.locator('#pedigreeTree').evaluate(node => node.scrollLeft > 0));
  await page.locator(`[data-lineage-fish="${fixture.grandchild}"]`).click(); assert.equal(await page.locator('#myFishDialog').isVisible(), false); assert((await page.locator('#fishParentage').textContent()).includes('父鱼'));
  await page.reload(); await page.waitForFunction(() => window.tide); await page.locator('#myFish').click(); await page.locator('#pedigreeTab').click(); await page.locator('#pedigreeRoot').selectOption(fixture.grandchild); assert.equal(await page.locator('[data-lineage-fish]').count(), 5);
  assert.deepEqual(errors, []); console.log('自定义鱼名、默认序号与截短、擦字后长度校验、三代家谱、已消失祖先、小屏滚动与刷新恢复通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
