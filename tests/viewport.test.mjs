import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportCells } from '../www/viewport.js';
import { makeFishWorld } from './capacity-fish.mjs';
import { subscribeSimulationChanges } from '../www/simulation-changes.js';

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
