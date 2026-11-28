import { WORLD_WIDTH, deltaX, nearX, worldKey } from './geography.js';
import { contactTime, densityField } from './ecology.js';

const indexedLayouts = new WeakMap();
const glyphOrders = new WeakMap();

function gridBodies(layout) {
  if (!indexedLayouts.has(layout)) {
    // Geometric traversal may encounter tied pairs in a different order.
    // Keep the record traversal for identifiers with locale-equivalent spellings.
    let usable = true;
    for (const [id, cells] of layout.groups) {
      const hull = layout.hull(cells);
      if (!/^[\w:-]+$/.test(id) || !hull?.namedCells || hull.duplicate) { usable = false; break; }
    }
    indexedLayouts.set(layout, usable);
  }
  return indexedLayouts.get(layout);
}

function glyphOrder(layout, cells, mother) {
  const hull = layout.hull(cells);
  let orders = glyphOrders.get(hull);
  if (!orders) glyphOrders.set(hull, orders = {});
  const side = mother ? 'mother' : 'father';
  // Male contact uses the ordinal minimum ID. Mothers use the first ID in locale order.
  return orders[side] ??= cells.map(({ x, y, id }) => ({ x, y, id })).sort(mother
    ? (a, b) => a.id.localeCompare(b.id) : (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function waitingTime(density, grid, father, mother, scenery) {
  const layout = grid.layout, groups = layout.groups;
  const fatherCells = glyphOrder(layout, groups.get(father.id), false);
  const motherCells = glyphOrder(layout, groups.get(mother.id), true);
  for (const male of fatherCells) {
    const x = father.x + father.facing * male.x, y = father.y + male.y;
    for (const female of motherCells) {
      const qy = mother.y + female.y, dy = qy - y;
      if (Math.abs(dy) > 1) continue;
      const qx = mother.x + mother.facing * female.x, dx = deltaX(qx, x);
      if (Math.abs(dx) > 1 || !dx && !dy) continue;
      if (dx && dy && (scenery.has(worldKey(x, qy)) || scenery.has(worldKey(qx, y)))) continue;
      return contactTime(density((x + nearX(qx, x)) / 2, (y + qy) / 2));
    }
  }
  return Infinity;
}

// Every adjacent pair on an integer grid belongs to exactly one rounded midpoint.
// Visit the horizontal, vertical and two diagonal edges at that midpoint. A pair
// with several edges still takes its waiting time from its canonical touching glyphs.
export function collectGridPairs(world, grid, scenery, roster, taken, captured, pairs) {
  const { males, females, probeCount } = roster;
  if (!males.length || !females.size || !grid?.integerCells || !grid.cells || grid.overlapped ||
      grid.fractional?.size || probeCount < grid.cells.length || !gridBodies(grid.layout)) return false;
  if (roster.grid !== grid) {
    roster.grid = grid;
    roster.sex = new Uint8Array(grid.owners.length);
    for (const fish of males) roster.sex[grid.slots.get(fish.id)] = 1;
    for (const id of females) roster.sex[grid.slots.get(id)] = 2;
  }
  const sex = taken.size || captured.size ? roster.sex.slice() : roster.sex, count = sex.length;
  for (const id of taken) sex[grid.slots.get(id)] = 0;
  for (const id of captured) sex[grid.slots.get(id)] = 0;
  const candidates = new Set();
  function add(a, b) {
    if ((sex[a] | sex[b]) === 3) candidates.add(sex[a] === 1 ? a * count + b : b * count + a);
  }
  let density;
  const cells = grid.cells;
  for (let row = 0, y = 0; row < cells.length; row += WORLD_WIDTH, y++) {
    let left = cells[row + WORLD_WIDTH - 1], diagonal = y ? cells[row - 1] : 0;
    for (let x = 0; x < WORLD_WIDTH; x++) {
      const here = cells[row + x], up = y ? cells[row + x - WORLD_WIDTH] : 0;
      if ((sex[here] | sex[left] | sex[up] | sex[diagonal]) === 3) {
        if (world.ambient) density ??= densityField(world, scenery, cells);
        if (!density || density.allowsBreedingAt(x, y)) {
          add(left, here);
          add(up, here);
          if ((sex[diagonal] | sex[here]) === 3 && !scenery.has(worldKey(x - 1, y)) && !scenery.has(worldKey(x, y - 1))) add(diagonal, here);
          if ((sex[left] | sex[up]) === 3 && !scenery.has(worldKey(x - 1, y - 1)) && !scenery.has(worldKey(x, y))) add(left, up);
        }
      }
      left = here;
      diagonal = up;
    }
  }
  for (const pair of candidates) {
    const male = grid.owners[Math.floor(pair / count)], female = grid.owners[pair % count];
    const wait = density && waitingTime(density, grid, world.readFish(male), world.readFish(female), scenery);
    if (wait !== Infinity) pairs.set(male + '|' + female, { male, female, wait });
  }
  return true;
}
