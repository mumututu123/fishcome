import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, fish: { type: 'string', default: '5000' },
  rounds: { type: 'string', default: '5' }, samples: { type: 'string', default: '5' },
  go: { type: 'string', default: 'go' }, source: { type: 'string' }, help: { type: 'boolean' }
} });
if (values.help) {
  console.log('node tests/experiments/neighbor-kernel/run.mjs [--input=备份或匿名几何.json | --fish=5000] [--source=对照仓库] [--rounds=5] [--samples=5] [--go=go]');
  console.log('匿名输入含 points 和 scenery。points 按鱼体分组遍历顺序保存 [中心横坐标,中心纵坐标,标识排序名次]，并列时名次相同。scenery 保存 [横坐标,纵坐标]。横坐标已环绕至 [0,1000)。');
  console.log('kernelMs 统计构建空间索引、查找、遮挡和排序。decodedMs 含浏览器编码至收到并解码，usableMs 还含恢复逐鱼邻居对象表。计时不含提取几何和计算标识名次。');
  process.exit(0);
}
const directory = dirname(fileURLToPath(import.meta.url));
const www = values.source ? resolve(values.source, 'www') : resolve(directory, '../../../www');
const count = Number(values.fish), rounds = Number(values.rounds), samples = Number(values.samples);
assert(Number.isSafeInteger(count) && count > 0 && count <= 10000);
assert(Number.isSafeInteger(rounds) && rounds > 0 && Number.isSafeInteger(samples) && samples > 0);

async function loadGeometry() {
  if (!values.input) return { geometry: { points: Array.from({ length: count }, (_, i) => [
    i % 250 * 4 + 1, 4 + Math.floor(i / 250) * 3, i
  ]), scenery: [] } };
  const input = JSON.parse(await readFile(values.input, 'utf8'));
  if (Array.isArray(input.points) && Array.isArray(input.scenery)) return { geometry: { points: input.points, scenery: input.scenery } };
  const data = input.checkpoint?.world ?? input.world ?? input;
  assert(data?.protocol === 1 && data.fishes && data.chars && Number.isFinite(data.tick), '文件需要匿名坐标或世界备份');
  const { restoreCheckpoint } = await import(pathToFileURL(join(www, 'lifecycle.js')));
  const { wrapX } = await import(pathToFileURL(join(www, 'geography.js')));
  const { lifeContext } = await import(pathToFileURL(join(www, 'life.js')));
  const { world } = restoreCheckpoint({ world: data, lastOnlineAt: data.tick }, data.tick);
  const fishGroups = [...world.fishGroups()].filter(([id, cells]) => world.data.fishes[id] && cells.length);
  const ids = fishGroups.map(([id]) => id).sort((a,b) => a.localeCompare(b));
  let rank = 0;
  const ranks = new Map();
  ids.forEach((id, i) => { if (i && id.localeCompare(ids[i-1])) rank++; ranks.set(id,rank); });
  const points = fishGroups.map(([id, cells]) => {
    const f = world.data.fishes[id];
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const c of cells) {
      xmin = Math.min(xmin,c.x); xmax = Math.max(xmax,c.x); ymin = Math.min(ymin,c.y); ymax = Math.max(ymax,c.y);
    }
    return [wrapX(f.x + f.facing * (xmin+xmax)/2), f.y + (ymin+ymax)/2, ranks.get(id)];
  });
  const scenery = world.sceneryMap(), indices = new Map(fishGroups.map(([id], index) => [id, index]));
  const { neighbors } = lifeContext(world, world.data.tick, scenery, new Map(fishGroups));
  const expected = fishGroups.map(([id]) => Array.from(neighbors.get(id), p => indices.get(p.id)));
  return { geometry: { points, scenery: [...scenery.keys()].map(key => key.split(',').map(Number)) }, expected };
}
const { geometry, expected } = await loadGeometry();
assert(geometry.points.length > 0 && geometry.points.length <= 10000);
for (const [x, y] of [...geometry.points, ...geometry.scenery]) {
  assert(Number.isFinite(x) && x >= 0 && x < 1000 && Number.isFinite(y) && Math.abs(y) <= 1000);
}
for (const [, , rank] of geometry.points) assert(Number.isSafeInteger(rank) && rank >= 0 && rank <= 0xffffffff);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TIDE_TEST_MODULES ? resolve(process.env.TIDE_TEST_MODULES,'playwright') : 'playwright');
const temp = await mkdtemp(join(tmpdir(), 'fishcome-neighbor-')), binary = join(temp, process.platform === 'win32' ? 'neighbors.exe' : 'neighbors');
let server, browser, stopped;
try {
  execFileSync(values.go, ['build', '-o', binary, join(directory, 'main.go')], { windowsHide: true, stdio:'inherit' });
  server = spawn(binary, [www, directory], { windowsHide:true, stdio:['ignore','pipe','inherit'] });
  stopped = once(server, 'exit');
  const lines = createInterface({ input: server.stdout });
  const first = await Promise.race([once(lines, 'line'), stopped.then(() => { throw Error('Go 服务启动失败'); })]);
  lines.close();
  const [url, go] = first[0].split(' ');
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(url));
  browser = await chromium.launch({ headless:true, ...(process.env.TIDE_TEST_BROWSER ? { executablePath:process.env.TIDE_TEST_BROWSER } : {}) });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  const report = await page.evaluate(async ([geometry,rounds,samples,expected]) =>
    (await import('/measure.mjs')).measure(geometry,rounds,samples,expected), [geometry,rounds,samples,expected]);
  assert.deepEqual(errors, []);
  const { measured, ...info } = report;
  const sort = times => times.toSorted((a,b) => a-b);
  const median = times => { const a = sort(times); return (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2; };
  const rounded = value => Number(value.toFixed(2));
  const metrics = {};
  for (const method of Object.keys(measured[0])) {
    metrics[method] = {};
    for (const field of ['kernelMs', 'decodedMs', 'usableMs']) {
      const medians = measured.map(round => median(round[method].map(row => row[field])));
      const all = sort(measured.flatMap(round => round[method].map(row => row[field])));
      metrics[method][field] = { medianOfRounds: rounded(median(medians)), rounds:medians.map(rounded),
        p95:rounded(all[Math.ceil(.95*all.length)-1]), max:rounded(all.at(-1)) };
    }
  }
  const { inputBytes, outputBytes } = measured[0].goFlat[0];
  console.log(JSON.stringify({ sample: values.input ? 'file' : 'generated', chromium: browser.version(), go,
    node:process.version, cpu:cpus()[0].model.trim(), logicalCores:cpus().length, matchedOriginalBackup:!!expected,
    rounds, samplesPerRound:samples, ...info, inputBytes, outputBytes, metrics }, null, 2));
} finally {
  try { await browser?.close(); }
  finally {
    if (server && server.exitCode === null && server.signalCode === null) server.kill();
    if (stopped) await stopped;
    await unlink(binary).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(temp);
  }
}
