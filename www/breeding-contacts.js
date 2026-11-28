import { WORLD_WIDTH, deltaX, nearX, worldKey } from './geography.js';
import { ContactField } from './contact-field.js';
import { ECOLOGY, breedingThreshold, contactTime, densityField, densityScale } from './ecology.js';

const glyphOrders = new WeakMap();
const namedBodies = new WeakMap();

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

function waitingTime(field, density, grid, father, mother, scenery) {
  const layout = grid.layout, groups = layout.groups;
  const fatherCells = groups.get(father.id), motherCells = groups.get(mother.id);
  const maleHull = layout.hull(fatherCells), femaleHull = layout.hull(motherCells);
  const male = glyphOrder(fatherCells, false, maleHull), female = glyphOrder(motherCells, true, femaleHull);
  if (Number.isSafeInteger(father.x) && Number.isSafeInteger(mother.x) &&
      Math.abs(father.x) <= 2 * WORLD_WIDTH && Math.abs(mother.x) <= 2 * WORLD_WIDTH &&
      Math.abs(father.facing) === 1 && Math.abs(mother.facing) === 1) {
    const cell = field.midpoint(father, mother, male, female);
    return cell < 0 ? Infinity : contactTime(density(cell % WORLD_WIDTH, Math.floor(cell / WORLD_WIDTH)));
  }
  // Older positions outside the integer sea retain their floating-point midpoint arithmetic.
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
  const field = new ContactField(grid, sex, scenery);
  if (!field.hasNeighbors()) return true;
  const density = world.ambient ? densityField(world, scenery, grid.cells, field) : undefined;
  const candidates = field.candidates(ECOLOGY.radius, densityScale, breedingThreshold.numerator, breedingThreshold.denominator);
  for (const pair of candidates) {
    const male = grid.owners[Math.floor(pair / count)], female = grid.owners[pair % count];
    const wait = density && waitingTime(field, density, grid, world.readFish(male), world.readFish(female), scenery);
    if (wait !== Infinity) pairs.set(male + '|' + female, { male, female, wait });
  }
  return true;
}
