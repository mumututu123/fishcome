import { objects, flat, prepare, encode, decode } from './kernel.mjs';
import { lifeContext } from '/life.js';
import { World } from '/engine.js';

function reference(frame) {
  const groups = new Map(), fishes = {}, scenery = new Map(), fishIndex = new Map(), ties = new Map();
  for (const p of frame.points) {
    const tie = ties.get(p.rank) || 0;
    const base = String(p.rank).padStart(10, '0');
    const id = base + '\u0001'.repeat(tie);
    if (id.localeCompare(base) !== 0) throw Error('浏览器无法重建相同的鱼标识排序');
    ties.set(p.rank, tie + 1); fishIndex.set(id, p.index);
    fishes[id] = { id, x: p.x, y: p.y, facing: 1 };
    groups.set(id, [{ x: 0, y: 0 }]);
  }
  for (const [x, y] of frame.scenery) scenery.set([x,y].join(','), { scene: { id: 's', x, y }, cell: { x: 0, y: 0 } });
  const world = new World(20000, 'seed', { populate: false });
  Object.assign(world.data, { fishes, ops: {}, roots: { seed: 0 } });
  const { neighbors } = lifeContext(world, 20000, scenery, groups);
  return [...groups.keys()].map(id => Array.from(neighbors.get(id), q => fishIndex.get(q.id)));
}

function verify(csr, expected) {
  if (csr.offsets.length !== expected.length + 1 || csr.offsets[0] !== 0) throw Error('邻鱼表长度有差异');
  for (let i = 0; i < expected.length; i++) {
    const lo = csr.offsets[i], hi = csr.offsets[i + 1], row = expected[i];
    if (hi - lo !== row.length) throw Error('第 ' + i + ' 条鱼邻居数量有差异');
    for (let k = 0; k < row.length; k++) if (csr.indices[lo + k] !== row[k]) throw Error('第 ' + i + ' 条鱼邻居顺序有差异');
  }
}

async function run(method, frame, oracle) {
  const start = performance.now();
  let result, kernelMs, inputBytes = 0, outputBytes = 0;
  if (method.startsWith('go')) {
    const body = encode(frame);
    inputBytes = body.byteLength;
    const response = await fetch({goObjects:'/objects', goFlat:'/flat', goInteger:'/integer'}[method], {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body
    });
    if (!response.ok) throw Error('本机 Go 请求失败 ' + response.status);
    result = decode(await response.arrayBuffer(), frame.points.length);
    const elapsed = response.headers.get('X-Kernel-Ns');
    if (elapsed === null || !Number.isFinite(Number(elapsed)) || Number(elapsed) < 0) throw Error('缺少 Go 内核计时');
    kernelMs = Number(elapsed) / 1e6;
    outputBytes = result.indices.byteLength + result.offsets.byteLength;
  } else {
    result = method === 'jsObjects' ? objects(frame) : flat(frame, method === 'jsInteger');
    kernelMs = performance.now() - start;
  }
  const decodedMs = performance.now() - start;
  const map = new Map();
  for (let i = 0; i < frame.points.length; i++) {
    const start = result.offsets[i], end = result.offsets[i + 1], row = new Array(end - start);
    for (let j = start; j < end; j++) row[j - start] = frame.points[result.indices[j]];
    map.set(frame.points[i].id, row);
  }
  const usableMs = performance.now() - start;
  verify(result, oracle);
  for (let i = 0; i < oracle.length; i++) {
    const row = map.get(frame.points[i].id);
    for (let k = 0; k < row.length; k++) if (row[k].index !== oracle[i][k]) throw Error('浏览器回填邻鱼结果有差异');
  }
  return { kernelMs, decodedMs, usableMs, inputBytes, outputBytes };
}

const methods = ['jsObjects', 'goObjects', 'jsFlat', 'goFlat', 'jsInteger', 'goInteger'];
function withIds(geom) {
  const frame = prepare(geom);
  for (const p of frame.points) p.id = 'fish-' + p.index;
  return frame;
}
export async function measure(geometry, rounds, samples, backupExpected) {
  // Rim wrapping, an exact radius, rounded fractional positions, co-located fish,
  // occluded lines, and equal collation ranks in different traversal bins.
  const edge = withIds({ points: [
    [0, 10, 3], [999, 10, 0], [1, 10, 0], [0, 10, 2], [12, 10, 1],
    [12.000000000000002, 10, 1], [5.5, 14.5, 5], [999.5, 9.5, 6], [998, 8, 7]
  ], scenery: [[2, 10], [999, 9], [3.5,13.5]] });
  const known = reference(edge);
  for (const m of methods) await run(m, edge, known);
  const frame = withIds(geometry), oracle = reference(frame);
  if (backupExpected) {
    if (backupExpected.length !== oracle.length) throw Error('备份与匿名输入的鱼数量不同');
    for (let i = 0; i < oracle.length; i++) {
      const actual = oracle[i], expected = backupExpected[i];
      if (actual.length !== expected.length || actual.some((id, k) => id !== expected[k])) {
        throw Error('备份与匿名输入的邻鱼不同，序号 ' + i);
      }
    }
  }
  const measured = [], calls = { warmup: 0, timed: 0 };
  for (let pass = 0; pass < rounds + 1; pass++) {
    const rows = Object.fromEntries(methods.map(m => [m, []]));
    for (let sample = 0; sample < (pass ? samples : 3); sample++) {
      for (let k = 0; k < methods.length; k++) {
        const m = methods[(pass + sample + k) % methods.length];
        rows[m].push(await run(m, frame, oracle));
        calls[pass ? 'timed' : 'warmup']++;
      }
    }
    if (pass) measured.push(rows);
  }
  const lengths = oracle.map(row => row.length).sort((a,b) => a-b);
  const halfGridFish = frame.points.filter(p => Number.isInteger(2*p.x) && Number.isInteger(2*p.y)).length;
  return { fish: frame.points.length, halfGridFish, scenery: frame.scenery.length, edges: lengths.reduce((a,b) => a+b,0),
    medianNeighbors: lengths[Math.floor(lengths.length/2)], maxNeighbors: lengths.at(-1), calls, measured };
}
