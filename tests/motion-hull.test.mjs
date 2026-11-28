import assert from 'node:assert/strict';
import test from 'node:test';
import { World, key } from '../www/engine.js';
import { motionOrder } from '../www/breeding.js';
import { BodyLayout, compileHull, fitsHullAt, sweepsHullAt } from '../www/motion-hull.js';

test('亲鱼跨海界平移、转身、被分开或恢复旧小数位置，联合鱼体始终与重新摆放相同', () => {
  const world = new World(100, 'test', { populate: false });
  const male = { id: 'a' }, female = { id: 'b' };
  world.data.fishes = { a: male, b: female };
  world.data.breeding = { pair: { id: 'pair', status: 'active', male: 'a', female: 'b', started: 100, motion: { cx: 0, cy: 0 } } };
  const groups = new Map([
    ['a', [{ id: 'eye', ch: 'O', x: -1, y: 0 }, { id: 'tail', ch: '鱼', x: 1, y: 1 }]],
    ['b', [{ id: 'brow', ch: '头', x: 0, y: -1 }]]
  ]);
  const layout = new BodyLayout(groups), roster = [male, female];
  world.stableFishRoster = () => roster;
  const fresh = { data: world.data };
  for (const [mx, my, mf, fx, fy, ff] of [
    [998, 50, 1, 1, 50, 1], [999, 51, 1, 2, 51, 1], [0, 52, 1, 3, 52, 1],
    [10, 51, -1, 7, 51, -1], [11, 51, -1, 500, 52, 1], [10.3, 51.25, -1, 8.4, 52.25, 1],
    [12, 50, 1, 15, 50, 1]
  ]) {
    Object.assign(male, { x: mx, y: my, facing: mf });
    Object.assign(female, { x: fx, y: fy, facing: ff });
    assert.deepEqual(motionOrder(world, groups, layout), motionOrder(fresh, groups, new BodyLayout(groups)));
  }
});

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
