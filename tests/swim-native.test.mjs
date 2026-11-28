import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { World } from '../www/engine.js';
import { compileHull } from '../www/motion-hull.js';
import { packedGrid, singlePose, swimOne } from '../www/swim-kernel.js';

test('配送的游动程序由当前源码生成', async () => {
  const load = name => readFile(new URL(name, import.meta.url), 'utf8');
  const source = (await load('../native/swimming.c')).replaceAll('\r\n', '\n');
  const hash = createHash('sha256').update(source).digest('hex');
  assert((await load('../www/swim-program.js')).split('\n')[0].trimEnd().endsWith(' SHA-256 ' + hash),
    '修改游动规则后请运行 node scripts/build-swimming.mjs 重建浏览器产物');
});

test('旧小数位置保留负零，失败的转身保留原朝向并尝试避让', () => {
  const fish = { x: 2.25, y: -0, facing: 1, cx: 0, cy: 0 };
  const fits = (x, y) => x === 2.25 && y === 1;
  const path = swimOne(fish, 3.25, 0.5, 2, 2, { dx: -1, dy: 0 }, 0, true, { turns: () => false, fits });
  assert.deepEqual([...singlePose], [2.25, 1, 1, 0, 0]);
  assert.equal(path, 7);
  assert.equal(swimOne(fish, 3.25, 0.5, 2, 2, { dx: -1, dy: 0 }, 0, false, { turns: () => false, fits }), 4 | 16);
  assert(Object.is(singlePose[1], -0));
  assert.equal(singlePose[0], 2.25);
});

test('游动表扩容后保留即时占格，跨海界的下一条鱼能看见前一条', () => {
  const world = new World(100, 'test', { populate: false });
  const shape = [{ x: 0, y: 0 }], hull = compileHull(shape);
  const east = { id: 'east', x: 999, y: 10, facing: 1 };
  const west = { id: 'west', x: 1, y: 10, facing: -1 };
  const grid = world.movementGrid(new Map());
  grid.update(east, shape);
  grid.update(west, shape);
  grid.prepareMovement(world.data, new Map(), new Set(), []);
  const first = packedGrid(grid, 1);
  const large = packedGrid(grid, 10000);
  assert.equal(first, large);
  for (const [i, fish] of [east, west].entries()) {
    large.put(i, { hull, fish, slot: grid.slot(fish.id), speedX: 2, speedY: 2 }, { dx: fish.facing, dy: 0 }, 0);
  }
  large.advance(2, 0.5);
  assert.deepEqual([...grid.get(0, 10)], ['east']);
  assert.deepEqual([...grid.get(1, 9)], ['west']);
  assert.equal(grid.get(999, 10), undefined);
});
