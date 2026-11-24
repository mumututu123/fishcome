const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..'), children = [], errors = [], output = path.join(project, 'test-output'); let browser;
const exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe');
async function helper(port, file = exe) {
  const child = spawn(file, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }); children.push(child);
  const deadline = Date.now() + 20000; while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error('启动器未就绪');
}
async function open(context, port, nick, code) {
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`http://127.0.0.1:${port}/` + (code ? '?join=' + encodeURIComponent(code) : ''));
  if (nick) { await page.locator('#nickInput').fill(nick); await page.locator('#welcomeForm .primary').click(); }
  await page.waitForFunction(() => window.tide); return page;
}
async function code(page) { await page.locator('#connect').click(); const value = await page.locator('#myUrl').inputValue(); await page.locator('#closeConnection').click(); return value; }
async function connect(page, invitation) { await page.locator('#connect').click(); await page.locator('#peerUrl').fill(invitation); await page.locator('#connectionForm .primary').click(); await page.waitForFunction(() => tide.network.peers.length > 0); }
function zipEntry(bytes, name) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert(end >= 0); let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const size = bytes.readUInt32LE(offset + 20), filenameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), method = bytes.readUInt16LE(offset + 10), local = bytes.readUInt32LE(offset + 42), filename = bytes.subarray(offset + 46, offset + 46 + filenameLength).toString('utf8');
    if (filename === name) { const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), compressed = bytes.subarray(start, start + size); return method === 8 ? inflateRawSync(compressed) : compressed; }
    offset += 46 + filenameLength + extra + comment;
  } throw new Error('发行包缺少 ' + name);
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const { inviteDetails } = await import(pathToFileURL(path.join(project, 'www', 'invite.js')).href);
  for (const port of [39441, 39442, 39443]) await helper(port);
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const ca = await browser.newContext(), cb = await browser.newContext(), cn = await browser.newContext();
  let a = await open(ca, 39441, '推广甲'), b = await open(cb, 39442, '推广乙'); const codeA = await code(a), codeB = await code(b), actorA = await a.evaluate(() => tide.identity.actor), actorB = await b.evaluate(() => tide.identity.actor);
  assert.equal((await inviteDetails(codeA)).actor, actorA); assert.equal((await inviteDetails(codeB)).actor, actorB);
  assert.equal(await a.evaluate(() => tide.balance()), 20); assert.equal(await b.evaluate(() => tide.balance()), 20);
  await connect(b, codeA); await a.waitForFunction(() => tide.balance() === 30); assert.equal(await b.evaluate(() => tide.balance()), 20);
  const n = await open(cn, 39443, '链接新人', codeB); await n.waitForFunction(() => tide.network.peers.length > 0); await b.waitForFunction(() => tide.balance() === 30); assert.equal(await a.evaluate(() => tide.balance()), 30); assert.equal(await n.evaluate(() => tide.balance()), 20);
  assert(!n.url().includes('join='));
  const bytes = Buffer.from(await (await fetch('http://127.0.0.1:39441/download.zip?invite=' + encodeURIComponent(codeA))).arrayBuffer()); const join = JSON.parse(zipEntry(bytes, 'join.json').toString('utf8')); assert.equal(join.invite, codeA);
  const packageRoot = path.join(output, 'referral-downloaded'); fs.mkdirSync(packageRoot, { recursive: true }); fs.copyFileSync(exe, path.join(packageRoot, '鱼来.exe')); fs.cpSync(path.join(project, 'www'), path.join(packageRoot, 'www'), { recursive: true }); fs.writeFileSync(path.join(packageRoot, 'join.json'), JSON.stringify(join)); await helper(39444, path.join(packageRoot, '鱼来.exe'));
  assert.equal((await (await fetch('http://127.0.0.1:39444/local/meta')).json()).joinUrl, codeA);
  const cm = await browser.newContext(); let m = await open(cm, 39444, '下载包新人'); await m.waitForFunction(() => tide.network.peers.length > 0); await a.waitForFunction(() => tide.balance() === 40);
  await b.waitForFunction(() => Object.values(tide.world.data.ops).filter(op => op.kind === 'referral').length === 3);
  const registration = await m.evaluate(async () => (await (await import('./storage.js')).get('identity')).registration); assert(registration.joined); assert.equal(registration.referral.body.inviter, actorA);
  // An existing account (without new-registration metadata) earns no reward for reconnecting.
  const oldContext = await browser.newContext(), setup = await oldContext.newPage(); await setup.goto('http://127.0.0.1:39443/welcome.html');
  await setup.evaluate(async () => { const { newIdentity, set } = await import('./storage.js'); const identity = await newIdentity('旧用户'); delete identity.registration; await set('identity', identity); }); await setup.close();
  const old = await open(oldContext, 39443, undefined, codeA); await old.waitForFunction(() => tide.network.peers.length > 0 && Object.values(tide.world.data.ops).filter(op => op.kind === 'referral').length === 3); assert.equal(await a.evaluate(() => tide.balance()), 40);
  await old.close(); await oldContext.close();
  // Reload and import preserve the consumed registration and exact signed reward record.
  await m.reload(); await m.waitForFunction(() => window.tide && tide.network.peers.length > 0 && Object.values(tide.world.data.ops).filter(op => op.kind === 'referral').length === 3); assert.equal(await a.evaluate(() => tide.balance()), 40);
  const backup = await m.evaluate(async () => { const { get } = await import('./storage.js'); return { identity: await get('identity'), checkpoint: await get('checkpoint'), known: await get('known') }; }); await m.close();
  const importedContext = await browser.newContext(), importedSetup = await importedContext.newPage(); await importedSetup.goto('http://127.0.0.1:39444/welcome.html'); await importedSetup.evaluate(async backup => (await import('./storage.js')).putMany(Object.entries(backup)), backup); await importedSetup.close();
  m = await open(importedContext, 39444); await m.waitForFunction(() => tide.network.peers.length > 0 && Object.values(tide.world.data.ops).filter(op => op.kind === 'referral').length === 3); assert.equal(await a.evaluate(() => tide.balance()), 40);
  // Different profiles share one launcher: explicit downloads must retain the selected owner.
  const alternate = await browser.newContext(), u = await open(alternate, 39441, '同机用户'); const codeU = await code(u); assert.notEqual((await inviteDetails(codeU)).actor, actorA);
  for (const invitation of [codeU, codeA]) { const body = Buffer.from(await (await fetch('http://127.0.0.1:39441/download.zip?invite=' + encodeURIComponent(invitation))).arrayBuffer()); assert.equal(JSON.parse(zipEntry(body, 'join.json').toString('utf8')).invite, invitation); }
  const welcome = await ca.newPage(); await welcome.goto('http://127.0.0.1:39441/welcome.html?invite=' + encodeURIComponent(codeA)); await welcome.waitForFunction(() => document.getElementById('address').value); assert.equal(await welcome.locator('#address').inputValue(), codeA); assert((await welcome.locator('#downloadPackage').getAttribute('href')).includes(encodeURIComponent(codeA))); await welcome.close(); await u.close(); await alternate.close();
  const pages = [a, b, n, m], nodes = await Promise.all(pages.map(page => page.evaluate(() => tide.network.node))), leader = await a.evaluate(() => tide.network.leader), index = nodes.indexOf(leader); assert(index >= 0); await pages[index].close();
  const remaining = pages.filter((page, i) => i !== index); await remaining[0].waitForFunction(oldLeader => tide.network.leader !== oldLeader && tide.network.peers.length > 0, leader);
  for (const page of remaining) await page.waitForFunction(({ actorA, actorB }) => { const rewards = Object.values(tide.world.data.ops).filter(op => op.kind === 'referral'); return rewards.filter(op => op.inviter === actorA).length === 2 && rewards.filter(op => op.inviter === actorB).length === 1; }, { actorA, actorB });
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(output, 'browser-referral-results.json'), JSON.stringify({ passed: true, rewards: { inviterA: 20, inviterB: 10 }, errors }, null, 2));
  console.log('真实WebRTC推广奖励、手动/链接/下载包接入、发码账号归属、旧账号不奖励、刷新/备份/合流去重及协调者退出保留通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); for (const child of children) child.kill(); });
