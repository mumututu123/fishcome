import { WORLD_WIDTH, deltaX, nearX, worldKey } from './geography.js';
import { contactTime, densityField } from './ecology.js';

const glyphOrders = new WeakMap();
const namedBodies = new WeakMap();
const relativeContacts = new WeakMap();

export function hasNamedGlyphs(cells) {
  let named = namedBodies.get(cells);
  if (named === undefined) {
    const ids = new Set();
    named = cells.every(({ id }) => {
      if (typeof id !== 'string' || ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    namedBodies.set(cells, named);
  }
  return named;
}

function gridBodies(layout) {
  if (layout.checkedContacts === undefined) {
    // Geometric traversal may encounter tied pairs in a different order.
    // Keep the record traversal for identifiers with locale-equivalent spellings.
    let usable = true;
    const changed = layout.reshaped;
    const ids = changed?.checkedContacts ? changed.ids : layout.groups.keys();
    for (const id of ids) {
      const cells = layout.groups.get(id);
      const hull = layout.hull(cells);
      if (!/^[\w:-]+$/.test(id) || !hull || hull.duplicate || !hasNamedGlyphs(cells)) { usable = false; break; }
    }
    layout.checkedContacts = usable;
  }
  return layout.checkedContacts;
}

function glyphOrder(cells, mother, hull) {
  let orders = glyphOrders.get(cells);
  if (!orders) glyphOrders.set(cells, orders = {});
  const side = mother ? 'mother' : 'father';
  // Male contact uses the ordinal minimum ID. Mothers use the first ID in locale order.
  if (!orders[side]) {
    const order = cells.slice().sort(mother
      ? (a, b) => a.id.localeCompare(b.id) : (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const xy = hull.xy;
    orders[side] = order.every((c, i) => c.x === xy[2 * i] && c.y === xy[2 * i + 1]) ? xy : order.flatMap(c => [c.x, c.y]);
  }
  return orders[side];
}

function contactOffsets(father, mother, x, y, facing, motherFacing) {
  const edges = [];
  for (let i = 0; i < father.length; i += 2) {
    const px = facing * father[i], py = father[i + 1];
    for (let j = 0; j < mother.length; j += 2) {
      const dy = y + mother[j + 1] - py;
      if (Math.abs(dy) > 1) continue;
      const dx = deltaX(x + motherFacing * mother[j], px);
      if (Math.abs(dx) > 1 || !dx && !dy) continue;
      edges.push(px, py, dx, dy);
      if (!dx || !dy) return edges;
    }
  }
  return edges;
}

function waitingTime(density, grid, father, mother, scenery) {
  const layout = grid.layout, groups = layout.groups;
  const fatherCells = groups.get(father.id), motherCells = groups.get(mother.id);
  const maleHull = layout.hull(fatherCells), femaleHull = layout.hull(motherCells);
  const male = glyphOrder(fatherCells, false, maleHull), female = glyphOrder(motherCells, true, femaleHull);
  if (male === maleHull.xy && female === femaleHull.xy && Math.abs(father.x) <= 2 * WORLD_WIDTH && Math.abs(mother.x) <= 2 * WORLD_WIDTH &&
      Math.abs(father.facing) === 1 && Math.abs(mother.facing) === 1) {
    let byMother = relativeContacts.get(maleHull);
    if (!byMother) relativeContacts.set(maleHull, byMother = new WeakMap());
    let plans = byMother.get(femaleHull);
    if (!plans) byMother.set(femaleHull, plans = new Map());
    const x = deltaX(mother.x, father.x), y = mother.y - father.y;
    const key = (y * WORLD_WIDTH + x) * 4 + Number(father.facing === 1) * 2 + Number(mother.facing === 1);
    let edges = plans.get(key);
    if (!edges) plans.set(key, edges = contactOffsets(male, female, x, y, father.facing, mother.facing));
    for (let i = 0; i < edges.length; i += 4) {
      const px = father.x + edges[i], py = father.y + edges[i + 1], dx = edges[i + 2], dy = edges[i + 3];
      if (dx && dy && (scenery.has(worldKey(px, py + dy)) || scenery.has(worldKey(px + dx, py)))) continue;
      return contactTime(density(px + dx / 2, py + dy / 2));
    }
    return Infinity;
  }
  for (let i = 0; i < male.length; i += 2) {
    const x = father.x + father.facing * male[i], y = father.y + male[i + 1];
    for (let j = 0; j < female.length; j += 2) {
      const qy = mother.y + female[j + 1], dy = qy - y;
      if (Math.abs(dy) > 1) continue;
      const qx = mother.x + mother.facing * female[j], dx = deltaX(qx, x);
      if (Math.abs(dx) > 1 || !dx && !dy) continue;
      if (dx && dy && (scenery.has(worldKey(x, qy)) || scenery.has(worldKey(qx, y)))) continue;
      return contactTime(density((x + nearX(qx, x)) / 2, (y + qy) / 2));
    }
  }
  return Infinity;
}

export function indexContactBodies(grid, roster) {
  const { males, females, probeCount } = roster;
  if (!males.length || !females.size || !grid?.integerCells || !grid.cells || grid.overlapped ||
      grid.fractional?.size || probeCount < grid.cells.length || !gridBodies(grid.layout)) return false;
  if (roster.grid !== grid) {
    roster.grid = grid;
    roster.sex = new Uint8Array(grid.owners.length);
    for (const fish of males) roster.sex[grid.slots.get(fish.id)] = 1;
    for (const id of females) roster.sex[grid.slots.get(id)] = 2;
  }
  return true;
}

// Every adjacent pair on an integer grid belongs to exactly one rounded midpoint.
// Visit the horizontal, vertical and two diagonal edges at that midpoint. A pair
// with several edges still takes its waiting time from its canonical touching glyphs.
export function collectGridPairs(world, grid, scenery, roster, taken, captured, pairs) {
  if (!indexContactBodies(grid, roster)) return false;
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
