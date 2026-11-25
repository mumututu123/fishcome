const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), ports = [39331, 39332], children = [], errors = []; let browser;
const concurrent = process.argv.includes('--concurrent-births');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await pause(150); } throw new Error(message); }
async function open(context, port, nick) {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${port}`);
  if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); }
  await page.waitForFunction(() => window.tide); return page;
}
async function main() {
  for (const port of ports) { const child = spawn(process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'), ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, '启动器未就绪'); }
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const first = await browser.newContext({ viewport: { width: 1440, height: 900 } }), second = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(first, ports[0], '父鱼作者'), b = await open(second, ports[1], '母鱼作者'); await a.close(); await b.close();
  const setupB = await second.newPage(); await setupB.goto(`http://127.0.0.1:${ports[1]}/welcome.html`); const motherIdentity = await setupB.evaluate(async () => (await import('./storage.js')).get('identity')); await setupB.close();
  const setup = await first.newPage(); await setup.goto(`http://127.0.0.1:${ports[0]}/welcome.html`);
  const fixture = await setup.evaluate(async ({ motherIdentity, concurrent }) => {
    const { World, maskNick } = await import('./engine.js'), { BREEDING_TIME, updateContacts, finishBreeding } = await import('./breeding.js'), { HOUR } = await import('./seaweed.js'), { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), checkpoint = await get('checkpoint'), now = Date.now(), start = now - BREEDING_TIME + (concurrent ? -10000 : 20000), created = start - 10000, world = new World(created, Object.keys(checkpoint.world.roots)[0]);
    const senders = [identity, motherIdentity].map(id => new Network(id, {}, () => {}, () => {})); for (let index = 0; index < 2; index++) senders[index].sign = await signer(index ? motherIdentity : identity);
    async function apply(index, body) { const author = index ? motherIdentity : identity, op = { id: crypto.randomUUID(), actor: author.actor, nick: maskNick(author.nick), roots: [world.id], t: created, ...body }, proof = await senders[index].makeEnvelope('op', op); const result = world.apply({ ...op, proof }); if (!result.ok) throw new Error(result.error); return op.id; }
    const male = await apply(0, { kind: 'fish', name: '蓝爸', gender: 'male', x: 390, y: 20, cells: [0, 1, 2].map(x => ({ x, y: 0, ch: 'Q', color: '#79b8ff' })), cost: 3 });
    const female = await apply(1, { kind: 'fish', name: '粉妈', gender: 'female', x: 393, y: 20, cells: [0, 1, 2].map(x => ({ x, y: 0, ch: 'Q', color: '#ff9fc8' })), cost: 3 });
    await apply(0, { kind: 'scene', x: 389, y: 19, cells: [...Array.from({ length: 8 }, (_, x) => ({ x, y: 0, ch: '#', color: '#678999' })), { x: 0, y: 1, ch: '#', color: '#678999' }], cost: 9 });
    await apply(1, { kind: 'scene', x: 389, y: 19, cells: [...Array.from({ length: 8 }, (_, x) => ({ x, y: 2, ch: '#', color: '#678999' })), { x: 7, y: 1, ch: '#', color: '#678999' }], cost: 9 });
    for (let elapsed = 0; elapsed <= 5000; elapsed += 500) updateContacts(world, start + elapsed, world.fishGroups(), world.sceneryMap());
    const record = Object.values(world.data.breeding)[0]; if (!record) throw new Error('未进入繁殖'); world.data.tick = now; world.data.seaweedHour = Math.floor(now / HOUR);
    if (concurrent) {
      const active = world.serialize();
      const complete = birth => {
        const replica = new World(now, undefined, { populate: false });
        replica.data = structuredClone(active);
        finishBreeding(replica, birth, (cell, next, event) => {
          Object.assign(cell, next);
          cell.path.push({ ...event, target: next.entity, x: next.x, y: next.y });
        });
        return replica.serialize();
      };
      const early = complete(record.ends), late = complete(record.ends + 500);
      const id = early.breeding[record.id].baby.id;
      checkpoint.world = early; checkpoint.lastOnlineAt = now;
      await set('checkpoint', checkpoint);
      return { id, early: record.ends, late: record.ends + 500, breeding: record.id, second: late };
    }
    checkpoint.world = world.serialize(); checkpoint.lastOnlineAt = now; await set('checkpoint', checkpoint); return { male, female, breeding: record.id, fatherActor: identity.actor, motherActor: motherIdentity.actor };
  }, { motherIdentity, concurrent }); await setup.close();
  if (concurrent) {
    const seed = await second.newPage();
    await seed.goto(`http://127.0.0.1:${ports[1]}/welcome.html`);
    await seed.evaluate(async data => {
      const { get, set } = await import('./storage.js');
      const checkpoint = await get('checkpoint');
      await set('checkpoint', { ...checkpoint, world: data, lastOnlineAt: Date.now() });
    }, fixture.second);
    await seed.close();
  }
  a = await open(first, ports[0]); b = await open(second, ports[1]);
  if (concurrent) {
    const birthTime = (page, id) => page.evaluate(id => tide.world.data.fishes[id]?.created, id);
    assert.equal(await birthTime(a, fixture.id), fixture.early);
    assert.equal(await birthTime(b, fixture.id), fixture.late);
  }
  await b.locator('#connect').click(); await b.locator('#peerUrl').fill(`http://127.0.0.1:${ports[0]}`); await b.locator('#connectionForm .primary').click();
  if (concurrent) {
    const consistent = ({ id, early, breeding }) => {
      const data = tide.world.data;
      return data.fishes[id]?.created === early && data.breeding[breeding]?.baby.created === early &&
        Object.values(data.chars).some(cell => cell.entity === id && cell.path.some(event => event.birth === breeding && event.t === early));
    };
    for (const page of [a, b]) await page.waitForFunction(consistent, fixture);
    await a.reload(); await a.waitForFunction(consistent, fixture);
    await a.close(); await b.close();
    const damage = await first.newPage();
    await damage.goto(`http://127.0.0.1:${ports[0]}/welcome.html`);
    await damage.evaluate(async ({ id, late, breeding }) => {
      const { get, set } = await import('./storage.js');
      const checkpoint = await get('checkpoint');
      checkpoint.world.fishes[id].created = late;
      for (const cell of Object.values(checkpoint.world.chars)) {
        for (const event of cell.path) if (event.birth === breeding) event.t = late;
      }
      await set('known', []);
      await set('checkpoint', checkpoint);
    }, fixture);
    await damage.close();
    a = await open(first, ports[0]);
    await a.waitForFunction(consistent, fixture);
    await a.reload(); await a.waitForFunction(consistent, fixture);
    assert.deepEqual(errors, []);
    console.log('Concurrent births: real peer merge, save/reload, and legacy checkpoint recovery passed');
    return;
  }
  await b.waitForFunction(id => tide.world.data.breeding[id]?.status === 'active', fixture.breeding);
  for (const page of [a, b]) { await page.locator('#myFish').click(); assert((await page.locator('#myFishList').textContent()).includes('繁殖中')); }
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true }); await a.screenshot({ path: path.join(project, 'test-output', 'breeding-active.png') });
  await a.locator(`[data-fish="${fixture.male}"]`).click(); assert((await a.locator('#objectInfo').textContent()).includes('合体游速')); assert(await a.locator('#fishBreeding').isVisible());
  for (const page of [a, b]) await page.waitForFunction(id => tide.world.data.breeding[id]?.status === 'born', fixture.breeding, { timeout: 40000 });
  const born = await a.evaluate(id => { const data = tide.world.data, record = data.breeding[id], baby = data.fishes[record.baby.id], cells = Object.values(data.chars).filter(c => c.kind === 'fish'); return { baby, record, counts: cells.reduce((counts, c) => { counts[c.entity] = (counts[c.entity] || 0) + 1; return counts; }, {}), eyes: cells.filter(c => c.entity === baby.id && ['0', 'O', 'o', '。', '.', '口'].includes(c.ch)).length }; }, fixture.breeding);
  assert.equal(born.eyes, 1); assert.equal(born.counts[fixture.male], 2); assert.equal(born.counts[fixture.female], 2); assert.equal(born.counts[born.baby.id], 2);
  const owner = born.baby.actor === fixture.fatherActor ? a : b, other = owner === a ? b : a;
  await a.locator('#closeInspector').click(); await a.locator('#myFish').click();
  assert.equal(await owner.locator(`[data-fish="${born.baby.id}"]`).count(), 1); assert.equal(await other.locator(`[data-fish="${born.baby.id}"]`).count(), 0);
  const card = owner.locator(`[data-fish="${born.baby.id}"]`); assert((await card.textContent()).includes('自然出生于')); assert.equal(await card.locator('.fishGender').textContent(), born.baby.gender === 'male' ? '♂ 公' : '♀ 母');
  for (const page of [a, b]) { await page.locator('#pedigreeTab').click(); assert.equal(await page.locator('[data-lineage-fish]').count(), 3); assert((await page.locator('#pedigreeTree').textContent()).includes('蓝爸')); assert((await page.locator('#pedigreeTree').textContent()).includes('粉妈')); assert(await page.locator('.pedigreeFish:not(.mine)').count() > 0); await page.locator('#myFishListTab').click(); }
  await owner.screenshot({ path: path.join(project, 'test-output', 'breeding-born.png') }); await card.click(); assert((await owner.locator('#fishParentage').textContent()).includes('父鱼')); assert(await owner.locator('#fishBreeding').isHidden());
  await owner.reload(); await owner.waitForFunction(() => window.tide); await owner.waitForFunction(id => Object.values(tide.world.data.fishes).some(f => f.id === id), born.baby.id); await owner.locator('#myFish').click(); assert.equal(await owner.locator(`[data-fish="${born.baby.id}"]`).count(), 1);
  assert.deepEqual(errors, []); console.log('繁殖倒计时、合体游速、WebRTC孕期/出生同步、小鱼补眼及归属、性别、刷新恢复通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
