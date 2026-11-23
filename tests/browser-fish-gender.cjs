const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), errors = [];
let origin, browser;
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  if (route === '/local/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: origin } : { ok: true, clients: [], hints: [] })); return; }
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream');
  response.end(fs.readFileSync(file));
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#nickInput').fill('完整昵称测试'); await page.locator('#welcomeForm .primary').click(); await page.waitForFunction(() => window.tide);
  for (const [index, gender] of ['male', 'female'].entries()) {
    await page.locator('#makeFish').click();
    assert(await page.locator('#fishGenderMale').isChecked(), '每次新建默认公');
    await page.locator(`input[name="fishGender"][value="${gender}"]`).check();
    // Switching drawing tools must preserve the selected gender.
    await page.locator('#drawTab').click(); await page.locator('#gridTab').click();
    assert(await page.locator(`input[name="fishGender"][value="${gender}"]`).isChecked());
    const grid = await page.locator('#gridCanvas').boundingBox();
    for (const x of [7.5, 8.5]) await page.mouse.click(grid.x + x * grid.width / 15, grid.y + 7.5 * grid.height / 15);
    await page.locator('#placeDrawing').click(); await page.mouse.click(600 + index * 150, 370);
    await page.waitForFunction(count => tide.world.counts.fish === count, index + 1);
  }
  await page.locator('#makeScene').click(); assert(await page.locator('#fishGenderPicker').isHidden()); await page.locator('#closeCreator').click();
  const fishes = await page.evaluate(() => Object.values(tide.world.data.fishes));
  assert.deepEqual(fishes.map(fish => fish.gender).sort(), ['female', 'male']);
  assert(fishes.every(fish => fish.nick.includes('＊')), '公共创建记录保持打码');
  await page.locator('#myFish').click();
  for (const fish of fishes) {
    const card = page.locator(`[data-fish="${fish.id}"]`);
    assert((await card.locator('.fishCardInfo').textContent()).includes('完整昵称测试'));
    assert.equal(await card.locator('.fishGender').textContent(), fish.gender === 'male' ? '♂ 公' : '♀ 母');
    assert.equal(await card.locator('.fishGender').evaluate(node => getComputedStyle(node).color), fish.gender === 'male' ? 'rgb(121, 184, 255)' : 'rgb(255, 159, 200)');
  }
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true });
  await page.screenshot({ path: path.join(project, 'test-output', 'my-fish-gender.png') });
  await page.locator(`[data-fish="${fishes[1].id}"]`).click();
  assert((await page.locator('#objectInfo').textContent()).includes('完整昵称测试'));
  assert.equal(await page.locator('#fishGender').textContent(), '♀ 母');
  await page.reload(); await page.waitForFunction(() => window.tide); await page.locator('#myFish').click();
  assert.equal(await page.locator('#myFishList .fishGender.male').count(), 1); assert.equal(await page.locator('#myFishList .fishGender.female').count(), 1);
  await page.locator('#closeMyFish').click(); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#makeFish').click();
  assert(await page.locator('#fishGenderFemale').isVisible());
  await page.locator('#fishGenderFemale').check();
  await page.screenshot({ path: path.join(project, 'test-output', 'creator-fish-gender-mobile.png') });
  assert.deepEqual(errors, []); console.log('完整昵称、公母创建、图标颜色、重载持久化、造景隐藏和小屏选择通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
