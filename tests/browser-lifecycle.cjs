const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), errors = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, origin;
// Isolated static/pairing fixture: lifecycle checks need no remote peers or Windows launcher.
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  if (route === '/local/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: origin } : { ok: true, clients: [], hints: [] })); return; }
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file));
});
async function open(context) { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); return page; }
async function ready(page) { await page.waitForFunction(() => window.tide); }
async function state(page) { return page.evaluate(() => ({ roots: Object.keys(tide.world.data.roots), counts: tide.world.counts, ownFish: Object.values(tide.world.data.fishes).filter(f => f.actor === tide.identity.actor).map(f => f.id).sort(), scenes: Object.keys(tide.world.data.scenes).sort(), balance: tide.balance(), cards: Object.values(tide.histories).filter(c => c.status !== 'corrected') })); }
async function age(context, hours, legacy = false) {
  const page = await context.newPage(); await page.goto(origin + '/welcome.html');
  await page.evaluate(async ({ hours, legacy }) => {
    const { get, set } = await import('./storage.js'), checkpoint = await get('checkpoint');
    checkpoint.lastOnlineAt = Date.now() - hours * 3600000;
    if (legacy) { checkpoint.at = checkpoint.lastOnlineAt; delete checkpoint.lastOnlineAt; }
    await set('checkpoint', checkpoint);
  }, { hours, legacy }); await page.close();
}
async function create(page, kind, x, y) {
  await page.locator(kind === 'fish' ? '#makeFish' : '#makeScene').click();
  const grid = await page.locator('#gridCanvas').boundingBox(), size = kind === 'fish' ? 15 : 20;
  await page.locator('#glyphInput').fill('口口'); await page.locator('#prepareBeads').click();
  for (const column of [7.5, 8.5]) { await page.locator('[data-bead-id]').first().click(); await page.mouse.click(grid.x + column * grid.width / size, grid.y + 7.5 * grid.height / size); }
  await page.locator('#placeDrawing').click(); await page.mouse.click(x, y);
  await page.waitForFunction(kind => tide.world.counts[kind] > 0, kind);
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, timeout: 30000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = await open(context); await page.locator('#nickInput').fill('期限测试'); await page.locator('#welcomeForm .primary').click(); await ready(page);
  await create(page, 'fish', 600, 370); await create(page, 'scene', 950, 580);
  const original = await state(page); assert.equal(original.balance, 16); await page.close(); await pause(500);
  page = await open(context); await ready(page); await pause(17000);
  const short = await state(page); assert.deepEqual(short.roots, original.roots); assert.equal(short.balance, 16); assert.deepEqual(short.ownFish, original.ownFish); assert.deepEqual(short.scenes, original.scenes); assert.equal(short.counts.fish, original.counts.fish); assert.equal(short.cards.length, 0);
  await page.close(); await pause(500); await age(context, 239, true);
  page = await open(context); await ready(page);
  const legacy = await state(page); assert.deepEqual(legacy.roots, original.roots); assert.equal(legacy.balance, 16); assert.equal(legacy.cards.length, 0);
  await page.close(); await pause(500); await age(context, 240);
  page = await open(context); await ready(page);
  const expired = await state(page); assert.equal(expired.ownFish.length, 0); assert(!expired.scenes.some(id => original.scenes.includes(id))); assert.equal(expired.balance, 20); assert(!expired.roots.some(root => original.roots.includes(root))); assert(expired.cards.some(card => original.roots.every(root => card.roots.includes(root)) && Number.isFinite(card.endedAt)));
  await create(page, 'fish', 600, 370); const beforeSleep = await state(page);
  await page.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 180000; }); await pause(1200);
  const shortSleep = await state(page); assert.deepEqual(shortSleep.roots, beforeSleep.roots); assert.deepEqual(shortSleep.ownFish, beforeSleep.ownFish); assert.equal(shortSleep.balance, 18);
  await page.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 240 * 3600000; }); await pause(1200);
  const longSleep = await state(page); assert.equal(longSleep.ownFish.length, 0); assert(!longSleep.roots.some(root => beforeSleep.roots.includes(root))); assert.equal(longSleep.balance, 20); assert(longSleep.cards.some(card => beforeSleep.roots.every(root => card.roots.includes(root))));
  const foodContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), foodPage = await open(foodContext);
  await foodPage.locator('#nickInput').fill('鱼食测试'); await foodPage.locator('#welcomeForm .primary').click(); await ready(foodPage);
  await foodPage.evaluate(() => { document.getElementById('glyphInput').value = '木'; document.getElementById('colorInput').value = '#112233'; });
  await foodPage.keyboard.press('e'); assert.equal(await foodPage.locator('#foodDialog').isVisible(), true);
  for (const invalid of ['', ' ', '你好', '🐟']) { await foodPage.locator('#foodGlyphInput').fill(invalid); assert.equal(await foodPage.locator('#placeFood').isDisabled(), true); assert.equal(await foodPage.evaluate(() => tide.balance()), 20); }
  await foodPage.locator('#foodGlyphInput').fill('粮'); await foodPage.locator('#foodColorInput').fill('#ff3366');
  assert.equal(await foodPage.locator('#foodPreview').textContent(), '粮'); assert.equal(await foodPage.locator('#foodPreview').evaluate(element => getComputedStyle(element).color), 'rgb(255, 51, 102)');
  await foodPage.screenshot({ path: path.join(project, 'test-output', 'food-settings.png') });
  await foodPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await foodPage.locator('#foodDialog').evaluate(element => element.scrollWidth <= element.clientWidth), true, '小屏鱼食设置横向溢出');
  await foodPage.screenshot({ path: path.join(project, 'test-output', 'food-settings-mobile.png') });
  await foodPage.setViewportSize({ width: 1440, height: 900 });
  await foodPage.locator('#closeFood').click(); assert.equal(await foodPage.evaluate(() => tide.balance()), 20, '关闭设置扣费');
  await foodPage.locator('#feed').click(); assert.equal(await foodPage.locator('#foodGlyphInput').inputValue(), '粮'); assert.equal(await foodPage.locator('#foodColorInput').inputValue(), '#ff3366');
  await foodPage.locator('#placeFood').click(); await foodPage.mouse.click(600, 370); await pause(600);
  assert.equal(await foodPage.evaluate(() => tide.balance()), 20, '水下投食扣费'); await foodPage.keyboard.press('Escape');
  assert.equal(await foodPage.evaluate(() => tide.balance()), 20, '取消水面投放扣费');
  for (const [index, [ch, color]] of [['粮', '#ff3366'], ['𠮷', '#12ab34'], ['+', '#abcdef']].entries()) {
    await foodPage.locator('#feed').click(); await foodPage.locator('#foodGlyphInput').fill(ch); await foodPage.locator('#foodColorInput').fill(color); await foodPage.locator('#placeFood').click(); await foodPage.mouse.click(600 + index * 80, 243);
    await foodPage.waitForFunction(({ ch, color }) => Object.values(tide.world.data.chars).some(cell => cell.kind === 'food' && cell.ch === ch && cell.color === color), { ch, color });
    assert.equal(await foodPage.evaluate(() => tide.balance()), 19 - index); await foodPage.keyboard.press('Escape');
  }
  assert.equal(await foodPage.locator('#glyphInput').inputValue(), '木'); assert.equal(await foodPage.locator('#colorInput').inputValue(), '#112233');
  await foodContext.close();
  const fishContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); let fishPage = await open(fishContext);
  await fishPage.locator('#nickInput').fill('鱼况测试'); await fishPage.locator('#welcomeForm .primary').click(); await ready(fishPage); await fishPage.close(); await pause(400);
  const setup = await fishContext.newPage(); await setup.goto(origin + '/welcome.html');
  const ownId = await setup.evaluate(async () => {
    const { World } = await import('./engine.js'), { get, set, signer, actorId } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), checkpoint = await get('checkpoint'), now = Date.now(), world = new World(now - 48 * 3600000, Object.keys(checkpoint.world.roots)[0]);
    const network = new Network(identity, {}, () => {}, () => {}); network.sign = await signer(identity);
    async function apply(body, sender = network) { const message = await sender.makeEnvelope('op', body); if (!world.apply({ ...body, proof: message }).ok) throw new Error('fixture operation failed'); }
    const id = crypto.randomUUID(); await apply({ id, actor: identity.actor, nick: '鱼＊试', t: now - 48 * 3600000, roots: [world.id], kind: 'fish', x: 390, y: 15, cells: Array.from({ length: 6 }, (_, x) => ({ x, y: 0, ch: 'o', color: '#8be7df' })), cost: 6 });
    for (const [index, hours] of [25, 23].entries()) { const food = crypto.randomUUID(), at = now - hours * 3600000; await apply({ id: food, actor: identity.actor, nick: '鱼＊试', t: at, roots: [world.id], kind: 'food', x: 389, y: 0, ch: index ? '口' : '食', color: '#ff9933', cost: 1 }); world.data.chars[food].y = 14 - index; world.step(at); }
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), pub = await crypto.subtle.exportKey('jwk', pair.publicKey), secret = await crypto.subtle.exportKey('jwk', pair.privateKey), other = { actor: await actorId(pub), pub, secret };
    const otherNetwork = new Network(other, {}, () => {}, () => {}); otherNetwork.sign = await signer(other);
    await apply({ id: crypto.randomUUID(), actor: other.actor, nick: '其＊人', t: now - 3600000, roots: [world.id], kind: 'fish', x: 500, y: 15, cells: [0, 1].map(x => ({ x, y: 0, ch: '口', color: '#aabbcc' })), cost: 2 }, otherNetwork);
    world.recordMovement(id, 12.5, now); world.data.tick = now; checkpoint.world = world.serialize(); checkpoint.lastOnlineAt = now; await set('checkpoint', checkpoint); return id;
  }); await setup.close();
  fishPage = await open(fishContext); await ready(fishPage); await fishPage.keyboard.press('p');
  assert.equal(await fishPage.locator('#myFishList [data-fish]').count(), 1, '我的鱼混入其他作者'); assert.equal(await fishPage.locator('#myFishList [data-fish]').getAttribute('data-fish'), ownId);
  await fishPage.screenshot({ path: path.join(project, 'test-output', 'my-fish-list.png') });
  await fishPage.locator('#myFishList [data-fish]').click(); assert.equal(await fishPage.evaluate(() => tide.view.followingFish), null); await fishPage.locator('#followFish').click(); await fishPage.waitForFunction(id => tide.view.followingFish === id, ownId);
  assert.equal(await fishPage.locator('#fishMeals24').textContent(), '1 颗'); assert.equal(await fishPage.locator('#fishHunger').textContent(), '未饥饿'); assert(parseFloat(await fishPage.locator('#fishMovement').textContent()) >= 12.5);
  await fishPage.screenshot({ path: path.join(project, 'test-output', 'fish-observation.png') });
  await fishPage.setViewportSize({ width: 390, height: 844 }); await fishPage.locator('#myFish').click(); assert.equal(await fishPage.locator('#myFishDialog').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await fishPage.locator('#myFishList [data-fish]').click(); await pause(200);
  assert.equal(await fishPage.evaluate(id => { const data = tide.world.data, fish = data.fishes[id], cells = Object.values(data.chars).filter(c => c.kind === 'fish' && c.entity === id), xs = cells.map(c => c.x), ys = cells.map(c => c.y), centerY = fish.y + (Math.min(...ys) + Math.max(...ys)) / 2, centerX = fish.x + fish.facing * (Math.min(...xs) + Math.max(...xs)) / 2, view = tide.view, size = 18 * view.scale, px = innerWidth / 2 + (centerX - view.camera.x) * size, py = innerHeight / 2 + (centerY - view.camera.y) * size; return px > document.querySelector('.tools').getBoundingClientRect().right && py > document.getElementById('inspector').getBoundingClientRect().bottom && py < innerHeight - 100; }, ownId), true, '小屏定位后鱼被面板遮住');
  await fishPage.screenshot({ path: path.join(project, 'test-output', 'fish-observation-mobile.png') });
  const beforeFeeding = await fishPage.evaluate(() => tide.balance()); await fishPage.locator('#feed').click(); assert.equal(await fishPage.locator('#inspector').isVisible(), false); await fishPage.locator('#placeFood').click();
  await fishPage.mouse.click(220, 844 * .27); await fishPage.waitForFunction(balance => tide.balance() === balance - 1, beforeFeeding); await fishPage.keyboard.press('Escape');
  await fishPage.locator('#myFish').click(); await fishPage.locator('#myFishList [data-fish]').click();
  assert.equal(await fishPage.evaluate(() => tide.view.followingFish), null); await fishPage.locator('#followFish').click();
  const operationCount = await fishPage.evaluate(() => Object.keys(tide.world.data.ops).length);
  await fishPage.evaluate(() => { const original = Date.now; Date.now = () => original() + 2 * 3600000; });
  await fishPage.waitForFunction(() => document.getElementById('fishHunger').textContent === '饥饿'); assert.equal(await fishPage.locator('#fishMeals24').textContent(), '0 颗');
  await fishPage.locator('#followFish').click(); assert.equal(await fishPage.evaluate(() => tide.view.followingFish), null);
  await fishPage.locator('#followFish').click(); await fishPage.mouse.move(210, 610); await fishPage.mouse.down(); await fishPage.mouse.move(250, 640, { steps: 4 }); await fishPage.mouse.up(); assert.equal(await fishPage.evaluate(() => tide.view.followingFish), null, '拖动水域没有停止跟随');
  assert.equal(await fishPage.evaluate(() => Object.keys(tide.world.data.ops).length), operationCount, '观察行为产生鱼控制操作');
  await fishPage.close(); await pause(400); await fishContext.addInitScript(() => { const original = Date.now; Date.now = () => original() + 2 * 3600000; }); fishPage = await open(fishContext); await ready(fishPage); assert.equal(await fishPage.evaluate(id => Object.values(tide.world.data.travel[id].days).reduce((a, b) => a + b, 0) >= 12.5, ownId), true, '重开丢失运动量'); await fishContext.close();
  assert.deepEqual(errors, []);
  const result = { edge: 'passed', version: browser.version(), fixture: 'Node static/pairing service, no launcher execution', checks: ['short offline preserves fish, scenery, wallet and roots', 'no 15-second premature archive', '239-hour legacy checkpoint restoration', '240-hour expiry creates new genesis world with 20 characters and archive', 'short sleep preserves world', '240-hour sleep expires world', 'independent custom food with preview and glyph validation', 'surface-only food costs one character, cancellation is free', 'my fish filters by signed creator', 'fish status shows movement and rolling meal count', '24-hour hunger updates while observing', 'one-click focus and follow without fish control operations', 'manual pan stops follow', 'fish remains visible beside mobile inspector', 'movement survives reopen'], errors };
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); fs.writeFileSync(path.join(project, 'test-output', 'browser-lifecycle-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); server.close(); });
