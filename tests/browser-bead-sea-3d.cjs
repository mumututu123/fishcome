const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const setup = await context.newPage(); await setup.goto(origin + '/welcome.html');
  const fixture = await setup.evaluate(async () => {
    const { World } = await import('./engine.js'), { newIdentity, signer, set } = await import('./storage.js'), { Network } = await import('./network.js');
    const me = await newIdentity('拼豆海景'), now = Date.now(), world = new World(now, undefined, { populate: false, ambient: false }), sender = new Network(me, {}, () => {}, () => {}); sender.sign = await signer(me);
    async function apply(body) { const op = { id: crypto.randomUUID(), actor: me.actor, nick: me.nick, t: now, roots: [world.id], ...body }; const result = world.apply({ ...op, proof: await sender.makeEnvelope('op', op) }); if (!result.ok) throw new Error(result.error); return op.id; }
    const blue = await apply({ kind: 'fish', gender: 'male', name: '蓝鱼', x: 373, y: 24, cells: Array.from('>口鱼鱼<', (ch, x) => ({ x, y: 0, ch, color: '#79b8ff' })), cost: 5 });
    const pink = await apply({ kind: 'fish', gender: 'female', name: '粉鱼', x: 381, y: 22, cells: Array.from('>o鱼<', (ch, x) => ({ x, y: 0, ch, color: '#ff9fc8' })), cost: 4 });
    const scene = await apply({ kind: 'scene', x: 389, y: 26, cells: [[0,0],[1,0],[2,0],[0,1],[2,1],[0,2],[2,2]].map(([x,y]) => ({ x, y, ch: y === 2 ? '石' : '木', color: y === 2 ? '#e0f4f7' : '#a5dc86' })), cost: 7 });
    await set('known', []); await set('checkpoint', { world: world.serialize(), lastOnlineAt: now }); return { blue, pink, scene };
  }); await setup.close();
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await page.waitForFunction(() => window.tide);
  const renderChecks = await page.evaluate(async () => {
    const { World } = await import('./engine.js'), { Renderer } = await import('./renderer.js'), { Scene3D } = await import('./scene-3d.js');
    const world = new World(Date.now(), undefined, { populate: false, ambient: false }); world.data = structuredClone(tide.world.data);
    const canvas = document.createElement('canvas'), renderer = new Renderer(canvas); renderer.camera = structuredClone(tide.view.camera); renderer.zoom(2);
    const before = JSON.stringify(world.serialize()), pointBefore = renderer.point(500, 430); renderer.draw(world, 0); const flat = canvas.toDataURL();
    const scene = renderer.scene3d = new Scene3D(), kinds = []; const original = scene.glyph;
    scene.glyph = function (...args) { kinds.push(args[8]); return original.apply(this, args); };
    renderer.draw(world, 0); const pointAfter = renderer.point(500, 430), relief = canvas.toDataURL();
    const routed = { fish: kinds.includes('fish'), scene: kinds.includes('scene') };
    renderer.preview = { kind: 'fish', x: 383, y: 25, cells: [{ x: 0, y: 0, ch: '鱼', color: '#79b8ff' }] }; renderer.draw(world, 0); const previewBead = kinds.includes('beadPreview');
    renderer.preview = { kind: 'food', x: 383, y: 0, ch: '.', color: '#ffcc66' }; kinds.length = 0; renderer.draw(world, 0); const foodPreviewPlain = kinds.includes('preview') && !kinds.includes('beadPreview');
    const test = document.createElement('canvas'); test.width = test.height = 128; const ctx = test.getContext('2d');
    function rim(kind, fallback) {
      scene.glyphs.clear(); scene.glyphBudget = fallback ? 0 : 24; ctx.clearRect(0, 0, 128, 128);
      scene.glyph(ctx, '.', '#79b8ff', 16, 16, 64, 1, false, kind);
      return { top: ctx.getImageData(48, 22, 1, 1).data[3], corner: ctx.getImageData(18, 18, 1, 1).data[3], center: ctx.getImageData(48, 48, 1, 1).data[3] };
    }
    const cached = ['fish', 'scene'].map(kind => rim(kind, false)), fallback = ['fish', 'scene'].map(kind => rim(kind, true)), food = rim('food', false);
    scene.glyphs.clear(); scene.glyphBudget = 24;
    for (let i = 0; i < 100; i++) scene.glyph(ctx, '.', '#' + (0x334455 + i).toString(16), 16, 16, 64, 1, false, 'fish');
    const budget = { cached: scene.glyphs.size, remaining: scene.glyphBudget };
    scene.glyphs.clear(); for (let i = 0; i < 512; i++) scene.glyphs.set(`busy:${i}`, { sprite: test, lastSeen: scene.frameNumber }); scene.glyphBudget = 24;
    ctx.clearRect(0, 0, 128, 128); scene.glyph(ctx, '鱼', '#79b8ff', 16, 16, 64, 1, true, 'fish'); const fullCacheFallback = ctx.getImageData(48, 22, 1, 1).data[3];
    return { routed, cached, fallback, food, budget, fullCacheFallback, cacheLimit: scene.glyphs.size, pointBefore, pointAfter, changed: flat !== relief, unchangedWorld: before === JSON.stringify(world.serialize()), previewBead, foodPreviewPlain };
  });
  assert.deepEqual(renderChecks.routed, { fish: true, scene: true }); assert(renderChecks.changed); assert(renderChecks.unchangedWorld); assert.deepEqual(renderChecks.pointBefore, renderChecks.pointAfter); assert(renderChecks.previewBead); assert(renderChecks.foodPreviewPlain);
  for (const shape of [...renderChecks.cached, ...renderChecks.fallback]) { assert(shape.top > 180 && shape.center > 180, '鱼和造景应有完整的拼豆表面'); assert(shape.corner < 30, '拼豆应保持圆形轮廓'); }
  assert.equal(renderChecks.food.top, 0); assert.equal(renderChecks.budget.cached, 24); assert.equal(renderChecks.budget.remaining, 0); assert.equal(renderChecks.cacheLimit, 512); assert(renderChecks.fullCacheFallback > 180);
  const wallet = await page.evaluate(() => tide.balance()); await page.locator('#scene3dToggle').click(); await page.waitForFunction(() => document.getElementById('scene3dToggle').getAttribute('aria-pressed') === 'true');
  for (let i = 0; i < 7; i++) await page.locator('#zoomIn').click();
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); await page.locator('#collapseChat').click(); await page.screenshot({ path: path.join(project, 'test-output', 'bead-sea-3d-desktop.png') });
  async function clickObject(id, kind) {
    const point = await page.evaluate(async ({ id, kind }) => { const { deltaX } = await import('./geography.js'); const data = tide.world.data, object = kind === 'fish' ? data.fishes[id] : data.scenes[id], cell = Object.values(data.chars).find(c => c.entity === id && c.kind === kind), view = tide.view, size = 18 * view.scale; const x = object.x + (kind === 'fish' ? object.facing : 1) * cell.x; return { x: innerWidth / 2 + (deltaX(x, view.camera.x) + .5) * size, y: innerHeight / 2 + (object.y + cell.y - view.camera.y + .5) * size }; }, { id, kind });
    await page.mouse.click(point.x, point.y); assert.equal(await page.evaluate(() => tide.view.selected?.id), id);
  }
  await clickObject(fixture.blue, 'fish'); assert.equal(await page.locator('#objectTitle').textContent(), '蓝鱼'); await page.locator('#closeInspector').click(); await clickObject(fixture.scene, 'scene'); assert(await page.locator('#sceneActions').isVisible()); await page.locator('#closeInspector').click();
  await page.locator('#scene3dToggle').click(); assert.equal(await page.locator('#scene3dToggle').getAttribute('aria-pressed'), 'false'); assert.equal(await page.evaluate(() => tide.balance()), wallet); await page.locator('#scene3dToggle').click(); await page.waitForFunction(() => document.getElementById('scene3dToggle').getAttribute('aria-pressed') === 'true');
  await page.reload(); await page.waitForFunction(() => document.getElementById('scene3dToggle').getAttribute('aria-pressed') === 'true'); await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#myFish').click(); await page.locator(`[data-fish="${fixture.pink}"]`).click(); await page.locator('#closeInspector').click(); await page.screenshot({ path: path.join(project, 'test-output', 'bead-sea-3d-mobile.png') });
  assert.deepEqual(errors, []); console.log('3D拼豆海景：鱼/造景与编辑器共用颗粒、圆形留白、缓存预算及回退、投放预览、点击坐标、切换及刷新偏好、余额与世界状态不变、手机布局通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
