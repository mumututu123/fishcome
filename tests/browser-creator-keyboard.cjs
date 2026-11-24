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
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.locator('#nickInput').fill('键盘测试'); await page.locator('#welcomeForm .primary').click(); await page.waitForFunction(() => window.tide);
  const input = page.locator('#gridCellInput'), count = page.locator('#drawingCount');
  async function cell(x, y) { assert.equal(await input.getAttribute('aria-label'), `字符画板第 ${y + 1} 行，第 ${x + 1} 列`); }
  async function glyph(x, y, ch, color) {
    assert(await page.locator('#gridCanvas').evaluate((canvas, { x, y, ch, color }) => {
      const ctx = canvas.getContext('2d'), size = document.querySelector('#creatorTitle').textContent.includes('鱼') ? 15 : 20, s = 400 / size;
      const border = ctx.getImageData(Math.round(x * s + 1), Math.round(y * s + s / 2), 1, 1).data;
      if ([154, 238, 224].some((value, i) => Math.abs(border[i] - value) > 2) || border[3] < 100) return false;
      // Check the rendered glyph against an independent canvas with the same font and position.
      const reference = document.createElement('canvas'); reference.width = reference.height = 400;
      const other = reference.getContext('2d'); other.font = `${s * .8}px 'Microsoft YaHei',Consolas,monospace`; other.textAlign = 'center'; other.textBaseline = 'middle'; other.fillStyle = color; other.fillText(ch, (x + .5) * s, (y + .5) * s, s);
      const left = Math.ceil(x * s + 4), top = Math.ceil(y * s + 4), width = Math.floor(s - 8), pixels = ctx.getImageData(left, top, width, width).data, expected = other.getImageData(left, top, width, width).data;
      return expected.some((v, i) => i % 4 === 3 && v > 0 && pixels[i] === v && pixels[i - 1] === expected[i - 1] && pixels[i - 2] === expected[i - 2] && pixels[i - 3] === expected[i - 3]);
    }, { x, y, ch, color }));
  }
  await page.locator('#makeFish').click(); assert(await input.evaluate(node => node === document.activeElement)); await cell(0, 0);
  await page.keyboard.press('Tab'); assert(await page.locator('#fishNameInput').evaluate(node => node === document.activeElement)); await page.locator('#gridCanvas').focus();
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp'); await cell(0, 0);
  await page.keyboard.type('O'); assert.equal(await count.textContent(), '1'); await glyph(0, 0, 'O', '#8be7df');
  await page.keyboard.press('ArrowRight'); await cell(1, 0); await page.keyboard.insertText('鱼'); assert.equal(await count.textContent(), '2'); await glyph(1, 0, '鱼', '#8be7df');
  // Real Chromium IME composition keeps the draft out of the drawing until committed.
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.press('ArrowDown'); await cell(1, 1);
  await cdp.send('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 }); assert.equal(await count.textContent(), '2');
  await cdp.send('Input.insertText', { text: '石' }); assert.equal(await count.textContent(), '3'); await glyph(1, 1, '石', '#8be7df');
  await page.keyboard.press('Backspace'); assert.equal(await count.textContent(), '2'); await page.locator('#undoDrawing').click(); assert.equal(await count.textContent(), '3');
  await page.locator('#gridCanvas').focus(); await page.keyboard.insertText('𠮷'); assert.equal(await count.textContent(), '3'); await glyph(1, 1, '𠮷', '#8be7df');
  await page.keyboard.insertText('两个'); await page.keyboard.insertText('😀'); assert.equal(await count.textContent(), '3');
  await page.locator('#fishNameInput').fill('阿鱼'); await page.locator('#fishNameInput').press('ArrowLeft'); assert.equal(await count.textContent(), '3'); await cell(1, 1);
  await page.locator('#drawTab').click(); await page.locator('#gridTab').click(); assert(await input.evaluate(node => node === document.activeElement)); await cell(1, 1);
  assert(await page.locator('#drawingEyesLabel').isVisible()); await page.screenshot({ path: path.join(project, 'test-output', 'creator-keyboard-fish.png') });
  await page.locator('#closeCreator').click(); await page.locator('#makeScene').click(); await cell(0, 0); assert(await page.locator('#drawingEyesLabel').isHidden());
  assert(!/眼睛|盲鱼/.test(await page.locator('#creatorDialog').innerText()));
  await page.keyboard.insertText('木'); await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('石'); await glyph(1, 0, '石', '#8be7df'); assert(await page.locator('#placeDrawing').isEnabled());
  for (let i = 0; i < 25; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown'); } await cell(19, 19);
  await page.keyboard.insertText('水'); await page.keyboard.press('Delete'); assert.equal(await count.textContent(), '2');
  const grid = await page.locator('#gridCanvas').boundingBox(); await page.mouse.click(grid.x + 2.5 * grid.width / 20, grid.y + .5 * grid.height / 20); await cell(2, 0); await page.keyboard.insertText('#'); await glyph(2, 0, '#', '#8be7df');
  await page.locator('#drawTab').click(); assert(!/眼睛|盲鱼/.test(await page.locator('#creatorDialog').innerText())); await page.locator('#gridTab').click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(project, 'test-output', 'creator-keyboard-scene-mobile.png') });
  await page.locator('#closeCreator').click(); await page.locator('#makeFish').click(); assert(await page.locator('#drawingEyesLabel').isVisible()); await cell(0, 0); assert.equal(await count.textContent(), '0');
  assert.deepEqual(errors, []); console.log('方向键选格及边界、ASCII/中文/扩展汉字、IME组合输入、高亮、覆盖/擦除/撤销、鼠标衔接、模式切换与造景无眼睛提示通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
