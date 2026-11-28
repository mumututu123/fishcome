const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { availablePort, launcherPath, printVersion, waitForHealth } = require('./release-fixtures.cjs');

test('真实合流只提醒一次，同一身份刷新两次后仍能双向同步', async t => {
  const { version } = printVersion(launcherPath);
  async function launch() {
    const port = await availablePort();
    const child = spawn(launcherPath, ['--headless', '--loopback', '--port', String(port)], { windowsHide: true, stdio: 'ignore' });
    t.after(() => child.kill());
    await waitForHealth(port, version);
    return 'http://127.0.0.1:' + port;
  }

  const first = await launch(), second = await launch();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const errors = [];
  async function ready(page) {
    await page.waitForFunction(() => window.tide).catch(async error => {
      const message = await page.locator('#networkStatus').textContent();
      throw new Error(`世界未就绪：${message}；页面异常：${errors.join('、')}`, { cause: error });
    });
  }
  async function open(url, nick) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#nickInput').fill(nick);
    await page.locator('#welcomeForm .primary').click();
    await ready(page);
    return page;
  }

  const a = await open(first, '隔离甲'), b = await open(second, '隔离乙');
  await a.evaluate(() => {
    window.mergeNotices = 0;
    new MutationObserver(records => {
      if (records.some(({ target }) => /^(已接入伙伴，两个世界正在合流|两片海合流了)$/.test(target.textContent))) window.mergeNotices++;
    }).observe(document.querySelector('#toast'), { childList: true });
  });
  await b.locator('#connect').click();
  await b.locator('#peerUrl').fill(first);
  await b.locator('#connectionForm .primary').click();
  await a.waitForFunction(() => mergeNotices === 1 && Object.keys(tide.world.data.roots).length === 2);
  await b.waitForFunction(() => Object.keys(tide.world.data.roots).length === 2);
  const state = page => page.evaluate(() => ({ actor: tide.identity.actor, roots: Object.keys(tide.world.data.roots).sort() }));
  const expected = await state(b);
  await b.waitForFunction(async roots => {
    const { get } = await import('/storage.js');
    const saved = await get('checkpoint', { observeCheckpoint: false });
    const storedRoots = Object.keys(saved?.world?.roots ?? {});
    return storedRoots.length === roots.length && roots.every(root => storedRoots.includes(root));
  }, expected.roots, { polling: 50 });
  async function chat(from, to, message) {
    await from.locator('#chatInput').fill(message);
    await from.locator('#chatForm button').click();
    await to.locator('#chatMessages .message').filter({ hasText: message }).waitFor();
  }

  for (let i = 0; i < 2; i++) {
    const priorNode = await b.evaluate(() => tide.network.node);
    await b.reload();
    await ready(b);
    assert.deepEqual(await state(b), expected, '刷新后应从本地存档恢复已合流的世界');
    const currentNode = await b.evaluate(() => tide.network.node);
    assert.notEqual(currentNode, priorNode);
    await a.waitForFunction(node => tide.network.peers.some(peer => peer.node === node), currentNode);
    await chat(b, a, '重连后发出消息' + i);
    if (i === 1) await chat(a, b, '仍能收到回复');
    assert.deepEqual(await state(b), expected);
    assert.equal(await a.evaluate(() => mergeNotices), 1, '重连不应重复提示合流');
  }
  const c = await open(await launch(), '隔离丙');
  await c.locator('#connect').click();
  await c.locator('#peerUrl').fill(second);
  await c.locator('#connectionForm .primary').click();
  await a.waitForFunction(() => Object.keys(tide.world.data.roots).length === 3 && mergeNotices === 2);
  await chat(c, a, '新来的一片海');
  assert.equal(await a.evaluate(() => mergeNotices), 2, '经伙伴转发的合流也只应提醒一次');
  assert.deepEqual(errors, []);
});
