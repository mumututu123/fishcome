import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportCells } from '../www/viewport.js';

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

test('索引重建期间仍可选中画面上的鱼，水面候选只来自当前完整索引', async () => {
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
  world.dirty = true;
  renderer.worldChanged(world, null);
  assert.equal(world.surfaceCandidates(10), undefined);
  world.data.fishes.f.x = 20;
  renderer.camera.x = 20;
  assert.equal(world.surfaceBlocked(10), false);
  assert.equal(world.surfaceBlocked(20), true);
  assert.deepEqual(renderer.hit(50, 50), { kind: 'fish', id: 'f' });
  renderer.draw(world);
  assert.deepEqual(renderer.hit(50, 50), { kind: 'fish', id: 'f' });
  delete world.data.chars.c;
  assert.equal(renderer.hit(50, 50), null);
  const next = new World(Date.now(), 'other', { populate: false, ambient: false });
  renderer.draw(next);
  assert.equal(world.surfaceCandidates?.(10), undefined);
  assert.equal(renderer.hit(50, 50), null);
});
