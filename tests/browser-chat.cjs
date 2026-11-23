const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), clients = new Map(), errors = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, origin;
// A local signaling fixture; real browser WebRTC channels carry all signed game data.
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost'), route = url.pathname;
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (route === '/local/meta') { json({ token: 'test', url: origin }); return; }
  if (route === '/local/events') {
    const client = clients.get(url.searchParams.get('node')); if (!client) { response.writeHead(404); response.end(); return; }
    client.active = true; client.response = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n');
    for (const signal of client.queue) response.write(`data: ${JSON.stringify(signal)}\n\n`); client.queue = [];
    response.on('close', () => { client.active = false; }); return;
  }
  if (route.startsWith('/local/')) {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : {};
    if (route === '/local/register') clients.set(body.node, { id: body.node, nick: body.nick, peers: 0, active: false, queue: [] });
    if (route === '/local/unregister') { const client = clients.get(body.node); if (client) client.active = false; }
    if (route === '/local/presence') { const client = clients.get(body.node); if (client) client.peers = body.peers; }
    if (route === '/local/probe') { json({ ok: true, clients: [...clients.values()].filter(client => client.active).map(({ id, nick, peers }) => ({ id, nick, peers, url: origin })), hints: [] }); return; }
    if (route === '/local/relay') { const signal = { ...body.signal, fromUrl: origin }, target = clients.get(signal.to); if (!target?.active) { json({ ok: false, error: 'test peer offline' }); return; } if (target.response) target.response.write(`data: ${JSON.stringify(signal)}\n\n`); else target.queue.push(signal); }
    json({ ok: true }); return;
  }
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file));
});
async function open(context, nick) { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); } await page.waitForFunction(() => window.tide); return page; }
async function send(page, text) { await page.locator('#chatInput').fill(text); await page.locator('#chatForm button').click(); await page.waitForFunction(text => Object.values(tide.world.data.chats).some(message => message.body.text === text), text); }
async function connect(page) { await page.locator('#connect').click(); await page.locator('#peerUrl').fill(origin); await page.locator('#connectionForm .primary').click(); await page.waitForFunction(() => tide.network.peers.length > 0); }
async function control(context, action) { const page = await context.newPage(); await page.goto(origin + '/welcome.html'); const result = await page.evaluate(action); await page.close(); return result; }
async function expire(context) { await control(context, async () => { const { get, set } = await import('./storage.js'), checkpoint = await get('checkpoint'); checkpoint.lastOnlineAt = Date.now() - 240 * 3600000; await set('checkpoint', checkpoint); }); }
async function count(page) { return page.evaluate(() => Object.keys(tide.world.data.chats).length); }
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, timeout: 30000 });
  const aContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), bContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let a = await open(aContext, '聊天甲'), b;
  await a.locator('#makeFish').click(); const grid = await a.locator('#gridCanvas').boundingBox();
  for (const column of [7.5, 8.5]) await a.mouse.click(grid.x + column * grid.width / 15, grid.y + 7.5 * grid.height / 15);
  await a.locator('#placeDrawing').click(); await a.mouse.click(600, 370); await a.waitForFunction(() => tide.world.counts.fish === 1);
  const fishId = await a.evaluate(() => Object.keys(tide.world.data.fishes)[0]);
  const first = '海底🐟 é 👨‍👩‍👧‍👦 <script>window.chatExecuted=1</script>';
  await send(a, first); assert.equal(await a.evaluate(() => window.chatExecuted), undefined);
  await a.close(); await pause(300);
  await control(aContext, async () => {
    const { get, set, signer } = await import('./storage.js'), { Network } = await import('./network.js');
    const identity = await get('identity'), checkpoint = await get('checkpoint'), network = new Network(identity, {}, () => {}, () => {}); network.sign = await signer(identity);
    for (let index = 0; index < 205; index++) { const message = await network.makeEnvelope('chat', { nick: '聊＊甲', text: `历史${String(index).padStart(3, '0')}`, t: Date.now() + index, roots: [Object.keys(checkpoint.world.roots).sort()[0]] }); checkpoint.world.chats[message.id] = message; }
    const fish = Object.keys(checkpoint.world.fishes)[0], day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); checkpoint.world.travel[fish].days[day] = 12.5;
    checkpoint.lastOnlineAt = Date.now(); await set('checkpoint', checkpoint);
  });
  a = await open(aContext); assert.equal(await count(a), 206);
  assert.equal((await a.locator('#chatMessages').textContent()).includes(first), false);
  await a.locator('#loadEarlierChat').click(); await a.locator('#loadEarlierChat').click(); assert((await a.locator('#chatMessages').textContent()).includes(first)); assert.equal(await a.locator('#chatMessages script').count(), 0);
  b = await open(bContext, '聊天乙'); await connect(b); await b.waitForFunction(() => Object.keys(tide.world.data.chats).length === 206);
  await b.waitForFunction(id => Object.values(tide.world.data.travel[id]?.days || {}).some(distance => distance >= 12.5), fishId);
  await b.locator('#myFish').click(); assert.equal(await b.locator('#myFishList [data-fish]').count(), 0, '联机后混入其他人的鱼'); await b.locator('#closeMyFish').click();
  await send(b, '新同事的聊天也会保存'); await a.waitForFunction(() => Object.keys(tide.world.data.chats).length === 207);
  const leader = await a.evaluate(() => tide.network.leader), aLeads = await a.evaluate(leader => tide.network.node === leader, leader), survivor = aLeads ? b : a, beforeFailover = await survivor.evaluate(id => Math.max(...Object.values(tide.world.data.travel[id].days)), fishId);
  await (aLeads ? a : b).close(); await survivor.waitForFunction(leader => tide.network.leader !== leader, leader, { timeout: 20000 });
  assert.equal(await survivor.evaluate(({ id, before }) => Math.max(...Object.values(tide.world.data.travel[id].days)) >= before, { id: fishId, before: beforeFailover }), true, '协调者退出丢失运动量');
  if (aLeads) { a = await open(aContext); await connect(a); } else { b = await open(bContext); await connect(b); }
  await a.close(); await pause(300); a = await open(aContext); assert.equal(await count(a), 207); await connect(a); await a.waitForFunction(() => Object.keys(tide.world.data.chats).length === 207);
  await a.close(); await pause(300); await expire(aContext); a = await open(aContext);
  assert.equal(await a.evaluate(() => Object.keys(tide.world.data.chatSources).length), 207);
  await connect(a); await a.waitForFunction(() => Object.keys(tide.world.data.chats).length === 207 && Object.keys(tide.world.data.chatSources).length === 0 && !Object.values(tide.world.data.chars).some(cell => cell.chat) && Object.values(tide.histories).every(card => card.status === 'corrected'));
  assert.equal(await a.evaluate(() => Object.values(tide.histories).filter(card => card.status !== 'corrected').length), 0);
  await pause(800); await a.close(); await b.close(); await pause(400); await expire(aContext); await expire(bContext);
  a = await open(aContext); b = await open(bContext);
  const expected = await a.evaluate(async () => { const { chatGlyphs } = await import('./chat.js'); return Object.values(tide.world.data.chatSources).reduce((sum, message) => sum + chatGlyphs(message.body.text).length, 0); });
  assert.equal(await count(a), 0); assert.equal(await a.evaluate(() => Object.values(tide.world.data.chars).filter(cell => cell.chat).length), expected);
  const cards = await a.evaluate(() => Object.values(tide.histories).filter(card => card.status !== 'corrected')); assert(cards.some(card => Object.keys(card.chats || {}).length === 207));
  await connect(b); await a.waitForFunction(expected => Object.values(tide.world.data.chars).filter(cell => cell.chat).length === expected && tide.network.peers.length > 0, expected);
  assert.equal(await b.evaluate(() => Object.values(tide.world.data.chars).filter(cell => cell.chat).length), expected); assert.equal(await a.evaluate(() => tide.balance()), 20); assert.equal(await b.evaluate(() => tide.balance()), 20);
  await a.locator('#seabed').click(); await a.screenshot({ path: path.join(project, 'test-output', 'chat-seabed.png') });
  await a.mouse.click(711, 675); await a.locator('#historyCards details summary').first().click();
  await a.waitForFunction(() => document.querySelector('.archivedChat')?.textContent.includes('海底🐟'));
  assert.equal(await a.locator('.archivedChat script').count(), 0); await a.locator('#closeHistory').click();
  const point = await a.evaluate(() => { const cell = Object.values(tide.world.data.chars).find(cell => cell.chat && Math.abs(cell.x - 614) < 30 && !(cell.x >= 610 && cell.x < 618 && cell.y >= 115)); return { x: 720 + (cell.x - 614 + .5) * 18, y: 450 + (cell.y - 105 + .5) * 18 }; });
  await a.mouse.click(point.x, point.y); assert.equal(await a.locator('#sceneActions').isVisible(), false); assert((await a.locator('#objectFootnote').textContent()).includes('不能编辑'));
  await a.close(); await b.close(); await pause(300); a = await open(aContext); assert.equal(await a.evaluate(() => Object.values(tide.world.data.chars).filter(cell => cell.chat).length), expected);
  await a.locator('#connect').click(); const downloadPromise = a.waitForEvent('download'); await a.locator('#backup').click(); const download = await downloadPromise, backupBytes = fs.readFileSync(await download.path());
  assert.equal(Object.keys(JSON.parse(backupBytes).checkpoint.world.chatSources).length, 207);
  const restoredContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), restored = await open(restoredContext, '备份恢复测试');
  await restored.locator('#connect').click(); await restored.locator('#importBackup').setInputFiles({ name: 'memory.json', mimeType: 'application/json', buffer: backupBytes });
  await restored.waitForFunction(() => window.tide && Object.keys(tide.world.data.chatSources).length === 207);
  assert.equal(await restored.evaluate(() => Object.values(tide.world.data.chars).filter(cell => cell.chat).length), expected); await restoredContext.close();
  assert.deepEqual(errors, []);
  const result = { edge: 'passed', version: browser.version(), transport: 'real WebRTC with Node signaling fixture; no Windows launcher execution', messages: 207, sedimentCharacters: expected, checks: ['signed chat saved and restored', 'more than 200 messages retained with older-history access', 'chat HTML displayed as text', 'late join and WebRTC chat history merge', 'fish movement statistics sync over WebRTC', 'my fish excludes other creators after merge', 'actual coordinator failover preserves movement', 'reopen retains received chat', 'false extinction removes sediment and restores live chat', 'true extinction archives text and creates fixed seabed', 'independent next worlds merge without duplicate sediment', 'sediment persists on reopen without quota cost', 'fixed floor has no edit controls', 'archived chat readable at monument', 'backup includes chat sources and restores fixed terrain'], errors };
  fs.writeFileSync(path.join(project, 'test-output', 'browser-chat-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.closeAllConnections(); server.close(); });
