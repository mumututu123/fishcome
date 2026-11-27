import { WORLD_WIDTH, MAX_FLOOR } from './geography.js';

export class BodyLayout {
  constructor(groups) {
    this.groups = groups;
    this.hulls = new WeakMap();
  }
  get ordered() {
    return this.byId ??= [...this.groups].sort(([a], [b]) => a.localeCompare(b));
  }
  hull(cells) {
    let shape = this.hulls.get(cells);
    if (shape === undefined) {
      shape = compileHull(cells);
      this.hulls.set(cells, shape);
    }
    return shape;
  }
}

export function obstacleMask(scenery, foods, weeds, mask = new Uint8Array(WORLD_WIDTH * MAX_FLOOR)) {
  function mark(x, y, flags) {
    if (Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < MAX_FLOOR) mask[y * WORLD_WIDTH + x] |= flags;
  }
  for (const [records, flags] of [[scenery, 3], [foods, 1]]) for (const position of records.keys()) {
    const comma = position.indexOf(',');
    mark(Number(position.slice(0, comma)), Number(position.slice(comma + 1)), flags);
  }
  for (const weed of weeds) if (weed.kind === 'seaweed') mark(((weed.x % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH, weed.y, 2);
  return mask;
}

// A body turns about the same vertical axis on every row. Each cell sweeps
// across that axis, so all its row's swept intervals form one interval.
export function compileHull(cells) {
  const xy = [], rows = new Map(), used = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, duplicate = false, namedCells = true;
  for (const cell of cells) {
    const { x, y } = cell;
    if (typeof cell.id !== 'string' || used.has(cell.id)) namedCells = false;
    else used.add(cell.id);
    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) >= WORLD_WIDTH || Math.abs(y) > MAX_FLOOR) return null;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    xy.push(x, y);
    const key = y * (2 * WORLD_WIDTH) + x;
    if (used.has(key)) duplicate = true;
    used.add(key);
    const row = rows.get(y);
    if (row) { row[0] = Math.min(row[0], x); row[1] = Math.max(row[1], x); }
    else rows.set(y, [x, x]);
  }
  if (maxX - minX >= WORLD_WIDTH) return null;
  const sweep = [];
  for (const [y, [left, right]] of rows) {
    const first = Math.min(left, minX + maxX - right);
    sweep.push(first, minX + maxX - first, y);
  }
  return { xy, sweep, duplicate, namedCells, bounds: { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}
export function fitsHull(hull, fish, grid, pair) {
  if (hull.duplicate) return false;
  const { x, y, facing, id } = fish, { xy } = hull;
  for (let i = 0; i < xy.length; i += 2) {
    if (!grid.clearCell(x + facing * xy[i], y + xy[i + 1], id, pair, 1)) return false;
  }
  return true;
}
export function sweepsHull(hull, fish, grid, pair) {
  if (hull.duplicate) return false;
  const { x, y, facing, id } = fish, { sweep } = hull;
  for (let i = 0; i < sweep.length; i += 3) {
    const row = y + sweep[i + 2];
    for (let j = sweep[i]; j <= sweep[i + 1]; j++) if (!grid.clearCell(x + facing * j, row, id, pair, 2)) return false;
  }
  return true;
}

export function fitsHullAt({ xy, duplicate, bounds }, x, y, facing, grid, slot) {
  if (duplicate || y + bounds.minY < 0 || y + bounds.maxY >= MAX_FLOOR) return false;
  const { cells, obstacles } = grid;
  for (let i = 0; i < xy.length; i += 2) {
    let column = x + facing * xy[i];
    const row = y + xy[i + 1];
    if (column < 0 || column >= WORLD_WIDTH) column = ((column % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
    const index = row * WORLD_WIDTH + column, owner = cells[index];
    if ((owner && owner !== slot) || (obstacles[index] & 1)) return false;
  }
  return true;
}

export function sweepsHullAt({ sweep, duplicate, bounds }, x, y, facing, grid, slot) {
  if (duplicate || y + bounds.minY < 0 || y + bounds.maxY >= MAX_FLOOR) return false;
  const { cells, obstacles } = grid;
  for (let i = 0; i < sweep.length; i += 3) {
    const row = y + sweep[i + 2];
    for (let j = sweep[i]; j <= sweep[i + 1]; j++) {
      let column = x + facing * j;
      if (column < 0 || column >= WORLD_WIDTH) column = ((column % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
      const index = row * WORLD_WIDTH + column, owner = cells[index];
      if ((owner && owner !== slot) || (obstacles[index] & 2)) return false;
    }
  }
  return true;
}
