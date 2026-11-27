import assert from 'node:assert/strict';
import test from 'node:test';
import { World, key } from '../www/engine.js';
import { compileHull, fitsHullAt, sweepsHullAt } from '../www/motion-hull.js';

test('逐行转身和占位与逐鱼元判定一致，包括越界、重叠、食物和鱼体内部空隙', () => {
  const world = new World(100, 'test', { populate: false });
  const shapes = [
    [[-2, 0], [-1, -1], [0, 0], [1, 1], [2, 1]],
    [[0, 0], [0, 0]],
    [[0, 0], [5, 0], [4, 1]]
  ].map(body => body.map(([x, y]) => ({ x, y })));
  for (const facing of [-1, 1]) for (const cells of shapes) {
    const hull = compileHull(cells), grid = world.movementGrid(new Map());
    for (const base of [0, 123, 999]) for (const depth of [0, 23, world.floorAt(base) - 1]) {
      const pose = { id: 'a', x: base, y: depth, facing };
      for (const obstacle of ['scene', 'food', 'grass', 'fish', 'pair', 'overlap']) {
        for (let i = -5; i <= 5; i++) {
          const x = base + i, y = depth + i % 2, k = key(x, y);
          const scenery = new Map(), food = new Set(), grass = [], owners = new Map();
          if (obstacle === 'scene') scenery.set(k, {});
          if (obstacle === 'grass') grass.push({ kind: 'seaweed', x: Number(k.split(',')[0]), y });
          if (obstacle === 'food' || grass.length) food.add(k);
          if (['fish', 'pair', 'overlap'].includes(obstacle)) {
            const ids = obstacle === 'overlap' ? ['a', 'b', 'c'] : ['b'];
            for (const id of ids) grid.add(x, y, id);
            owners.set(k, new Set(ids));
          }
          world.data.breeding.a = obstacle === 'pair' ? { status: 'active', male: 'a', female: 'b' } : undefined;
          grid.prepareMovement(world.data, scenery, food, grass);
          const expectedFit = world.canOccupy(pose, cells, scenery, owners, food);
          assert.equal(world.canOccupy(pose, cells, scenery, grid, food, hull), expectedFit, JSON.stringify({ pose, cells, obstacle, x, y }));
          const turning = new Map(scenery);
          if (grass.length) turning.set(k, {});
          const a = { ...pose }, b = { ...pose };
          const expectedTurn = world.turn(b, cells, turning, owners);
          assert.equal(world.turn(a, cells, turning, grid, hull.bounds, hull), expectedTurn, JSON.stringify({ pose, cells, obstacle, x, y }));
          assert.deepEqual(a, b);
          if (obstacle !== 'pair') {
            const slot = grid.slot(pose.id);
            assert.equal(fitsHullAt(hull, pose.x, pose.y, facing, grid, slot), expectedFit);
            assert.equal(sweepsHullAt(hull, pose.x, pose.y, facing, grid, slot), expectedTurn);
          }
          grid.clear(x, y);
        }
      }
    }
  }
  assert.equal(compileHull([{ x: .25, y: 1 }]), null);
  assert.equal(compileHull([{ x: -501, y: 0 }, { x: 499, y: 0 }]), null);
});
