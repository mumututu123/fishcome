const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');
const base = process.argv[2], expectedAsset = process.argv[3];
if (!base || !expectedAsset) throw new Error('Usage: node browser-release.cjs URL ASSET_NAME');
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.TIDE_TEST_BROWSER_PATH ? { executablePath: process.env.TIDE_TEST_BROWSER_PATH } : {}) });
  const errors = [];
  try {
    const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack));
    await page.goto(base + '/');
    const script = await (await context.request.get(base + '/app.js')).text();
    const required = [...new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))];
    const missing = await page.evaluate(ids => ids.filter(id => !document.getElementById(id)), required);
    assert.deepEqual(missing, [], 'Published HTML is missing elements required by app.js');
    await page.locator('#nickInput').fill('发布包验证');
    await page.locator('#welcomeForm .primary').click();
    await page.waitForFunction(() => window.tide && document.getElementById('worldLabel').textContent && document.getElementById('networkStatus').textContent);
    assert.equal(await page.evaluate(() => tide.balance()), 20);
    assert.equal(await page.locator('#sceneCount').textContent(), '1');
    const roots = await page.evaluate(() => tide.world.data.roots);
    await page.locator('#chatInput').focus(); await page.keyboard.press('h');
    assert.equal(await page.locator('#helpDialog').evaluate(element => element.open), false, 'Typing in visible chat input must not open help');
    assert.equal(await page.locator('#chatInput').inputValue(), 'h');
    await page.locator('#chatInput').fill(''); await page.locator('#help').focus();
    for (const [key, dialog] of [['h', 'helpDialog'], ['f', 'creatorDialog'], ['s', 'creatorDialog'], ['e', 'foodDialog'], ['p', 'myFishDialog']]) {
      await page.keyboard.press(key);
      assert(await page.locator('#' + dialog).evaluate(element => element.open), `Shortcut ${key} did not open ${dialog}: ${JSON.stringify(await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 300), openDialogs: [...document.querySelectorAll('dialog[open]')].map(element => element.id) })))}`);
      await page.keyboard.press('Escape');
      await page.locator('#' + dialog).waitFor({ state: 'hidden' });
    }
    const beforeFish = await page.evaluate(() => tide.world.counts.fish);
    await page.locator('#makeFish').click();
    await page.locator('#gridCellInput').focus(); await page.keyboard.insertText('鱼');
    await page.keyboard.press('ArrowRight'); await page.keyboard.insertText('o');
    assert.equal(await page.locator('#drawingCount').textContent(), '2');
    await page.locator('#fishNameInput').fill('测试'); await page.locator('#fishGenderFemale').check();
    assert(await page.locator('#placeDrawing').isEnabled()); await page.locator('#placeDrawing').click();
    const point = await page.evaluate(() => {
      const data = tide.world.data, view = tide.view, size = 18 * view.scale, occupied = [], wrap = x => (x % 1000 + 1000) % 1000;
      for (const cell of Object.values(data.chars)) {
        const entity = cell.kind === 'fish' ? data.fishes[cell.entity] : cell.kind === 'scene' ? data.scenes[cell.entity] : null;
        if (cell.kind === 'burn') continue;
        occupied.push({ x: wrap(entity ? entity.x + (cell.kind === 'fish' ? entity.facing : 1) * cell.x : cell.x), y: entity ? entity.y + cell.y : cell.y });
      }
      for (let sy = 260; sy <= 500; sy += 36) for (let sx = 400; sx <= 850; sx += 36) {
        const x = wrap(Math.floor(view.camera.x + (sx - innerWidth / 2) / size)), y = Math.floor(view.camera.y + (sy - innerHeight / 2) / size);
        if (y < 3 || y >= Math.min(data.terrain.depths[x], data.terrain.depths[wrap(x + 1)]) - 2) continue;
        if (occupied.some(cell => Math.abs((cell.x - x + 1500) % 1000 - 500) <= 6 && Math.abs(cell.y - y) <= 6)) continue;
        return { x: sx, y: sy };
      }
      throw new Error('No empty visible placement position');
    });
    await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => Object.values(tide.world.data.fishes).some(fish => fish.actor === tide.identity.actor && fish.name === '测试'));
    const created = await page.evaluate(() => {
      const data = tide.world.data, fish = Object.values(data.fishes).find(fish => fish.actor === tide.identity.actor && fish.name === '测试');
      return { id: fish.id, gender: fish.gender, cells: Object.values(data.chars).filter(cell => cell.kind === 'fish' && cell.entity === fish.id).map(cell => cell.ch), count: tide.world.counts.fish, balance: tide.balance() };
    });
    assert.equal(created.count, beforeFish + 1); assert.equal(created.balance, 18); assert.equal(created.gender, 'female'); assert.deepEqual(created.cells.sort(), ['o', '鱼'].sort());
    await page.locator('#myFish').click(); assert.equal(await page.locator(`.fishCard[data-fish="${created.id}"]`).count(), 1);
    if (process.env.TIDE_TEST_OUTPUT) {
      fs.mkdirSync(process.env.TIDE_TEST_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.TIDE_TEST_OUTPUT, 'release-create-fish.png') });
      fs.writeFileSync(path.join(process.env.TIDE_TEST_OUTPUT, 'release-create-fish-results.json'), JSON.stringify({ archive: expectedAsset, beforeFish, created, errors }, null, 2));
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('l');
    const downloadEvent = page.waitForEvent('download'); await page.locator('#downloadPackage').click(); const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), expectedAsset, 'Launcher download filename differs from release asset');
    assert.equal(await download.failure(), null);
    await page.keyboard.press('Escape');
    await page.reload(); await page.waitForFunction(() => window.tide);
    assert.deepEqual(await page.evaluate(() => tide.world.data.roots), roots, 'Reload must restore the same world');
    assert(await page.evaluate(id => !!tide.world.data.fishes[id], created.id), 'Created fish must survive reload');
    assert.equal(await page.evaluate(() => tide.balance()), 18);
    await page.waitForTimeout(1100);
    assert.deepEqual(errors, [], 'Published page raised JavaScript exceptions');
    console.log('浏览器发布验证通过：实际创建两字母鱼、配额20→18、我的鱼显示及刷新保留，下载名称和页面均无异常。');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
