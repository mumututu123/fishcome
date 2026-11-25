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
  const stock = () => page.evaluate(() => creator.beads.map(bead => ({ ...bead })));
  const held = () => page.evaluate(() => creator.heldBead && { ...creator.heldBead });
  const open = async kind => { await page.evaluate(kind => { if (document.getElementById('creatorDialog').open) document.getElementById('creatorDialog').close(); creator.open(kind); }, kind); };
  const point = async (x, y) => { await page.locator('#gridCanvas').scrollIntoViewIfNeeded(); const box = await page.locator('#gridCanvas').boundingBox(), size = await page.evaluate(() => creator.size); return { x: box.x + (x + .5) * box.width / size, y: box.y + (y + .5) * box.height / size }; };
  const click = async (x, y, options) => { const p = await point(x, y); await page.mouse.click(p.x, p.y, options); };
  const drag = async (a, b) => { const start = await point(...a), end = await point(...b); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up(); };
  const color = async value => page.locator('#colorInput').fill(value);
  const prepare = async text => { const before = new Set((await stock()).map(b => b.id)); await page.locator('#glyphInput').fill(text); await page.locator('#prepareBeads').click(); return (await stock()).filter(b => !before.has(b.id)); };
  const take = async bead => page.locator(`[data-bead-id="${bead.id}"]`).click();
  const placeText = async (text, points) => { const beads = await prepare(text); for (let i = 0; i < beads.length; i++) { await take(beads[i]); await click(...points[i]); } return beads; };
  const conserved = async total => {
    const inventory = await page.evaluate(() => ({ ids: [...creator.beads.map(b => b.id), ...(creator.heldBead ? [creator.heldBead.id] : []), ...[...creator.cellBeads.values()].map(b => b.id)], cells: creator.cells.size, placed: creator.cellBeads.size }));
    assert.equal(inventory.ids.length, total, '夹取、拼放、放回不能丢失或复制豆子'); assert.equal(new Set(inventory.ids).size, total, '每颗豆子在盘、笔、画板之间只能有一个位置'); assert.equal(inventory.cells, inventory.placed);
  };
  const validation = page.locator('#drawingValidation'), place = page.locator('#placeDrawing');

  const original = await prepare('鱼口鱼>'); assert.equal(await page.locator('[data-bead-id]').count(), 4); assert.notEqual(original[0].id, original[2].id);
  assert.equal(await page.locator('#beadRepeat').count(), 0); assert.equal(await page.locator('#beadSequence').count(), 0);
  assert.equal(await held(), null); assert.equal(await page.locator('#glyphInput').inputValue(), ''); assert(await page.locator('#prepareBeads').isDisabled());
  await take(original[2]); assert.equal(await page.locator(`[data-bead-id="${original[2].id}"]`).count(), 0); assert.equal(await page.locator('[data-bead-id]').count(), 3); assert.equal((await held()).id, original[2].id); await conserved(4);
  await page.evaluate(() => { creator.render(); creator.render(); }); assert.equal((await stock()).length, 3);
  await color('#ff9933'); await take(original[3]); assert.equal((await held()).id, original[3].id); assert.equal((await stock()).find(b => b.id === original[2].id).color, '#ff9933'); assert.notEqual((await stock()).find(b => b.id === original[0].id).color, '#ff9933'); await conserved(4);
  await page.locator('#returnBead').click(); assert.equal(await held(), null); assert.deepEqual((await stock()).map(b => b.id), original.map(b => b.id));
  const gridBefore = await page.locator('#gridCanvas').boundingBox(); await take(original[2]); assert.equal((await stock()).length, 3); await click(5, 5);
  assert.equal(await held(), null); assert.equal((await cells()).length, 1); assert.equal((await cells())[0].color, '#ff9933'); await click(6, 5); assert.equal((await cells()).length, 1); await drag([6, 5], [8, 5]); assert.equal((await cells()).length, 1); await conserved(4);
  await page.locator('#undoDrawing').click(); assert.equal((await cells()).length, 0); assert.equal((await held()).id, original[2].id); assert.equal((await stock()).length, 3);
  await page.locator('#undoDrawing').click(); assert.equal(await held(), null); assert.equal((await stock()).length, 4); await conserved(4);
  await page.locator('#redoDrawing').click(); assert.equal((await held()).id, original[2].id); await page.locator('#redoDrawing').click(); assert.equal((await cells()).length, 1); assert.equal(await held(), null); await conserved(4);

  await take(original[0]); const before = await cells(); await click(5, 5); assert.deepEqual(await cells(), before); assert.equal((await held()).id, original[0].id);
  await page.locator('#replaceBead').click(); assert.equal(await held(), null); assert((await stock()).some(b => b.id === original[2].id)); assert.equal(await page.evaluate(() => creator.cellBeads.get('5,5').id), original[0].id); await conserved(4);
  await page.locator('#undoDrawing').click(); assert.equal((await held()).id, original[0].id); assert.equal(await page.evaluate(() => creator.cellBeads.get('5,5').id), original[2].id); await page.locator('#redoDrawing').click(); await conserved(4);
  await take(original[1]); await click(6, 5); await take(original[3]); await click(7, 5); assert.equal((await cells()).length, 3); assert(await place.isEnabled());
  await prepare('木木'); assert.equal((await stock()).length, 3); await page.evaluate(() => document.getElementById('prepareBeads').onclick()); assert.equal((await stock()).length, 3); await conserved(6);
  await click(6, 5, { button: 'right' }); assert.equal((await cells()).length, 2); assert((await stock()).some(b => b.id === original[1].id)); await page.locator('#gridCanvas').focus(); await page.keyboard.press('Control+z'); assert.equal((await cells()).length, 3); await page.keyboard.press('Control+Shift+z'); assert.equal((await cells()).length, 2); await page.locator('#undoDrawing').click(); await conserved(6);
  await page.locator('#clearDrawing').click(); assert.equal((await cells()).length, 0); assert.equal((await stock()).length, 6); await conserved(6); await page.locator('#undoDrawing').click(); assert.equal((await cells()).length, 3); await conserved(6);
  await take((await stock())[0]); await page.locator('#colorPen').click(); assert.equal(await held(), null); await conserved(6);
  await color('#79b8ff'); const shape = (await cells()).map(({ x, y, ch }) => ({ x, y, ch })); await drag([5, 5], [7, 5]); assert.deepEqual((await cells()).map(({ x, y, ch }) => ({ x, y, ch })), shape); assert((await cells()).every(c => c.color === '#79b8ff'));
  await page.locator('#selectBeads').click(); await drag([5, 5], [6, 5]); assert.match(await page.locator('#beadSelectionCount').textContent(), /2 个字/); await color('#a5dc86'); await page.locator('#recolorBeads').click(); assert((await cells()).filter(c => c.x <= 6).every(c => c.color === '#a5dc86')); assert.equal((await cells()).find(c => c.x === 7).color, '#79b8ff'); await conserved(6);
  await page.locator('#eraseBrush').click(); await click(5, 5); assert.equal((await stock()).find(b => b.id === original[0].id).color, '#a5dc86'); await conserved(6);

  const stockBeforeInvalid = await stock(); await page.locator('#glyphInput').fill('😀'); assert(await page.locator('#prepareBeads').isDisabled()); assert.equal(await page.locator('#glyphInput').getAttribute('aria-invalid'), 'true'); await page.evaluate(() => document.getElementById('prepareBeads').onclick()); assert.deepEqual(await stock(), stockBeforeInvalid);
  await prepare('水\n 草 𠮷'); await conserved(9); assert((await stock()).some(b => b.ch === '𠮷'));
  await page.locator('#glyphInput').fill(''); const cdp = await page.context().newCDPSession(page); const countBeforeIme = (await stock()).length;
  await cdp.send('Input.imeSetComposition', { text: 'shui', selectionStart: 4, selectionEnd: 4 }); assert.equal((await stock()).length, countBeforeIme);
  await cdp.send('Input.insertText', { text: '水草' }); assert.equal((await stock()).length, countBeforeIme); await page.locator('#prepareBeads').click(); assert.equal((await stock()).length, countBeforeIme + 2); await conserved(11);

  await open('fish'); assert(await place.isDisabled()); const two = await prepare('口口'); await take(two[0]); await click(4, 4); assert(await place.isDisabled()); assert.match(await validation.textContent(), /至少/);
  await take(two[1]); await click(10, 10); assert(await place.isDisabled()); assert.match(await validation.textContent(), /八方向/); await click(10, 10, { button: 'right' }); await take(two[1]); await click(5, 5); assert(await place.isEnabled());
  await page.evaluate(() => { wallet = 1; creator.render(); }); assert(await place.isDisabled()); assert.match(await validation.textContent(), /余额不足/); await page.evaluate(() => { wallet = 500; creator.render(); });
  await page.locator('#fishNameInput').fill('名字太长'); assert(await place.isDisabled()); await page.locator('#fishNameInput').fill('豆鱼'); assert(await place.isEnabled());
  await page.evaluate(() => { wallet = 0; }); await page.evaluate(() => document.getElementById('placeDrawing').onclick()); assert.equal(await page.evaluate(() => placed.length), 0); await page.evaluate(() => { wallet = 500; creator.render(); });
  await placeText('口'.repeat(14), Array.from({ length: 14 }, (_, x) => [x === 4 ? 14 : x, 4])); assert.equal((await cells()).length, 16); assert(await place.isDisabled()); assert.match(await validation.textContent(), /最多使用 15/);
  for (const [name, invalid] of [
    ['越界', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 15, y: 0, ch: '口', color: '#79b8ff' }]],
    ['颜色', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 1, y: 0, ch: '口', color: 'red' }]],
    ['字元', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 1, y: 0, ch: '😀', color: '#79b8ff' }]],
    ['重复位置', [{ x: 0, y: 0, ch: '口', color: '#79b8ff' }, { x: 0, y: 0, ch: '鱼', color: '#79b8ff' }]]
  ]) { await page.evaluate(cells => { creator.cells = new Map(cells.map((c, i) => [String(i), c])); creator.render(); }, invalid); assert(await place.isDisabled(), name); await page.evaluate(() => document.getElementById('placeDrawing').onclick()); assert.equal(await page.evaluate(() => placed.length), 0, name); }

  await open('fish'); assert(await page.locator('#creatorEyes').isVisible());
  for (const [i, ch] of ['0', 'O', 'o', '。', '.', '口'].entries()) { await page.locator(`[data-eye-glyph="${ch}"]`).click(); assert.equal((await held()).ch, ch); assert.equal((await stock()).length, 0); await click(4 + i, 5); assert.equal(await page.locator('#drawingEyes').textContent(), String(i + 1)); await conserved(i + 1); }
  assert.match(await page.locator('#creatorEyeHint').textContent(), /已拼 6 个鱼眼/); assert(await place.isEnabled()); await page.locator('#clearDrawing').click(); assert.equal((await stock()).length, 6); await conserved(6);
  await open('fish'); await placeText('鱼鱼', [[5, 5], [6, 5]]); assert.equal(await page.locator('#drawingEyes').textContent(), '0'); assert.match(await page.locator('#creatorEyeHint').textContent(), /盲鱼/); assert(await place.isEnabled());

  await open('fish'); await color('#79b8ff'); const demo = await prepare('>口鱼鱼鱼鱼<水草石');
  for (let i = 0; i < 7; i++) { await take(demo[i]); if (i === 1) await color('#ffcc66'); await click(4 + i, 7); }
  assert.equal((await cells())[1].color, '#ffcc66'); assert.equal((await stock()).length, 3); await conserved(10);
  await page.locator('#fishNameInput').fill('小蓝鱼'); await page.locator('#fishGenderFemale').check(); assert(await place.isEnabled());
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); await page.locator('.creatorWorkspace').evaluate(node => { node.scrollTop = 0; }); await page.screenshot({ path: path.join(project, 'test-output', 'creator-beads-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); const paletteBefore = await page.locator('.creatorMaterials').boundingBox(); assert(paletteBefore.height < 165); await page.locator('.creatorWorkspace').evaluate(node => { node.scrollTop = node.scrollHeight; });
  assert(Math.abs((await page.locator('.creatorMaterials').boundingBox()).y - paletteBefore.y) < 1); await take(demo[7]); assert.equal((await stock()).length, 2); assert.equal((await held()).id, demo[7].id); await page.locator('#returnBead').click(); assert.equal((await stock()).length, 3); await conserved(10);
  await page.locator('.creatorWorkspace').evaluate(node => { node.scrollTop = 0; }); await page.screenshot({ path: path.join(project, 'test-output', 'creator-beads-mobile.png') }); assert(await page.locator('#creatorDialog').evaluate(node => node.scrollWidth <= node.clientWidth));
  await place.click(); const submitted = await page.evaluate(() => placed.at(-1)); assert.equal(submitted.kind, 'fish'); assert.equal(submitted.gender, 'female'); assert.equal(submitted.name, '小蓝鱼'); assert.equal(submitted.cells.length, 7); assert(submitted.cells.every(c => Object.keys(c).sort().join(',') === 'ch,color,x,y'));

  await open('scene'); await placeText('木石', [[19, 18], [19, 19]]); assert(await place.isEnabled()); assert(await page.locator('#creatorEyes').isHidden()); assert.equal((await stock()).length, 0); assert.equal(await held(), null); assert.equal(await page.locator('.eyeBead').count(), 0);
  const gridAfterLast = await page.locator('#gridCanvas').evaluate(node => node.getBoundingClientRect().top + document.querySelector('.creatorWorkspace').scrollTop); await page.locator('#undoDrawing').click(); const gridWithHeld = await page.locator('#gridCanvas').evaluate(node => node.getBoundingClientRect().top + document.querySelector('.creatorWorkspace').scrollTop); assert(Math.abs(gridWithHeld - gridAfterLast) < 2, '最后一颗夹取后画板不能跳动'); await page.locator('#redoDrawing').click();
  await place.click(); assert.equal((await page.evaluate(() => placed.at(-1))).kind, 'scene');
  await open('scene'); await placeText('木'.repeat(20), Array.from({ length: 20 }, (_, x) => [x, 0])); assert.equal((await cells()).length, 20); assert(await place.isEnabled()); await conserved(20);
  await page.locator('#drawTab').click(); const sketch = await page.locator('#sketchCanvas').boundingBox(); await page.mouse.move(sketch.x + sketch.width / 3, sketch.y + sketch.height / 2); await page.mouse.down(); await page.mouse.move(sketch.x + sketch.width * 2 / 3, sketch.y + sketch.height / 2, { steps: 8 }); await page.mouse.up(); await page.locator('#convertDrawing').click(); assert((await cells()).length >= 2); assert(await place.isEnabled()); assert.equal((await stock()).length, 20);

  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }), touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(`http://127.0.0.1:${server.address().port}`); await touchPage.evaluate(async () => { const { Creator } = await import('./creator.js'); window.creator = new Creator(() => {}, () => 20, n => '豆'.slice(0, n)); creator.open('scene'); });
  await touchPage.locator('#glyphInput').fill('木石'); await touchPage.locator('#prepareBeads').tap();
  for (const y of [18, 19]) { await touchPage.locator('[data-bead-id]').first().tap(); assert.equal(await touchPage.locator('[data-bead-id]').count(), 19 - y); await touchPage.locator('#gridCanvas').scrollIntoViewIfNeeded(); const box = await touchPage.locator('#gridCanvas').boundingBox(); await touchPage.touchscreen.tap(box.x + 19.5 * box.width / 20, box.y + (y + .5) * box.height / 20); assert.equal(await touchPage.evaluate(() => creator.heldBead), null); }
  assert.deepEqual(await touchPage.evaluate(() => [...creator.cells.values()].map(c => c.ch)), ['木', '石']); assert(await touchPage.locator('#placeDrawing').isEnabled()); await touchContext.close();
  assert.deepEqual(errors, []); console.log('有限拼豆：重复字符独立、夹取立即消失、逐颗拼放、取消归还、替换/擦除/清空归还、撤销重做无复制、独立配色、中文输入法、手机固定字符盘与触摸、全部既有检查及提交通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
