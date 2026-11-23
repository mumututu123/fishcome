const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { inflateRawSync } = require('node:zlib');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), children = [], errors = []; let browser;
const exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe'), output = path.join(project, 'test-output');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { const deadline = Date.now() + 20000; while (Date.now() < deadline) { try { if (await check()) return; } catch {} await pause(150); } throw new Error(message); }
async function helper(port, file = exe) { const child = spawn(file, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child); await until(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, '启动器未就绪'); }
async function open(context, port, nick, suffix = '') { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${port}${suffix}`); if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); } await page.waitForFunction(() => window.tide); return page; }
function zipEntry(bytes, name) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert(end >= 0); let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50); const size = bytes.readUInt32LE(offset + 20), filenameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), method = bytes.readUInt16LE(offset + 10), local = bytes.readUInt32LE(offset + 42), filename = bytes.subarray(offset + 46, offset + 46 + filenameLength).toString('utf8');
    if (filename === name) { const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), compressed = bytes.subarray(start, start + size); return method === 8 ? inflateRawSync(compressed) : compressed; }
    offset += 46 + filenameLength + extra + comment;
  }
  throw new Error('发行包缺少 ' + name);
}
async function main() {
  const { encodeInvite, decodeInvite } = await import(pathToFileURL(path.join(project, 'www', 'invite.js')).href);
  await helper(39341); await helper(39342); const urlA = 'http://127.0.0.1:39341', urlB = 'http://127.0.0.1:39342';
  const metaA = await (await fetch(urlA + '/local/meta')).json(); assert.equal(await decodeInvite(metaA.url), urlA); assert(!JSON.stringify(metaA).includes('http://')); assert(metaA.urls.every(code => code.startsWith('YL1.')));
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const first = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }), second = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await open(first, 39341, '邀请甲'); let b = await open(second, 39342, '邀请乙');
  await a.locator('#connect').click(); const codeA = await a.locator('#myUrl').inputValue(); assert.equal(codeA, metaA.url); assert.equal(await decodeInvite(codeA), urlA);
  assert(!(await a.locator('#connectionDialog').textContent()).includes('发布地址')); await a.locator('#copyUrl').click(); assert.equal(await a.evaluate(() => navigator.clipboard.readText()), codeA);
  fs.mkdirSync(output, { recursive: true }); await a.screenshot({ path: path.join(output, 'invitation-dialog.png') }); await a.locator('#closeConnection').click();
  await b.locator('#connect').click(); await b.locator('#peerUrl').fill('YL1.invalid.invalid'); await b.locator('#connectionForm .primary').click(); await b.waitForFunction(() => document.getElementById('toast').textContent.includes('邀请码')); assert.equal(await b.evaluate(() => tide.network.peers.length), 0);
  await b.locator('#peerUrl').fill(codeA); await b.locator('#connectionForm .primary').click();
  for (const page of [a, b]) await page.waitForFunction(() => tide.network.peers.length === 1 && Object.keys(tide.world.data.roots).length === 2);
  const peers = await b.evaluate(() => tide.network.peers); assert(peers.every(peer => peer.url.startsWith('YL1.')));
  const known = await b.evaluate(async () => (await import('./storage.js')).get('known')); assert(known.every(code => code.startsWith('YL1.')));
  await until(async () => { const status = await (await fetch(urlA + '/status')).json(); return status.hints.length > 0; }, '邻居邀请码未传播');
  const status = await (await fetch(urlA + '/status')).json(); assert(status.clients.every(client => client.url.startsWith('YL1.'))); assert(status.hints.every(hint => hint.url.startsWith('YL1.'))); assert(!JSON.stringify(status).includes('http://'));
  const welcome = await first.newPage(); await welcome.goto(urlA + '/welcome.html'); await welcome.waitForFunction(() => document.getElementById('address').value.startsWith('YL1.')); assert.equal(await welcome.locator('#address').inputValue(), codeA); await welcome.screenshot({ path: path.join(output, 'invitation-welcome.png') }); await welcome.close();
  const bytes = Buffer.from(await (await fetch(urlA + '/download.zip')).arrayBuffer()); fs.writeFileSync(path.join(output, 'invitation-download.zip'), bytes); const join = JSON.parse(zipEntry(bytes, 'join.json').toString('utf8')); assert.equal(join.invite, codeA); assert.equal(join.url, undefined); assert(!JSON.stringify(join).includes('127.0.0.1'));
  // An old downloaded package upgrades its join.json on startup.
  const legacyRoot = path.join(output, 'invite-legacy-preview'); fs.mkdirSync(legacyRoot, { recursive: true }); fs.copyFileSync(exe, path.join(legacyRoot, '鱼来.exe')); fs.cpSync(path.join(project, 'www'), path.join(legacyRoot, 'www'), { recursive: true }); fs.writeFileSync(path.join(legacyRoot, 'join.json'), JSON.stringify({ url: urlA }));
  await helper(39344, path.join(legacyRoot, '鱼来.exe')); const legacyMeta = await (await fetch('http://127.0.0.1:39344/local/meta')).json(); assert.equal(legacyMeta.joinUrl, codeA); assert.equal(JSON.parse(fs.readFileSync(path.join(legacyRoot, 'join.json'), 'utf8')).invite, codeA);
  const third = await browser.newContext(), c = await open(third, 39344, '邀请丙', '/?join=' + encodeURIComponent(urlA)); await c.waitForFunction(() => tide.network.peers.length > 0); assert(!c.url().includes('join='));
  // An old browser cache is rewritten as codes before automatic reconnect.
  await b.close(); const setup = await second.newPage(); await setup.goto(urlB + '/welcome.html'); await setup.evaluate(async values => (await import('./storage.js')).set('known', values), [urlA, codeA, 'invalid']); await setup.close(); b = await open(second, 39342); await b.waitForFunction(() => tide.network.peers.length > 0); const upgraded = await b.evaluate(async () => (await import('./storage.js')).get('known')); assert(upgraded.length > 0 && upgraded.every(code => code.startsWith('YL1.'))); assert.equal(upgraded.filter(code => code === codeA).length, 1);
  for (const code of ['YL1.invalid.invalid', await encodeInvite('http://8.8.8.8:39241')]) { const response = await fetch(urlA + '/local/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: metaA.token, node: 'test', url: code }) }); assert.equal(response.status, 400); const result = await response.json(); assert(!result.error.includes('8.8.8.8')); }
  assert.deepEqual(errors, []); console.log('邀请码复制、非明文接口/缓存/下载配置、旧入口迁移、三浏览器P2P连接与非法代码拒绝通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
