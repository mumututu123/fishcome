const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const project = path.resolve(__dirname, '..'), errors = []; let browser;
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream');
  // Use the production dialog and Creator with a controllable wallet and placement callback.
  response.end(route === '/' ? fs.readFileSync(file, 'utf8').replace('<script type="module" src="app.js"></script>', '') : fs.readFileSync(file));
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { Creator } = await import('./creator.js'); window.wallet = 500; window.placed = [];
    window.creator = new Creator((kind, cells, gender, name) => placed.push({ kind, cells, gender, name }), () => wallet, size => Array.from('拼豆测试的第1条鱼').slice(0, size).join(''));
    creator.open('fish');
  });
  const cells = () => page.evaluate(() => [...creator.cells.values()]);
  const index = () => page.evaluate(() => creator.beadIndex);
  const open = async kind => { await page.evaluate(kind => { if (document.getElementById('creatorDialog').open) document.getElementById('creatorDialog').close(); creator.open(kind); }, kind); };
  const point = async (x, y) => { await page.locator('#gridCanvas').scrollIntoViewIfNeeded(); const box = await page.locator('#gridCanvas').boundingBox(), size = await page.evaluate(() => creator.size); return { x: box.x + (x + .5) * box.width / size, y: box.y + (y + .5) * box.height / size }; };
  const click = async (x, y, options) => { const p = await point(x, y); await page.mouse.click(p.x, p.y, options); };
  const drag = async (a, b) => { const start = await point(...a), end = await point(...b); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up(); };
  const color = async value => page.locator('#colorInput').fill(value);
  const validation = page.locator('#drawingValidation'), place = page.locator('#placeDrawing');

  await page.locator('#glyphInput').fill('鱼来快乐'); assert.equal(await page.locator('[data-bead-index]').count(), 4);
  await page.locator('#beadSequence').click();
  await drag([5, 4], [5, 7]); assert.equal((await cells()).length, 1); assert.equal(await index(), 1);
  await click(5, 5); await click(5, 6); await click(5, 7);
  assert.deepEqual((await cells()).map(c => c.ch), ['鱼', '来', '快', '乐']); assert.equal(await index(), 4); assert(await place.isEnabled()); assert(await page.locator('#restartBeads').isVisible());
  await click(6, 7); assert.equal((await cells()).length, 4);
  await page.locator('#undoDrawing').click(); assert.equal(await index(), 3); assert.equal((await cells()).length, 3);
  await page.locator('#redoDrawing').click(); assert.equal(await index(), 4); assert.equal((await cells()).length, 4);
  await page.locator('#restartBeads').click(); assert.equal(await index(), 0);
  const before = await cells(); await click(5, 5); assert.deepEqual(await cells(), before); assert.equal(await index(), 0);
  await page.locator('#replaceBead').click(); assert.equal((await cells())[1].ch, '鱼'); assert.equal(await index(), 1);
  await page.locator('#undoDrawing').click(); assert.deepEqual(await cells(), before); assert.equal(await index(), 0);

  await page.locator('#glyphInput').fill('口'); await page.locator('#beadRepeat').click();
  await drag([6, 4], [8, 4]); assert.equal((await cells()).length, 7);
  await page.locator('#undoDrawing').click(); assert.equal((await cells()).length, 4); await page.locator('#redoDrawing').click(); assert.equal((await cells()).length, 7);
  await color('#ff9933'); await page.locator('#colorPen').click();
  const shape = (await cells()).map(({ x, y, ch }) => ({ x, y, ch }));
  await drag([5, 4], [8, 4]); assert.deepEqual((await cells()).map(({ x, y, ch }) => ({ x, y, ch })), shape);
  assert((await cells()).filter(c => c.y === 4).every(c => c.color === '#ff9933'));
  await click(12, 12); assert.equal((await cells()).length, 7);
  await page.locator('#selectBeads').click(); await drag([5, 4], [8, 4]); assert.match(await page.locator('#beadSelectionCount').textContent(), /4 个字/);
  await color('#79b8ff'); await page.locator('#recolorBeads').click(); assert((await cells()).filter(c => c.y === 4).every(c => c.color === '#79b8ff')); assert((await cells()).filter(c => c.y !== 4).every(c => c.color !== '#79b8ff'));
  await page.locator('#undoDrawing').click(); assert((await cells()).filter(c => c.y === 4).every(c => c.color === '#ff9933'));
  await page.locator('#selectAllBeads').click(); await color('#a5dc86'); await page.locator('#recolorBeads').click(); assert((await cells()).every(c => c.color === '#a5dc86'));
  await page.locator('#clearBeadSelection').click();
  await page.locator('#beadPen').click(); await click(6, 4, { button: 'right' }); assert.equal((await cells()).length, 6);
  await page.locator('#gridCanvas').focus(); await page.keyboard.press('Control+z'); assert.equal((await cells()).length, 7); await page.keyboard.press('Control+Shift+z'); assert.equal((await cells()).length, 6);
  await page.locator('#undoDrawing').click();

  await page.locator('#glyphInput').fill('😀'); assert.equal(await page.locator('[data-bead-index]').count(), 0); assert.equal(await page.locator('#glyphInput').getAttribute('aria-invalid'), 'true');
  await page.locator('#beadPen').click(); await click(10, 10); assert.equal((await cells()).length, 7);
  await page.locator('#glyphInput').fill('水\n 草 𠮷'); assert.equal(await page.locator('[data-bead-index]').count(), 3);
  await page.locator('#glyphInput').fill('');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'shui', selectionStart: 4, selectionEnd: 4 }); assert.equal(await page.locator('[data-bead-index]').count(), 0);
  await cdp.send('Input.insertText', { text: '水草' }); assert.equal(await page.locator('[data-bead-index]').count(), 2); assert.equal((await cells()).length, 7);

  await open('fish'); await page.locator('#glyphInput').fill('口');
  assert(await place.isDisabled()); await click(4, 4); assert(await place.isDisabled()); assert.match(await validation.textContent(), /至少/);
  await click(10, 10); assert(await place.isDisabled()); assert.match(await validation.textContent(), /八方向/);
  await click(10, 10, { button: 'right' }); await click(5, 5); assert(await place.isEnabled());
  await page.evaluate(() => { wallet = 1; creator.render(); }); assert(await place.isDisabled()); assert.match(await validation.textContent(), /余额不足/);
  await page.evaluate(() => { wallet = 500; creator.render(); });
  await page.locator('#fishNameInput').fill('名字太长'); assert(await place.isDisabled()); await page.locator('#fishNameInput').fill('豆鱼'); assert(await place.isEnabled());
  await page.evaluate(() => { wallet = 0; }); await page.evaluate(() => document.getElementById('placeDrawing').click()); assert.equal(await page.evaluate(() => placed.length), 0); assert(await page.locator('#creatorDialog').isVisible());
  await page.evaluate(() => { wallet = 500; creator.render(); });
  for (let x = 0; x < 15; x++) await click(x, 4);
  assert.equal((await cells()).length, 16); assert(await place.isDisabled()); assert.match(await validation.textContent(), /最多使用 15/);

  for (const [name, invalid] of [
    ['越界', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 15, y: 0, ch: '口', color: '#79b8ff' }]],
    ['颜色', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 1, y: 0, ch: '口', color: 'red' }]],
    ['字元', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 1, y: 0, ch: '😀', color: '#79b8ff' }]],
    ['重复位置', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 0, y: 0, ch: '鱼', color: '#79b8ff' }]]
  ]) {
    await page.evaluate(cells => { creator.cells = new Map(cells.map((c, i) => [String(i), c])); creator.render(); }, invalid);
    assert(await place.isDisabled(), name); await page.evaluate(() => document.getElementById('placeDrawing').onclick()); assert.equal(await page.evaluate(() => placed.length), 0, name);
  }

  await open('fish'); assert(await page.locator('#creatorEyes').isVisible()); assert.match(await page.locator('#creatorEyeHint').textContent(), /没有鱼眼也可以/);
  assert.match(await page.locator('#beadConcept').textContent(), /每格消耗 1 鱼元/); assert(!/字豆/.test(await page.locator('#creatorDialog').innerText()));
  for (const [i, ch] of ['0', 'O', 'o', '。', '.', '口'].entries()) {
    await page.locator(`[data-eye-glyph="${ch}"]`).click(); assert.equal((await cells()).length, i); assert.match(await page.locator('#beadPenStatus').textContent(), /可作鱼眼/);
    await click(4 + i, 5); assert.equal(await page.locator('#drawingEyes').textContent(), String(i + 1));
  }
  assert.match(await page.locator('#creatorEyeHint').textContent(), /已拼 6 个鱼眼/); assert(await place.isEnabled());
  await page.locator('#clearDrawing').click(); await page.locator('#glyphInput').fill('鱼'); await click(5, 5); await click(6, 5);
  assert.equal(await page.locator('#drawingEyes').textContent(), '0'); assert.match(await page.locator('#creatorEyeHint').textContent(), /盲鱼/); assert(await place.isEnabled());

  await open('fish'); await color('#79b8ff'); await page.locator('#glyphInput').fill('>口鱼鱼鱼鱼<'); await page.locator('#beadSequence').click();
  await page.locator('[data-bead-index="1"]').click(); await color('#ffcc66'); await page.locator('[data-bead-index="0"]').click();
  for (let i = 0; i < 7; i++) await click(4 + i, 7);
  assert.equal((await cells())[1].color, '#ffcc66'); assert((await cells()).filter((c, i) => i !== 1).every(c => c.color !== '#ffcc66'));
  await page.locator('#fishNameInput').fill('小蓝鱼'); await page.locator('#fishGenderFemale').check(); assert(await place.isEnabled());
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true });
  await page.locator('.creatorWorkspace').evaluate(node => { node.scrollTop = 0; }); await page.screenshot({ path: path.join(project, 'test-output', 'creator-beads-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(project, 'test-output', 'creator-beads-mobile.png') });
  assert(await page.locator('#creatorDialog').evaluate(node => node.scrollWidth <= node.clientWidth));
  await place.click(); const submitted = await page.evaluate(() => placed.at(-1)); assert.equal(submitted.kind, 'fish'); assert.equal(submitted.gender, 'female'); assert.equal(submitted.name, '小蓝鱼'); assert.equal(submitted.cells.length, 7);

  await open('scene'); await page.locator('#glyphInput').fill('木石'); await page.locator('#beadSequence').click(); await click(19, 18); await click(19, 19); assert(await place.isEnabled()); assert(await page.locator('#fishNameLabel').isHidden()); assert(await page.locator('#drawingEyesLabel').isHidden()); assert(await page.locator('#creatorEyes').isHidden()); assert.equal(await page.locator('.eyeBead').count(), 0);
  await place.click(); const scenery = await page.evaluate(() => placed.at(-1)); assert.equal(scenery.kind, 'scene'); assert.equal(scenery.gender, undefined); assert.equal(scenery.name, undefined); assert.equal(scenery.cells.length, 2);
  await open('scene'); await page.locator('#glyphInput').fill('木'); await page.locator('#beadRepeat').click(); await drag([0, 0], [19, 0]); assert.equal((await cells()).length, 20); assert(await place.isEnabled());
  await page.locator('#drawTab').click(); assert(await page.locator('#eraseBrush').isVisible()); const sketch = await page.locator('#sketchCanvas').boundingBox();
  await page.mouse.move(sketch.x + sketch.width / 3, sketch.y + sketch.height / 2); await page.mouse.down(); await page.mouse.move(sketch.x + sketch.width * 2 / 3, sketch.y + sketch.height / 2, { steps: 8 }); await page.mouse.up();
  await page.locator('#convertDrawing').click(); assert.equal(await page.evaluate(() => creator.tab), 'grid'); assert((await cells()).length >= 2); assert(await place.isEnabled());
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(`http://127.0.0.1:${server.address().port}`);
  await touchPage.evaluate(async () => { const { Creator } = await import('./creator.js'); window.creator = new Creator(() => {}, () => 20, n => '豆'.slice(0, n)); creator.open('scene'); });
  await touchPage.locator('#glyphInput').fill('木石'); await touchPage.locator('#beadSequence').click();
  for (const y of [18, 19]) { await touchPage.locator('#gridCanvas').scrollIntoViewIfNeeded(); const box = await touchPage.locator('#gridCanvas').boundingBox(); await touchPage.touchscreen.tap(box.x + 19.5 * box.width / 20, box.y + (y + .5) * box.height / 20); }
  assert.deepEqual(await touchPage.evaluate(() => [...creator.cells.values()].map(c => c.ch)), ['木', '石']); assert(await touchPage.locator('#placeDrawing').isEnabled());
  assert(await touchPage.locator('#placeDrawing').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }));
  await touchContext.close();
  assert.deepEqual(errors, []); console.log('拼豆：多字/中文输入法、重复拖动、顺序逐粒、完成与重启、保护已有字、替换、配色与批量着色、撤销重做、手机布局、造鱼造景校验与提交、辅助手绘通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
