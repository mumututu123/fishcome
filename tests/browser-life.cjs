const { spawn } = require('node:child_process');
const { launcherPath } = require('./release-fixtures.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'test-output'), children = [], errors = [];
const exe = launcherPath;
let browser;
async function helper(port) {
  const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child);
  const until = Date.now() + 20000; while (Date.now() < until) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('启动器没有启动');
}
async function open(context, port, nick) {
  const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(`http://127.0.0.1:${port}/`);
  if (nick) { await p.locator('#nickInput').fill(nick); await p.locator('#welcomeForm .primary').click(); }
  await p.waitForFunction(() => window.tide); return p;
}
async function main() {
  fs.mkdirSync(output, { recursive: true }); for (const port of [39821, 39822]) await helper(port);
  browser = await chromium.launch({ headless: true });
  const ca = await browser.newContext({ viewport: { width: 1440, height: 900 } }), cb = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(ca, 39821, '摸鱼甲'), b = await open(cb, 39822, '摸鱼乙');
  const other = await b.evaluate(async () => (await import('./storage.js')).get('identity')); await a.close(); await b.close();
  const otherSetup = await cb.newPage(); await otherSetup.goto('http://127.0.0.1:39822/welcome.html');
  await otherSetup.evaluate(async other => { other.registration.joined = true; await (await import('./storage.js')).set('identity', other); }, other);
  await otherSetup.close(); b = await open(cb, 39822);
  const setup = await ca.newPage(); await setup.goto('http://127.0.0.1:39821/welcome.html');
  const fixture = await setup.evaluate(async other => {
    const { World } = await import('./engine.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js'), { updateLife, lifeContext, weatherAt, LIFE } = await import('./life.js');
    const me = await get('identity'), now = Date.now(), start = now - 70000, w = new World(start - 3600000, undefined, { populate: false });
    const senders = new Map(); for (const identity of [me, other]) { const n = new Network(identity, {}, () => {}, () => {}); n.sign = await signer(identity); senders.set(identity.actor, n); }
    async function apply(identity, body) { const op = { id: crypto.randomUUID(), actor: identity.actor, nick: identity.nick, roots: w.roots, t: start, ...body }, proof = await senders.get(identity.actor).makeEnvelope('op', op); const result = w.apply({ ...op, proof }); if (!result.ok) throw new Error(result.error); return op.id; }
    const cells = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: '鱼', color: '#88aacc' }];
    const ids = [await apply(me, { kind: 'fish', x: 369, y: 23, name: '阿甲', cells, cost: 2, gender: 'male' }), await apply(other, { kind: 'fish', x: 375, y: 23, name: '阿乙', cells, cost: 2, gender: 'male' }), await apply(me, { kind: 'fish', x: 381, y: 23, name: '阿丙', cells, cost: 2, gender: 'male' })];
    await apply(me, { kind: 'scene', x: 373, y: 28, cells: [{ x: 0, y: 0, ch: '诗', color: '#b1dba5' }, { x: 1, y: 0, ch: '亭', color: '#b1dba5' }], cost: 2 });
    for (let second = 1; second <= 46; second++) updateLife(w, start + second * 1000, lifeContext(w, start + second * 1000, w.sceneryMap(), w.fishGroups()));
    let bloom = Math.floor((start - LIFE.weatherDuration) / LIFE.weatherPeriod) * LIFE.weatherPeriod; while (weatherAt(w.data, bloom).type !== 'plankton') bloom -= LIFE.weatherPeriod;
    const { spawnPlankton } = await import('./life.js'); spawnPlankton(w, bloom);
    const planktonIds = Object.values(w.data.chars).filter(c => c.plankton).map(c => c.id);
    for (const id of planktonIds) { const c = w.data.chars[id]; c.kind = 'burn'; c.path.push({ id: `dissolve:${id}`, reason: 'dissolve', t: bloom + LIFE.planktonLife, target: '', x: c.x, y: c.y }); }
    w.data.tick = now; me.lifeSeenAt = start - 1000; me.registration.joined = true;
    await set('identity', me); await set('known', []); await set('checkpoint', { world: w.serialize(), lastOnlineAt: now });
    return { ids, roots: w.roots, storyIds: Object.keys(w.data.life.stories), planktonIds, balance: w.wallet(me.actor) };
  }, other); await setup.close(); a = await open(ca, 39821);
  await a.waitForFunction(() => !document.getElementById('lifeNote').hidden);
  assert.match(await a.locator('#lifeHeading').textContent(), /你不在的时候/); assert.match(await a.locator('#lifeText').textContent(), /熟鱼/);
  await a.screenshot({ path: path.join(output, 'life-return-desktop.png') });
  await a.locator('#lifePeek').click(); await a.locator('#lifeDialog').waitFor({ state: 'visible' }); assert((await a.locator('.lifeStory').count()) >= 4);
  await a.screenshot({ path: path.join(output, 'life-stories-desktop.png') }); await a.locator('#closeLife').click();
  await a.locator('#myFish').click(); await a.locator(`.fishCard[data-fish="${fixture.ids[0]}"]`).click();
  assert.match(await a.locator('#fishHabit').textContent(), /喜欢/); assert.match(await a.locator('#fishCompany').textContent(), /熟鱼|同游/);
  await a.screenshot({ path: path.join(output, 'life-observation-desktop.png') }); await a.locator('#closeInspector').click();
  await b.locator('#connect').click(); await b.locator('#peerUrl').fill('http://127.0.0.1:39821'); await b.locator('#connectionForm .primary').click();
  await b.waitForFunction(ids => ids.every(id => tide.world.data.fishes[id]), fixture.ids);
  await b.waitForFunction(ids => ids.every(id => tide.world.data.life.stories[id]), fixture.storyIds);
  await b.waitForFunction(ids => ids.every(id => tide.world.data.chars[id]?.kind === 'burn'), fixture.planktonIds);
  for (const p of [a, b]) assert.equal(await p.evaluate(() => tide.network.peers.length), 1);
  assert.equal(await a.evaluate(() => tide.balance()), fixture.balance);
  await a.locator('#makeFish').click(); await a.locator('#gridCellInput').focus(); await a.keyboard.insertText('鱼'); await a.keyboard.press('ArrowRight'); await a.keyboard.insertText('o');
  await a.locator('#fishNameInput').fill('新邻'); await a.locator('#placeDrawing').click();
  const point = await a.evaluate(() => {
    const data = tide.world.data, view = tide.view, size = 18 * view.scale, occupied = [];
    for (const c of Object.values(data.chars)) { if (c.kind === 'burn') continue; const entity = c.kind === 'fish' ? data.fishes[c.entity] : c.kind === 'scene' ? data.scenes[c.entity] : null; occupied.push({ x: entity ? entity.x + (c.kind === 'fish' ? entity.facing : 1) * c.x : c.x, y: entity ? entity.y + c.y : c.y }); }
    for (let sy = 260; sy < 520; sy += 36) for (let sx = 450; sx < 900; sx += 36) { const x = Math.floor(view.camera.x + (sx - innerWidth / 2) / size), y = Math.floor(view.camera.y + (sy - innerHeight / 2) / size); if (y > 4 && y < 70 && occupied.every(c => Math.abs(c.x - x) > 8 || Math.abs(c.y - y) > 8)) return { x: sx, y: sy }; }
    throw new Error('没有空水域');
  });
  await a.mouse.click(point.x, point.y); await a.waitForFunction(() => Object.values(tide.world.data.fishes).some(f => f.name === '新邻'));
  const newFish = await a.evaluate(() => Object.values(tide.world.data.fishes).find(f => f.name === '新邻').id); fixture.balance -= 2; fixture.ids.push(newFish); fixture.storyIds.push(`arrive:${newFish}`);
  await b.waitForFunction(id => !!tide.world.data.life.stories[`arrive:${id}`], newFish);
  // Renderer-only weather checks avoid advancing the running simulation clock.
  for (const type of ['current', 'light', 'plankton']) {
    const png = await a.evaluate(async type => {
    const { Renderer } = await import('./renderer.js'), { World } = await import('./engine.js'), { weatherAt, LIFE, spawnPlankton } = await import('./life.js');
    const w = new World(Date.now() - 3600000, undefined, { populate: false }); let now = Math.ceil(Date.now() / LIFE.weatherPeriod) * LIFE.weatherPeriod;
    while (weatherAt(w.data, now).type !== type) now += LIFE.weatherPeriod;
    const saved = Date.now; try { Date.now = () => now + 1000; w.data.tick = Date.now(); spawnPlankton(w, Date.now()); const canvas = document.createElement('canvas'), r = new Renderer(canvas); r.draw(w); if (type === 'plankton' && !Object.values(w.data.chars).some(c => c.plankton)) throw new Error('浮游食物没有生成'); return canvas.toDataURL('image/png').split(',')[1]; } finally { Date.now = saved; }
  }, type);
    fs.writeFileSync(path.join(output, `life-weather-${type}.png`), Buffer.from(png, 'base64'));
  }
  await a.locator('#myFish').click(); await a.locator('#myFishStories').click(); await a.locator('#lifeDialog').waitFor({ state: 'visible' }); await a.locator('#closeLife').click();
  await a.setViewportSize({ width: 390, height: 844 }); await a.locator('#myFish').click(); await a.locator(`.fishCard[data-fish="${fixture.ids[0]}"]`).click();
  await a.screenshot({ path: path.join(output, 'life-observation-mobile.png') }); const bounds = await a.locator('#inspector').boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 390); await a.locator('#closeInspector').click();
  await a.locator('#myFish').click(); await a.locator('#myFishStories').click(); await a.screenshot({ path: path.join(output, 'life-stories-mobile.png') });
  await a.locator('#closeLife').click(); await a.close();
  await b.waitForFunction(() => tide.network.leader === tide.network.node, null, { timeout: 30000 });
  assert(await b.evaluate(ids => ids.every(id => !!tide.world.data.life.stories[id]), fixture.storyIds));
  a = await open(ca, 39821); await a.waitForFunction(ids => ids.every(id => tide.world.data.fishes[id]), fixture.ids);
  assert.equal(await a.evaluate(() => tide.balance()), fixture.balance); assert(errors.length === 0, errors.join('\n'));
  fs.writeFileSync(path.join(output, 'life-browser-results.json'), JSON.stringify({ passed: true, checks: ['回来消息', '鱼生展开与定位', '性格与熟鱼观察', 'WebRTC完整与增量同步', '三种天气绘制', '手机布局', '协调者接替', '刷新恢复', '鱼元保持'], errors }, null, 2));
  console.log('Ambient life browser checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
