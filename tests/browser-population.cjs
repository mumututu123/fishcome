const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const www = path.resolve(__dirname, '../www'), errors = [];
let browser, origin;
const fixture = `
import { volcanoPlan } from './population.js';
window.installPopulationFixture = async kind => {
  simulation.close();
  const now = Date.now(), start = now - 3 * 3600000;
  let next = new World(start, crypto.randomUUID(), { populate: false, ambient: false });
  let id;
  if (kind === 'fish') {
    const body = { id: crypto.randomUUID(), actor: identity.actor, nick: identity.nick, kind: 'fish', gender: 'male', name: '小鱼', t: start, roots: next.roots, cost: 2, x: 380, y: 25, cells: [{x:0,y:0,ch:'o',color:'#88aacc'}, {x:1,y:0,ch:'鱼',color:'#88aacc'}] };
    const result = next.apply({ ...body, proof: await network.makeEnvelope('op', body) });
    if (!result.ok) throw new Error(result.error);
    id = body.id;
    next.data.population.illnesses[id] = { at: now, nextLossAt: now + POPULATION.dissolveEvery, curedAt: 0 };
  } else {
    const slot = Math.floor(now / POPULATION.volcanoPeriod); let plan;
    while (!(plan = volcanoPlan(next.data, slot))) next = new World(start, crypto.randomUUID(), { populate: false, ambient: false });
    const at = slot * POPULATION.volcanoPeriod, floor = next.floorAt(plan.x);
    next.data.population.eruption = { ...plan, at, emitted: 1, nextAt: at + POPULATION.warning + POPULATION.emission, particles: {} };
    const grain = plan.id + ':0';
    next.data.population.eruption.particles[grain] = { id: grain, x: plan.x, y: floor - 5, born: now - 60000, rise: 0, drift: 0, cx: 0, cy: 0, settled: true };
    next.data.population.predators['0'] = { id: '0', x: (plan.x + 10) % 1000, y: floor - 10, facing: 1, created: start, lastBite: now, cx: 0, cy: 0 };
    renderer.camera.x = plan.x; renderer.camera.y = floor - 10;
  }
  next.data.tick = next.data.population.at = now; next.attachArchives(archiveStore); world = next; geometryRepair = false;
  stopObserving(); renderer.worldChanged(next, null); update(); return { id, now, x: renderer.camera.x, y: renderer.camera.y };
};
window.observePopulationFish = id => inspect({ kind: 'fish', id });
window.coolPopulationFixture = () => { for (const c of Object.values(world.data.population.eruption.particles)) c.born = Date.now() - POPULATION.cooling; world.resolvePopulation(Date.now()); renderer.worldChanged(world, null); update(); };
`;
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  if (route === '/local/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: origin } : { ok: true, clients: [], hints: [] })); return; }
  const file = path.resolve(www, '.' + (route === '/' ? '/index.html' : route));
  if (!file.startsWith(www + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream');
  const source = fs.readFileSync(file); res.end(route === '/app.js' ? source.toString() + fixture : source);
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.TIDE_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.locator('#nickInput').fill('生态测试'); await page.locator('#welcomeForm .primary').click(); await page.waitForFunction(() => window.tide);
  const fish = await page.evaluate(() => installPopulationFixture('fish'));
  await page.locator('#myFish').click(); await page.waitForFunction(() => document.querySelector('#myFishList .fishHealth')?.textContent.includes('抑郁'), null, { timeout: 5000 });
  assert.match(await page.locator('#myFishList .fishHealth').textContent(), /乐/); await page.locator('#myFishList .fishCard').click();
  assert.equal(await page.locator('#fishHunger').textContent(), '抑郁'); assert.match(await page.locator('#objectFootnote').textContent(), /吃到「乐」字鱼食即可康复/);
  assert.match(await page.locator('#objectFootnote').textContent(), /每小时随机消散一块/); await page.locator('#closeInspector').click(); await page.locator('#feed').click(); assert.match(await page.locator('#foodForm').textContent(), /乐/); await page.locator('#foodGlyphInput').fill('乐'); await page.locator('#closeFood').click();
  await page.evaluate(() => installPopulationFixture('volcano')); await page.waitForFunction(() => !document.getElementById('ambientPeek').hidden);
  await page.locator('#ambientPeek').click(); assert.equal(await page.locator('#objectTitle').textContent(), '海底火山'); assert.match(await page.locator('#eventText').textContent(), /32/);
  await page.locator('#closeInspector').click(); await page.evaluate(() => coolPopulationFixture());
  assert.equal(await page.evaluate(() => Object.keys(tide.world.data.rocks).length), 1);
  for (const mode of [false, true]) {
    if (mode) await page.locator('#scene3dToggle').click();
    await page.waitForTimeout(300);
    const point = await page.evaluate(() => { const r = Object.values(tide.world.data.rocks)[0], view = tide.view, dx = ((r.x - view.camera.x + 500) % 1000 + 1000) % 1000 - 500, size = 18 * view.scale; return { x: 640 + (dx + .5) * size, y: 360 + (r.y - view.camera.y + .5) * size }; });
    await page.mouse.click(point.x, point.y); assert.equal(await page.locator('#objectTitle').textContent(), '冷却的火山岩'); await page.locator('#closeInspector').click();
  }
  assert.deepEqual(errors, []); console.log('浏览器生态提示、鱼卡、投食、火山定位、2D/3D岩石观察通过');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); server.close(); });
