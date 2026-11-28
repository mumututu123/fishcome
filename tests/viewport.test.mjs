import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportCells } from '../www/viewport.js';
import { makeFishWorld } from './capacity-fish.mjs';
import { subscribeSimulationChanges } from '../www/simulation-changes.js';
import { expandSimulationPatch } from '../www/simulation-delta.js';

test('页面写入完整运动记录，视窗只处理改变占格的鱼，旧帧仍可读取', () => {
  const fishes = { a: { id: 'a', x: 5, y: 5, facing: 1 }, b: { id: 'b', x: 10, y: 5, facing: 1 } };
  const data = { fishes, scenes: {}, chars: {} };
  for (const id of Object.keys(fishes)) data.chars[id] = { id, kind: 'fish', entity: id, x: 0, y: 0 };
  const viewport = new ViewportCells(data), known = ['a', 'b'];
  function commit(tick, x) {
    const patch = expandSimulationPatch(data, { values: { tick }, tables: { fishes: {
      set: [0, 1], remove: [], motion: Float64Array.of(5, 5, 1, .5, 0, x, 5, 1, 0, .5)
    } } }, known, true);
    const frame = patch.tables.fishes.frame;
    frame.commit(fishes);
    viewport.update(patch.tables);
    assert.equal(frame.pairs, undefined);
    assert.deepEqual(frame.moved, [1]);
    return patch.tables.fishes;
  }
  const first = commit(500, 33);
  commit(1000, 65);
  assert.deepEqual(first.set.map(([id, f]) => [id, f.x, f.posAt]), [['a', 5, 500], ['b', 33, 500]]);
  assert.deepEqual(viewport.query(64, 66, 4, 6).map(cell => cell.id), ['b']);
  assert.equal(fishes.a.posAt, 1000);
});

test('跟随端连续合流时，五千条鱼的海域保留已绘制的鱼和点击位置', async () => {
  const { World, CONFIG } = await import('../www/engine.js');
  const { Renderer } = await import('../www/renderer.js');
  const now = Date.UTC(2025, 5, 15, 12, 17);
  const body = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3), ch: '鱼', color: '#8be7df' }));
  const world = makeFishWorld(World, 5000, CONFIG.width, { now, body, spacingX: 4, spacingY: 3, rows: 22 });
  const id = Object.keys(world.data.fishes)[4900], fish = world.data.fishes[id];
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    width: 200, height: 100, scale: 1, cell: 12, camera: { x: fish.x, y: fish.y }, ctx: {},
    glyph() {}, background() {}, weather() {}, eventHit() { return null; }
  });
  const index = renderer.cellIndex(world);
  index.advance(Infinity);
  renderer.draw(world);
  const stop = subscribeSimulationChanges((target, patch) => renderer.worldChanged(target, patch));
  try {
    for (let i = 1; i <= 4; i++) {
      const tick = now + i * 1000, x = fish.x + i % 2;
      world.merge({ protocol: 1, roots: world.data.roots, tick, chars: {}, scenes: {}, ops: {},
        fishes: { [id]: { ...fish, x, posAt: tick } } });
      renderer.draw(world);
      const pixel = renderer.screen(x, fish.y);
      assert.deepEqual(renderer.hit(pixel.x + 1, pixel.y + 1), { kind: 'fish', id });
      assert.equal(renderer.viewport, index);
      assert.equal(renderer.viewport.remaining, null);
    }
  } finally { stop(); }
});

test('鱼在同一分区游动或只有计时改变时，画面复用已经选出的鱼身', () => {
  const fish = { id: 'f', x: 30, y: 3, facing: 1 }, cell = { id: 'c', kind: 'fish', entity: 'f', x: 0, y: 0 };
  const data = { fishes: { f: fish }, chars: { c: cell }, scenes: {} }, index = new ViewportCells(data);
  const update = x => {
    data.fishes.f = { ...fish, x, posAt: 500 };
    index.update({ fishes: { set: [['f', data.fishes.f]], remove: [] } });
  };
  const result = index.query(31, 31, 3, 3);
  for (const x of [30, 31]) { update(x); assert.equal(index.query(31, 31, 3, 3), result); }
  update(32);
  assert.deepEqual(index.query(31, 31, 3, 3), []);
  assert.deepEqual(index.query(32, 32, 3, 3), [cell]);
});

test('整条鱼留在同一分区时免逐格更新，鱼体增长与重新合流后仍在正确的分区', () => {
  const body = (id, x, y = 0) => ({ id, kind: 'fish', entity: 'f', x, y });
  const data = { fishes: { f: { x: 12, y: 10, facing: 1 } }, scenes: {},
    chars: { a: body('a', -1), b: body('b', 1) } };
  const index = new ViewportCells(data);
  let placements = 0;
  const place = index.place.bind(index);
  index.place = entry => { placements++; place(entry); };
  const move = (x, y, facing) => {
    data.fishes.f = { x, y, facing };
    index.update({ fishes: { set: [['f', data.fishes.f]], remove: [] } });
  };
  function check() {
    const rebuilt = new ViewportCells(data);
    for (const x of [0, 32, 64, 960, 992]) for (const y of [0, 32]) {
      assert.deepEqual(index.query(x, x, y, y), rebuilt.query(x, x, y, y));
    }
  }
  move(13, 11, -1);
  assert.equal(placements, 0);
  move(12, 10, 1);
  data.chars.c = body('c', 19, 21);
  index.update({ chars: { set: [['c', data.chars.c]], remove: [] } });
  move(13, 11, 1);
  check();
  delete data.chars.c;
  index.update({ chars: { set: [], remove: ['c'] } });
  move(12, 10, 1);
  data.chars.a.x = 19;
  index.reconcile();
  move(13, 10, 1);
  check();
  for (const x of [991.9999999999999, 992, 999.5, 0, 1, 998]) {
    move(x, 31.5, -1);
    check();
  }
});

test('画面依次播放已结算的横移、下潜，海域接缝上点击跟随绘制位置', async () => {
  const { World } = await import('../www/engine.js');
  const { Renderer } = await import('../www/renderer.js');
  const world = new World(Date.now(), 'test', { populate: false, ambient: false });
  const fish = world.data.fishes.f = { id: 'f', x: 0, y: 11, facing: 1 };
  world.data.chars.c = { id: 'c', kind: 'fish', entity: 'f', x: 0, y: 0, ch: '鱼' };
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    width: 100, height: 100, scale: 1, cell: 10, camera: { x: 999, y: 10 }, ctx: {},
    glyph() {}, background() {}, weather() {}, eventHit() { return null; }
  });
  renderer.cellIndex(world);
  const swims = []; swims[8] = ['f'];
  renderer.worldChanged(world, { values: { tick: world.data.tick }, tables: {}, swims });
  const start = renderer.swimStart;
  renderer.draw(world, start + 125);
  assert.deepEqual(renderer.paintedFish.slice(0, 2), [55, 50]);
  assert.deepEqual(renderer.hit(56, 52), { kind: 'fish', id: 'f' });
  assert.equal(renderer.hit(65, 62), null);
  renderer.worldChanged(world, null);
  renderer.presentSwims(world, swims, start);
  renderer.draw(world, start + 375);
  assert.deepEqual(renderer.paintedFish.slice(0, 2), [60, 55]);
  assert.equal(renderer.fishPose(world, 'f', start + 501), fish);
  assert.deepEqual([fish.x, fish.y], [0, 11]);
  renderer.worldChanged(world, null);
  assert.equal(renderer.fishPose(world, 'f', start + 125), fish);
});

test('镜头跨海域接缝保留完整鱼体、点击顺序和移动后的占格', () => {
  const fish = { x: 999, y: 16, facing: 1 };
  const data = { fishes: { f: fish }, scenes: { s: { x: 0, y: 16 } }, chars: {
    a: { id: 'a', kind: 'fish', entity: 'f', x: 0, y: 0 },
    b: { id: 'b', kind: 'scene', entity: 's', x: 0, y: 0 },
    c: { id: 'c', kind: 'fish', entity: 'f', x: 1, y: 0 },
    d: { id: 'd', kind: 'food', x: 400, y: 16 }
  } };
  const index = new ViewportCells(data);
  const ids = (left, right) => index.query(left, right, 16, 16).map(cell => cell.id);
  assert.deepEqual(ids(997, 1002), ['a', 'b', 'c']);
  assert.deepEqual(ids(-1, 1), ['a', 'b', 'c']);
  fish.x = 490;
  index.update({ fishes: { set: [['f', fish]], remove: [] } });
  assert.deepEqual(ids(997, 1002), ['b']);
  assert.deepEqual(ids(490, 490), ['a', 'c']);
  const regrown = data.chars.a = { id: 'a', kind: 'seaweed', x: 0, y: 15 };
  delete data.chars.b;
  index.update({ chars: { set: [['a', regrown]], remove: ['b'] } });
  assert.deepEqual(ids(0, 0), ['a']);
  assert.deepEqual(index.fishCells('f').map(cell => cell.id), ['c']);
  delete data.fishes.f;
  index.update({ fishes: { set: [], remove: ['f'] } });
  assert.deepEqual(ids(490, 490), []);
});

test('合流索引按最终字符表同步原地变化、热行增删和绘制顺序', () => {
  const data = { fishes: { f: { x: 32, y: 10, facing: 1 } }, scenes: { s: { x: 45, y: 10 } }, chars: {
    2: { id: '2', kind: 'food', x: 30, y: 10 },
    a: { id: 'a', kind: 'fish', entity: 'f', x: 0, y: 0 },
    b: { id: 'b', kind: 'fish', entity: 'f', x: 1, y: 0 },
    gone: { id: 'gone', kind: 'scene', entity: 's', x: 0, y: 0 }
  } };
  const index = new ViewportCells(data), ids = (left, right) => index.query(left, right, 10, 10).map(cell => cell.id);
  assert.deepEqual(ids(30, 30), ['2']);
  assert.deepEqual(ids(32, 32), ['a', 'b', 'gone']);
  data.chars[2].x = 32;
  Object.assign(data.chars.a, { kind: 'food', entity: '', x: 35, y: 10 });
  data.fishes.f.x = 64;
  delete data.chars.gone;
  data.chars[1] = { id: '1', kind: 'scene', entity: 's', x: 0, y: 0 };
  index.reconcile();
  assert.deepEqual(ids(30, 30), []);
  assert.deepEqual(ids(32, 32), ['1', '2', 'a']);
  assert.deepEqual(ids(64, 64), ['b']);
  assert.deepEqual(index.fishCells('f').map(cell => cell.id), ['b']);
});

test('合流后绘制前仍可选中上一帧的鱼，水面候选只来自当前完整索引', async () => {
  const { World } = await import('../www/engine.js');
  const { Renderer } = await import('../www/renderer.js');
  const world = new World(Date.now(), 'test', { populate: false, ambient: false });
  world.data.fishes.f = { id: 'f', x: 10, y: 0, facing: 1 };
  world.data.chars.c = { id: 'c', kind: 'fish', entity: 'f', x: 0, y: 0, ch: '鱼' };
  const renderer = Object.assign(Object.create(Renderer.prototype), {
    width: 100, height: 100, scale: 1, cell: 10, camera: { x: 10, y: 0 }, ctx: {},
    glyph() {}, background() {}, weather() {}, eventHit() { return null; }
  });
  renderer.cellIndex(world);
  assert.equal(world.surfaceCandidates(10), undefined);
  renderer.draw(world);
  assert(world.surfaceCandidates(10).includes(world.data.chars.c));
  assert.equal(world.surfaceBlocked(10), true);
  assert.equal(world.surfaceBlocked(11), false);
  renderer.worldChanged(world, null);
  assert.equal(world.surfaceCandidates(10), undefined);
  world.data.fishes.f.x = 20;
  renderer.worldChanged(world, { values: {}, tables: {} });
  assert.equal(world.surfaceCandidates(10), undefined);
  renderer.camera.x = 20;
  assert.equal(world.surfaceBlocked(10), false);
  assert.equal(world.surfaceBlocked(20), true);
  assert.deepEqual(renderer.hit(50, 50), { kind: 'fish', id: 'f' });
  renderer.draw(world);
  assert.deepEqual(renderer.hit(50, 50), { kind: 'fish', id: 'f' });
  world.data.fishes.g = { id: 'g', x: 21, y: 0, facing: 1 };
  world.data.chars.c.entity = 'g';
  renderer.worldChanged(world, null);
  assert.equal(renderer.hit(50, 50), null);
  renderer.draw(world);
  assert.deepEqual(renderer.hit(61, 50), { kind: 'fish', id: 'g' });
  delete world.data.chars.c;
  assert.equal(renderer.hit(61, 50), null);
  const next = new World(Date.now(), 'other', { populate: false, ambient: false });
  renderer.draw(next);
  assert.equal(world.surfaceCandidates?.(10), undefined);
  assert.equal(renderer.hit(50, 50), null);
});

test('追随端提交合流后，鱼体换主人、食物沉积和跨接缝镜头的索引与整表重建一致', async () => {
  const { World } = await import('../www/engine.js');
  const { Renderer } = await import('../www/renderer.js');
  const now = Date.now(), world = new World(now, 'test', { populate: false, ambient: false });
  const runtime = Object.assign(Object.create(Renderer.prototype), {
    width: 120, height: 100, scale: 1, cell: 10, camera: { x: 998, y: 10 }, ctx: {},
    glyph() {}, background() {}, weather() {}, eventHit() { return null; }
  });
  const fish = (id, x) => ({ id, x, y: 10, facing: 1, created: now, hungerAt: now + 86400000, posAt: now });
  const cell = (id, entity, x) => ({ id, kind: 'fish', entity, x, y: 0, ch: '鱼', path: [], moveAt: now });
  world.data.fishes.f = fish('f', 999);
  world.data.fishes.g = fish('g', 200);
  Object.assign(world.data.chars, { a: cell('a', 'f', 0), b: cell('b', 'f', 1), c: cell('c', 'f', 2),
    d: cell('d', 'g', 0), e: cell('e', 'g', 1), food: { id: 'food', kind: 'food', entity: '', x: 997, y: 10, ch: '食', path: [], moveAt: now } });
  runtime.draw(world);
  const index = runtime.currentIndex(world), tick = now + 500;
  const move = (id, x) => ({ ...world.data.fishes[id], x, posAt: tick });
  const incoming = { protocol: 1, tick, roots: world.data.roots, ops: {}, fishes: { f: move('f', 1), g: move('g', 999) },
    scenes: { s: { id: 's', x: 100, y: 38, posAt: tick } },
    chars: { b: { ...world.data.chars.b, entity: 'g', x: 2, moveAt: tick },
      food: { ...world.data.chars.food, kind: 'scene', entity: 's', x: 0, y: 0, moveAt: tick },
      plant: { id: 'plant', kind: 'seaweed', entity: '', x: 220, y: 45, ch: '草', path: [], moveAt: tick } } };
  runtime.worldChanged(world, null);
  const changed = world.merge(incoming, {}, 'replica', true);
  runtime.applyMergedChars(world, index, changed.chars);
  const reference = new ViewportCells(world.data);
  const rows = items => items.map(item => [item.id, item.kind, item.entity, item.x, item.y]);
  for (const [left, right, top, bottom] of [[-1, 2, 0, 31], [996, 1002, 0, 31], [91, 125, 32, 57], [210, 240, 32, 57]]) {
    assert.deepEqual(rows(index.query(left, right, top, bottom)), rows(reference.query(left, right, top, bottom)));
  }
  assert.deepEqual(rows(index.fishCells('g')).map(row => row[0]).sort(), ['b', 'd', 'e']);
  runtime.camera.x = 999;
  runtime.draw(world);
  assert.deepEqual(runtime.hit(71, 51), { kind: 'fish', id: 'g' });
});

test('旧存档合流新增整数键时，画面沿用实际字符顺序', async () => {
  const { World } = await import('../www/engine.js');
  const now = Date.now(), world = new World(now, 'test', { populate: false, ambient: false });
  const food = id => ({ id, kind: 'food', entity: '', x: 20, y: 5, path: [] });
  world.data.chars[2] = food('2');
  const index = new ViewportCells(world.data);
  const incoming = { protocol: 1, tick: now + 500, roots: world.data.roots, ops: {}, fishes: {}, scenes: {}, chars: { 1: food('1') } };
  const changes = world.merge(incoming, {}, 'replica', true);
  if (changes.chars) index.reconcileMerge(changes.chars); else index.reconcile();
  assert.deepEqual(index.query(20, 20, 5, 5).map(cell => cell.id), ['1', '2']);
});
