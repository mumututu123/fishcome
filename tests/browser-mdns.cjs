const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const project = path.resolve(__dirname, '..');
const exe = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', '鱼来.exe');
const ports = [39347, 39348], children = [], errors = [], results = [];
const source = fs.readFileSync(path.join(project, 'www', 'network.js'), 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(message);
}
async function helper(port) {
  // Bind the LAN interface too: fromUrl must contain the actual IPv4 route, not loopback.
  children.push(spawn(exe, ['--headless', '--port', String(port)], { windowsHide: true, stdio: 'ignore' }));
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } }, '启动器未就绪');
}
async function pair(fixed) {
  const contexts = await Promise.all(ports.map(() => browser.newContext()));
  const outgoing = [];
  const pages = await Promise.all(contexts.map(async (context, index) => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.remoteDescriptions = [];
      const original = RTCPeerConnection.prototype.setRemoteDescription;
      RTCPeerConnection.prototype.setRemoteDescription = function(description) {
        window.testPC = this;
        window.remoteDescriptions.push({ type: description.type, sdp: description.sdp });
        return original.call(this, description);
      };
    });
    if (!fixed) {
      await page.route('**/network.js', route => route.fulfill({
        contentType: 'text/javascript', body: source.replaceAll('await lanDescription(s.sdp, s.fromUrl)', 's.sdp')
      }));
    }
    await page.route('**/local/relay', async route => {
      const data = route.request().postDataJSON();
      if (data.signal.sdp) {
        let count = 0; const original = data.signal.sdp.sdp;
        // Preserve the real ICE UDP port while ensuring multicast DNS cannot resolve the address.
        data.signal.sdp.sdp = data.signal.sdp.sdp.replace(/^(a=candidate:\S+ \d+ udp \d+ )\S+( \d+ typ host[^\r\n]*)/gim,
          (_, prefix, suffix) => { count++; return prefix + `unresolvable-${crypto.randomUUID()}.local` + suffix; });
        assert(count > 0, '真实浏览器必须提供UDP host候选');
        outgoing.push({ index, type: data.signal.type, sdp: data.signal.sdp.sdp, original });
      }
      await route.continue({ postData: JSON.stringify(data) });
    });
    await page.goto(`http://127.0.0.1:${ports[index]}`);
    await page.locator('#nickInput').fill(`mDNS测试${index}`);
    await page.locator('#welcomeForm .primary').click();
    await page.waitForFunction(() => window.tide);
    return page;
  }));
  return { pages, outgoing, async close() {
    // Explicitly unregister before closing test contexts so a following round cannot select a stale tab.
    for (const page of pages) await page.evaluate(async () => {
      const meta = await (await fetch('/local/meta')).json();
      await fetch('/local/unregister', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: meta.token, node: tide.network.node }) });
    });
    for (const context of contexts) await context.close();
  } };
}
async function connect(pages, initiator) {
  const destination = pages[1 - initiator];
  const code = await destination.locator('#myUrl').inputValue();
  const page = pages[initiator];
  await page.locator('#connect').click();
  await page.locator('#peerUrl').fill(code);
  await page.locator('#connectionForm .primary').click();
}
async function main() {
  const { decodeInvite } = await import('../www/invite.js');
  for (const port of ports) await helper(port);
  browser = await chromium.launch({ executablePath: process.env.TIDE_TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const baseline = await pair(false);
  try {
    await connect(baseline.pages, 0);
    await until(async () => (await Promise.all(baseline.pages.map(page => page.evaluate(() => remoteDescriptions.length)))).every(Boolean), '对照组未交换offer/answer');
    await pause(7000);
    for (const page of baseline.pages) {
      assert.equal(await page.evaluate(() => tide.network.peers.length), 0, '未转换时无法解析mDNS候选不应建立直连');
      assert((await page.evaluate(() => remoteDescriptions[0].sdp)).includes('.local'));
    }
    results.push({ fixed: false, connected: false, exchanged: baseline.outgoing.map(s => s.type) });
  } finally { await baseline.close(); }
  for (const initiator of [0, 1]) {
    const updated = await pair(true);
    try {
      const started = Date.now();
      await connect(updated.pages, initiator);
      for (const page of updated.pages) await page.waitForFunction(() => tide.network.peers.length === 1, null, { timeout: 15000 });
      const elapsed = Date.now() - started;
      assert.equal(updated.outgoing.length, 2);
      for (let index = 0; index < 2; index++) {
        const page = updated.pages[index];
        const received = await page.evaluate(() => remoteDescriptions[0]);
        const sent = updated.outgoing.find(signal => signal.index === 1 - index);
        assert(sent.sdp.includes('.local'));
        assert(!received.sdp.includes('.local'), '交给WebRTC的远端描述必须使用数字IPv4');
        const senderInvite = await updated.pages[1 - index].locator('#myUrl').inputValue();
        const ip = new URL(await decodeInvite(senderInvite)).hostname;
        const expected = sent.sdp.replace(/unresolvable-[\w-]+\.local/g, ip);
        assert.equal(received.sdp, expected, '端口和其他SDP内容必须与发送方原始描述相同');
        await page.waitForFunction(() => document.getElementById('networkDetails').textContent.includes('直连邻居 1/8'));
        await page.waitForFunction(() => document.getElementById('online').textContent === '2');
        const text = `mDNS方向${initiator}消息${index}`;
        await page.locator('#chatInput').fill(text);
        await page.locator('#chatForm button').click();
        await updated.pages[1 - index].waitForFunction(text => Object.values(tide.world.data.chats).some(message => message.body.text === text), text);
      }
      results.push({ fixed: true, initiator, connected: true, elapsedMs: elapsed, bidirectionalChat: true });
    } catch (error) {
      console.error(JSON.stringify({ outgoing: updated.outgoing, diagnostics: await Promise.all(updated.pages.map(page => page.evaluate(async () => ({ remoteDescriptions, state: window.testPC?.connectionState, candidates: window.testPC ? [...(await testPC.getStats()).values()].filter(s => ['local-candidate', 'remote-candidate', 'candidate-pair'].includes(s.type)) : [] })))) }));
      throw error;
    } finally { await updated.close(); }
  }
  assert.deepEqual(errors, []);
  fs.mkdirSync(path.join(project, 'test-output'), { recursive: true });
  fs.writeFileSync(path.join(project, 'test-output', 'mdns-connection.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  for (const child of children) child.kill();
});
