const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium, firefox } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), exe = path.join(project, 'dist', '鱼来', '鱼来.exe');
const pause = ms => new Promise(r => setTimeout(r, ms));
const children = [], browsers = [], errors = [];
const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromeExecutable = [process.env.TIDE_CHROME_EXECUTABLE, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Users\\linmu\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'].find(file => file && fs.existsSync(file));
async function until(check, description, timeout = 20000) { const until = Date.now() + timeout; let last; while (Date.now() < until) { try { const value = await check(); if (value) return value; } catch(e) { last = e; } await pause(200); } throw new Error(description + (last ? ': ' + last.message : '')); }
async function helper(port) { const child = spawn(exe, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); await until(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, '启动器未就绪'); }
async function browser(type, executable) { const b = await type.launch({ headless: true, timeout: 30000, ...(executable ? { executablePath: executable } : {}), downloadsPath: path.join(project, 'test-output') }); browsers.push(b); return b; }
async function page(b, port, nick) { const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if(m.type() === 'error') errors.push(m.text()); }); await p.goto(`http://127.0.0.1:${port}`); await p.locator('#nickInput').fill(nick); await p.locator('#welcomeForm .primary').click(); await p.waitForFunction(() => window.tide); return p; }
async function createFish(p, glyphs, x, y) { await p.locator('#makeFish').click(); const rect = await p.locator('#gridCanvas').boundingBox(); for (let i = 0; i < glyphs.length; i++) { await p.locator('#glyphInput').fill(glyphs[i]); await p.mouse.click(rect.x + (7 + i + .5) * rect.width / 15, rect.y + 7.5 * rect.height / 15); } await p.locator('#placeDrawing').click(); await p.mouse.click(x, y); await until(async () => (await p.evaluate(() => window.tide.world.counts.fish)) >= 1, '鱼没有投放'); }
async function connect(p, port) { await p.locator('#connect').click(); await p.locator('#peerUrl').fill(`http://127.0.0.1:${port}`); await p.locator('#connectionForm .primary').click(); }
async function createScene(p) { await p.locator('#makeScene').click(); const g = await p.locator('#gridCanvas').boundingBox(); await p.locator('#glyphInput').fill('木'); for (const x of [10.5, 11.5]) await p.mouse.click(g.x + x * g.width / 20, g.y + 10.5 * g.height / 20); await p.locator('#placeDrawing').click(); await p.mouse.click(950, 580); await until(async () => (await p.evaluate(() => tide.world.counts.scene)) >= 1, '造景未投放'); }
async function feed(p, x) { await p.locator('#feed').click(); await p.locator('#placeFood').click(); await p.mouse.click(x, 243); await p.keyboard.press('Escape'); }
async function reopen(ctx, port) { const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); await p.goto(`http://127.0.0.1:${port}`); await p.waitForFunction(() => window.tide); return p; }
async function ageCheckpoint(ctx, port, hours, legacy = false) {
  // This page edits an isolated test profile without registering an online game node.
  const p = await ctx.newPage(); await p.goto(`http://127.0.0.1:${port}/welcome.html`);
  await p.evaluate(async ({ hours, legacy }) => {
    const { get, set } = await import('./storage.js'), checkpoint = await get('checkpoint');
    checkpoint.lastOnlineAt = Date.now() - hours * 3600000;
    if (legacy) { checkpoint.at = checkpoint.lastOnlineAt; delete checkpoint.lastOnlineAt; }
    await set('checkpoint', checkpoint);
  }, { hours, legacy });
  await p.close();
}
async function main() {
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true });
  await helper(39081); await helper(39082); await helper(39083);
  const chrome = await browser(chromium, chromeExecutable || edgeExecutable);
  const edge = await browser(chromium, edgeExecutable);
  const a = await page(chrome, 39081, '浏览器甲'), b = await page(edge, 39082, '浏览器乙');
  await createFish(a, ['鱼', '口', '>'], 600, 370); await createFish(b, ['o', '='], 800, 450);
  assert.equal(await a.evaluate(() => tide.balance()), 17); assert.equal(await b.evaluate(() => tide.balance()), 18);
  await createScene(a); await createScene(b);
  await connect(b, 39081);
  await until(async () => (await a.evaluate(() => tide.world.counts.fish)) === 2 && (await b.evaluate(() => tide.world.counts.fish)) === 2, '两个世界没有合并', 30000);
  assert.equal(await a.evaluate(() => tide.network.peers.length) >= 1, true);
  await b.locator('#chatInput').fill('你好，中文字符世界 <script>不会执行</script>'); await b.locator('#chatForm button').click();
  await until(async () => (await a.locator('#chatMessages').textContent()).includes('你好，中文字符世界'), '聊天未同步');
  assert.equal((await a.locator('#chatMessages').textContent()).includes('浏览器乙'), false, '未打码昵称暴露');
  await until(async () => (await b.evaluate(() => { const d = tide.world.data, cs = Object.values(d.chars).filter(c => c.kind === 'scene'); return cs.length === 4 && new Set(cs.map(c => `${d.scenes[c.entity].x + c.x},${d.scenes[c.entity].y + c.y}`)).size === 4; })), '合流造景重叠');
  const before = await a.evaluate(() => tide.balance()); await a.locator('#feed').click(); await a.locator('#foodGlyphInput').fill('粮'); await a.locator('#foodColorInput').fill('#ff9933'); await a.locator('#placeFood').click(); await a.mouse.click(710, 370); await pause(700); assert.equal(await a.evaluate(() => tide.balance()), before, '水下点击消耗了配额'); await a.mouse.click(710, 243); await a.keyboard.press('Escape');
  await until(async () => (await b.evaluate(() => Object.values(tide.world.data.chars).some(c => c.kind === 'food'))), '水面食物未同步');
  assert.equal(await b.evaluate(() => Object.values(tide.world.data.chars).some(c => c.kind === 'food' && c.ch === '粮' && c.color === '#ff9933')), true, '自定义鱼食字符或颜色未同步');
  const foodY = await b.evaluate(() => Object.values(tide.world.data.chars).find(c => c.kind === 'food').y); assert(foodY <= 2, '食物未从水面开始');
  const c = await page(chrome, 39083, '第三个同事'); await createFish(c, ['水', '。'], 1000, 400);
  await until(async () => (await a.evaluate(() => tide.network.leader)) === (await b.evaluate(() => tide.network.leader)), '协调者未统一');
  const leaderAB = await a.evaluate(() => tide.network.leader), nonLeaderPort = (await a.evaluate(() => tide.network.node)) === leaderAB ? 39082 : 39081;
  await connect(c, nonLeaderPort); await until(async () => (await c.evaluate(() => tide.world.counts.fish)) === 3 && (await a.evaluate(() => tide.world.counts.fish)) === 3 && (await b.evaluate(() => tide.world.counts.fish)) === 3, '第三节点的独立世界未通过非协调者合流', 30000);
  await until(async () => new Set(await a.evaluate(() => Object.keys(tide.world.data.roots))).size >= 3, '起源没有传播');
  await a.screenshot({ path: path.join(project, 'test-output', 'preview.png') });
  let entries = [{ p: a, port: 39081 }, { p: b, port: 39082 }, { p: c, port: 39083 }];
  await until(async () => new Set(await Promise.all(entries.map(e => e.p.evaluate(() => tide.network.leader)))).size === 1, '三节点协调者未统一');
  const leader = await b.evaluate(() => tide.network.leader); let departed;
  for (const e of entries) if (await e.p.evaluate(() => tide.network.node) === leader) departed = e;
  const context = departed.p.context(), actor = await departed.p.evaluate(() => tide.identity.actor), roots = await departed.p.evaluate(() => Object.keys(tide.world.data.roots));
  await departed.p.close(); entries = entries.filter(e => e !== departed);
  await until(async () => (await Promise.all(entries.map(e => e.p.evaluate(old => tide.network.leader !== old, leader)))).every(Boolean), '协调者离开后没有接替', 20000);
  const [survivor, other] = entries.map(e => e.p); await survivor.locator('#chatInput').fill('协调者离开，海仍继续'); await survivor.locator('#chatForm button').click(); await until(async () => (await other.locator('#chatMessages').textContent()).includes('海仍继续'), '协调者退出后聊天失效');
  const oldBalance = await other.evaluate(() => tide.balance()); await feed(other, 900);
  await until(async () => (await other.evaluate(() => tide.balance())) === oldBalance - 1, '协调者离开后操作未被确认', 15000);
  const zip = await fetch('http://127.0.0.1:39082/download.zip'); assert.equal(zip.status, 200); const bytes = Buffer.from(await zip.arrayBuffer()); assert.equal(bytes.readUInt32LE(0), 0x04034b50); fs.writeFileSync(path.join(project, 'test-output', 'download-test.zip'), bytes);
  await ageCheckpoint(context, departed.port, 240);
  const returned = await reopen(context, departed.port); entries.push({ p: returned, port: departed.port });
  await until(async () => (await returned.evaluate(() => tide.world.counts.fish)) === 3, '重开的协调者没有找回活跃世界', 30000);
  assert.equal(await returned.evaluate(() => tide.identity.actor), actor); const returnedRoots = await returned.evaluate(() => Object.keys(tide.world.data.roots)); assert(roots.every(r => returnedRoots.includes(r)), '旧起源未恢复');
  assert.equal((await returned.evaluate(() => Object.values(tide.histories))).filter(card => card.status !== 'corrected').length, 0, '仍活跃世界被错误展示为湮灭');
  assert.equal(errors.length, 0, '浏览器错误: ' + errors.join('\n'));
  let ff = process.env.TIDE_SKIP_FIREFOX ? 'skipped by test configuration' : 'not installed'; if(!process.env.TIDE_SKIP_FIREFOX && fs.existsSync(firefox.executablePath())) { const f = await browser(firefox); await helper(39084); const fp = await page(f, 39084, '火狐同事'); await createFish(fp, ['火', '口'], 800, 460); await connect(fp, entries[0].port); await until(async () => (await fp.evaluate(() => tide.world.counts.fish)) === 4 && (await returned.evaluate(() => tide.world.counts.fish)) === 4, 'Firefox 配对或中文创建失败', 30000); await fp.locator('#chatInput').fill('火狐接入中文海'); await fp.locator('#chatForm button').click(); await until(async () => (await returned.locator('#chatMessages').textContent()).includes('火狐接入中文海'), 'Firefox 聊天未同步'); ff = 'passed'; entries.push({ p: fp, port: 39084 }); }
  await pause(6000); const retained = await returned.evaluate(() => ({ roots: Object.keys(tide.world.data.roots), counts: tide.world.counts, balance: tide.balance() }));
  for (const e of entries) await e.p.close(); await pause(3000);
  const resumed = await reopen(context, departed.port); await pause(17000);
  assert.deepEqual(await resumed.evaluate(() => Object.keys(tide.world.data.roots)), retained.roots, '短期离线重开改变世界');
  assert.equal(await resumed.evaluate(() => tide.world.counts.fish), retained.counts.fish, '短期离线丢失旧鱼');
  assert.equal(await resumed.evaluate(() => tide.world.counts.scene), retained.counts.scene, '短期离线丢失造景');
  assert.equal(await resumed.evaluate(() => tide.balance()), retained.balance, '短期离线重发了额度');
  assert.equal(await resumed.evaluate(() => Object.values(tide.histories).filter(c => c.status !== 'corrected').length), 0, '短期离线误记湮灭');
  await resumed.close(); await pause(1000); await ageCheckpoint(context, departed.port, 239, true);
  const legacy = await reopen(context, departed.port); await pause(1000);
  assert.deepEqual(await legacy.evaluate(() => Object.keys(tide.world.data.roots)), retained.roots, '239小时旧版存档未恢复');
  assert.equal(await legacy.evaluate(() => tide.balance()), retained.balance);
  await legacy.close(); await pause(1000); await ageCheckpoint(context, departed.port, 240);
  const fresh = await reopen(context, departed.port); await pause(1000); assert.equal(await fresh.evaluate(() => tide.world.counts.fish), 0, '240小时后错误复活旧鱼'); assert.equal(await fresh.evaluate(() => tide.balance()), 20);
  const cards = await fresh.evaluate(() => Object.values(tide.histories).filter(c => c.status !== 'corrected')); assert(cards.some(card => roots.every(r => card.roots.includes(r))), '湮灭合影没有保留');
  assert(cards.some(card => Number.isFinite(card.endedAt)), '湮灭截止时间没有保存');
  await createFish(fresh, ['鱼', '口'], 800, 370);
  const beforeSleep = await fresh.evaluate(() => Object.keys(tide.world.data.roots));
  await fresh.evaluate(() => { const original = Date.now; Date.now = () => original() + 180000; }); await pause(1000);
  assert.deepEqual(await fresh.evaluate(() => Object.keys(tide.world.data.roots)), beforeSleep, '三分钟休眠误触湮灭');
  assert.equal(await fresh.evaluate(() => tide.balance()), 18);
  await fresh.evaluate(() => { const original = Date.now; Date.now = () => original() + 240 * 3600000; }); await pause(1000);
  assert.equal(await fresh.evaluate(() => tide.world.counts.fish), 0, '240小时休眠后旧鱼未湮灭');
  assert.equal(await fresh.evaluate(() => tide.balance()), 20);
  assert.equal(await fresh.evaluate(roots => Object.values(tide.histories).some(c => c.status !== 'corrected' && c.roots.every(r => roots.includes(r))), beforeSleep), true, '休眠过期合影未保存');
  assert.equal(errors.length, 0, '浏览器错误: ' + errors.join('\n'));
  const result = { chrome: chromeExecutable ? 'passed' : 'not installed (used isolated Edge instance)', edge: 'passed', firefox: ff, checks: ['Chinese creation and billing', 'automatic WebRTC pairing', 'independent-world merge through non-coordinator', 'masked XSS-safe chat', 'scenery collision repair', 'surface-only food sync', 'actual coordinator failover', 'expired checkpoint correction from live world', 'short offline preserves world and wallet', '239-hour legacy checkpoint migration', '240-hour extinction and retained monument', 'short sleep preserves world', '240-hour sleep extinction', 'portable ZIP'], errors };
  fs.writeFileSync(path.join(project, 'test-output', 'browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => { for (const b of browsers) await b.close().catch(() => {}); for (const c of children) c.kill(); });
