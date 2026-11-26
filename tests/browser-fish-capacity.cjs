const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { chromium } = require(process.env.TIDE_TEST_MODULES ? path.join(process.env.TIDE_TEST_MODULES, 'playwright') : 'playwright');

const count = Number(process.argv[2] || 100000), duration = Number(process.argv[3] || 30);
assert(Number.isSafeInteger(count) && count > 0 && duration >= 5 && duration <= 180);
const width = Math.max(1000, Math.ceil(Math.ceil(count / 16) * 6 / 1000) * 1000);
const www = path.resolve(__dirname, '../www');
const fixture = `
import { makeFishWorld } from '/capacity-fish.mjs';
window.installCapacityWorld = () => {
  const begin = performance.now();
  const next = makeFishWorld(World, ${count}, CONFIG.width);
  next.attachArchives(archiveStore);
  next.data.participants[identity.actor] = identity.nick;
  world = next;
  const apply = next.apply.bind(next);
  next.apply = (op, ...args) => {
    const begin = performance.now(), result = apply(op, ...args);
    if (op.kind === 'food' && op.actor === identity.actor) {
      const receipt = next.data.ops[op.id];
      window.capacityReport({ kind: 'feed', at: Date.now(), ok: result.ok, error: result.error,
        cell: next.data.chars[op.id]?.kind, signed: !!receipt?.proof, charged: receipt?.cost,
        applyMs: Math.round(performance.now() - begin) });
      requestAnimationFrame(() => window.capacityReport({ kind: 'feed', visibleBalance: Number(document.getElementById('balance').textContent) }));
    }
    return result;
  };
  let steps = 0, fishGlyphs = 0;
  subscribeSimulationChanges((target, patch) => {
    if (target === next && patch && Number.isFinite(patch.values.tick)) {
      steps++;
      window.capacityReport({ kind: 'step', steps });
    }
  });
  const glyph = renderer.glyph.bind(renderer);
  renderer.glyph = (...args) => { if (args[8] === 'fish') fishGlyphs++; return glyph(...args); };
  let painted = false, previous = performance.now(), batch = [], start = previous;
  const draw = renderer.draw.bind(renderer);
  renderer.draw = (current, now) => {
    const at = performance.now();
    draw(current, now);
    const end = performance.now();
    batch.push([at - previous, end - at]); previous = at;
    if (!painted || end - start > 900) {
      window.capacityReport({ kind: 'frames', rows: batch, fishGlyphs, indexed: !renderer.viewport.remaining, clock: Date.now(), first: !painted });
      batch = []; start = end; painted = true;
    }
  };
  for (const event of ['click', 'wheel', 'pointerup']) {
    document.addEventListener(event, e => {
      if (!e.isTrusted) return;
      const began = performance.timeOrigin + e.timeStamp;
      requestAnimationFrame(() => requestAnimationFrame(() => window.capacityReport({
        kind: 'input', event, began, paint: performance.timeOrigin + performance.now(),
        scale: renderer.scale, x: renderer.camera.x, y: renderer.camera.y, target: e.target.id
      })));
    }, { capture: true, passive: true });
  }
  return { setupMs: performance.now() - begin, start: Date.now(), width: CONFIG.width };
};`;
let browser;
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  if (route === '/local/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
  if (route.startsWith('/local/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(route === '/local/meta' ? { token: 'test', url: 'http://127.0.0.1:' + server.address().port } : { ok: true, clients: [], hints: [] }));
    return;
  }
  const file = route === '/capacity-fish.mjs' ? path.join(__dirname, 'capacity-fish.mjs') : path.resolve(www, '.' + (route === '/' ? '/index.html' : route));
  if ((!file.startsWith(www + path.sep) && route !== '/capacity-fish.mjs') || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  let content = fs.readFileSync(file);
  if (route === '/app.js') content = content.toString() + fixture;
  if (route === '/geography.js') {
    assert(content.includes('WORLD_WIDTH = 1000;'));
    content = content.toString().replace('WORLD_WIDTH = 1000;', 'WORLD_WIDTH = ' + width + ';');
  }
  res.end(content);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function stats(values) {
  const samples = [...values].sort((a, b) => a - b);
  const at = q => samples.length ? Math.round(samples[Math.ceil(q * samples.length) - 1] * 10) / 10 : null;
  return { n: samples.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1), over50: samples.filter(n => n > 50).length };
}
async function main() {
  const report = { count, width, duration, mode: '2D', inputs: [], errors: [], completedSteps: 0, worker: [] };
  const frames = [], draws = [], screens = [], attempts = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('crash', () => { report.crash = true; });
  await page.exposeFunction('capacityReport', data => {
    if (data.kind === 'input') report.inputs.push(data);
    else if (data.kind === 'worker') report.worker.push(data);
    else if (data.kind === 'step') report.completedSteps = data.steps;
    else if (data.kind === 'feed') report.feed = { ...report.feed, ...data };
    else {
      if (data.first) report.firstDrawAt = data.clock;
      if (data.indexed && !report.fullyIndexedAt) report.fullyIndexedAt = data.clock;
      for (const [frame, draw] of data.rows) { frames.push(frame); draws.push(draw); }
      report.fishGlyphs = data.fishGlyphs;
      screens.push(data.clock);
    }
  });
  try {
    await page.addInitScript(() => {
      localStorage.removeItem('tide.scene3d');
      const post = Worker.prototype.postMessage;
      const states = new WeakMap();
      Worker.prototype.postMessage = function(message, ...rest) {
        if (message?.kind === 'open') {
          const state = { phase: '', rows: 0, marked: 0, requests: [] };
          states.set(this, state);
          this.addEventListener('message', event => {
            const done = state.requests.shift();
            if (done && !['rows', 'restore'].includes(done.phase)) window.capacityReport({ kind: 'worker', ...done, event: 'reply', at: Date.now(), error: event.data?.error });
          });
          this.addEventListener('error', event => window.capacityReport({ kind: 'worker', phase: state.phase, event: 'error', at: Date.now(), error: event.message }));
        }
        const state = states.get(this);
        if (state) {
          state.phase = message.kind;
          state.rows += message.rows?.length || 0;
          state.requests.push({ phase: state.phase, rows: state.rows });
          if (!['rows', 'restore'].includes(state.phase) || state.rows - state.marked >= 100000) {
            state.marked = state.rows;
            window.capacityReport({ kind: 'worker', phase: state.phase, event: 'send', rows: state.rows, at: Date.now() });
          }
        }
        return post.call(this, message, ...rest);
      };
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#nickInput').fill('浏览器容量测试');
    await page.locator('#welcomeForm .primary').click();
    await page.waitForFunction(() => window.tide && window.installCapacityWorld);
    const zoom = await page.locator('#zoomIn').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    report.setup = await page.evaluate(() => window.installCapacityWorld());
    const start = performance.now();
    function send(params) {
      const when = Date.now();
      attempts.push({ type: params.type, when });
      return cdp.send('Input.dispatchMouseEvent', { ...params, timestamp: when / 1000 }).catch(error => { if (!report.crash && !report.transportError) report.transportError = error.message; });
    }
    // Schedule from outside the renderer. Delivery delays are part of the sample.
    let placingFood = false;
    async function feedOnce() {
      placingFood = true;
      report.feed = { start: Date.now(), stage: 'open' };
      try {
        await page.locator('#feed').click({ timeout: 10000 });
        report.feed.stage = 'select';
        report.feed.balanceBefore = Number(await page.locator('#balance').textContent({ timeout: 5000 }));
        await page.locator('#placeFood').click({ timeout: 10000 });
        report.feed.stage = 'place';
        report.feed.clicked = Date.now();
        await page.mouse.click(735, Math.round(720 * .27));
        await page.keyboard.press('Escape');
        if (!report.feed.ok) report.feed.stage = 'awaiting operation';
      } catch (error) { report.feed.failure = error.message; }
      finally { placingFood = false; }
    }
    for (let n = 0; performance.now() - start < duration * 1000 && !report.crash; n++) {
      if (!report.feed && n >= 6 && (report.fullyIndexedAt || n >= 20)) void feedOnce();
      if (placingFood) { await pause(750); continue; }
      if (n % 3 === 0) {
        const x = zoom.x + zoom.width / 2, y = zoom.y + zoom.height / 2;
        void send({ type: 'mousePressed', button: 'left', x, y, clickCount: 1 });
        void send({ type: 'mouseReleased', button: 'left', x, y, clickCount: 1 });
      } else if (n % 3 === 1) {
        void send({ type: 'mouseWheel', x: 650, y: 360, deltaX: 0, deltaY: 60 });
      } else {
        void send({ type: 'mousePressed', x: 650, y: 360, button: 'left', buttons: 1 });
        void send({ type: 'mouseMoved', x: 730, y: 380, buttons: 1 });
        void send({ type: 'mouseReleased', x: 730, y: 380, button: 'left' });
      }
      await pause(750);
    }
    report.elapsedMs = Math.round(performance.now() - start);
    // Include the unpainted tail when a stalled renderer stops reporting frames.
    report.unreportedTailMs = Date.now() - (screens.at(-1) || report.setup.start);
  } catch (error) { report.failure = error.message; }
  report.pointerAttempts = attempts.length;
  report.framesMs = stats(frames); report.drawMs = stats(draws);
  report.inputToPaintMs = stats(report.inputs.map(input => input.paint - input.began));
  report.scaleChanged = new Set(report.inputs.map(input => input.scale)).size > 1;
  report.cameraMoved = new Set(report.inputs.map(input => input.x)).size > 1;
  console.log(JSON.stringify(report));
  const fed = report.feed?.signed && report.feed.charged === 1 && report.feed.cell === 'food' && report.feed.visibleBalance === report.feed.balanceBefore - 1;
  if (!report.setup || !frames.length || !report.fishGlyphs || !report.inputs.length || !report.scaleChanged || !report.cameraMoved || !report.completedSteps || !fed || report.crash) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.closeAllConnections(); server.close();
});
