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
async function state(page) { return page.evaluate(() => ({ roots: Object.keys(tide.world.data.roots), counts: tide.world.counts, balance: tide.balance(), cards: Object.values(tide.histories).filter(c => c.status !== 'corrected') })); }
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
  await page.locator('#glyphInput').fill('口');
  for (const column of [7.5, 8.5]) await page.mouse.click(grid.x + column * grid.width / size, grid.y + 7.5 * grid.height / size);
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
  const short = await state(page); assert.deepEqual(short.roots, original.roots); assert.equal(short.balance, 16); assert.equal(short.counts.fish, 1); assert.equal(short.counts.scene, 1); assert.equal(short.cards.length, 0);
  await page.close(); await pause(500); await age(context, 239, true);
  page = await open(context); await ready(page);
  const legacy = await state(page); assert.deepEqual(legacy.roots, original.roots); assert.equal(legacy.balance, 16); assert.equal(legacy.cards.length, 0);
  await page.close(); await pause(500); await age(context, 240);
  page = await open(context); await ready(page);
  const expired = await state(page); assert.equal(expired.counts.fish, 0); assert.equal(expired.counts.scene, 0); assert.equal(expired.balance, 20); assert(!expired.roots.some(root => original.roots.includes(root))); assert(expired.cards.some(card => original.roots.every(root => card.roots.includes(root)) && Number.isFinite(card.endedAt)));
  await create(page, 'fish', 600, 370); const beforeSleep = await state(page);
  await page.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 180000; }); await pause(1200);
  const shortSleep = await state(page); assert.deepEqual(shortSleep.roots, beforeSleep.roots); assert.equal(shortSleep.counts.fish, 1); assert.equal(shortSleep.balance, 18);
  await page.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 240 * 3600000; }); await pause(1200);
  const longSleep = await state(page); assert.equal(longSleep.counts.fish, 0); assert.equal(longSleep.balance, 20); assert(longSleep.cards.some(card => beforeSleep.roots.every(root => card.roots.includes(root))));
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
  assert.deepEqual(errors, []);
  const result = { edge: 'passed', version: browser.version(), fixture: 'Node static/pairing service, no launcher execution', checks: ['short offline preserves fish, scenery, wallet and roots', 'no 15-second premature archive', '239-hour legacy checkpoint restoration', '240-hour expiry creates empty world with 20 characters and archive', 'short sleep preserves world and wallet', '240-hour sleep expires world and keeps archive', 'independent food glyph and color settings with preview', 'invalid glyphs and canceled feeding do not spend characters', 'Chinese, supplementary Han and ASCII food retain chosen colors', 'surface-only custom food costs one character per drop', 'food dialog fits desktop and narrow viewport'], errors };
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); fs.writeFileSync(path.join(project, 'test-output', 'browser-lifecycle-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); server.close(); });
