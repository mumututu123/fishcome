import { WORLD_WIDTH, MAX_FLOOR } from './geography.js';

export class BodyLayout {
  constructor(groups, hulls = new WeakMap(), geometries = new Map()) {
    this.groups = groups;
    this.hulls = hulls;
    this.geometries = geometries;
  }
  get ordered() {
    return this.byId ??= [...this.groups].sort(([a], [b]) => a.localeCompare(b));
  }
  updated(groups, changed) {
    const layout = new BodyLayout(groups, this.hulls, this.geometries);
    if (layout.geometries.size >= layout.geometryLimit) layout.pruneGeometries();
    layout.school = this.school;
    if (!changed || !this.byId || [...changed].some(id => groups.has(id) && !this.groups.has(id))) return layout;
    // A locale may collate two different legacy names equally. Their tie order
    // follows the first glyph in the table and must be sorted again after edits.
    this.distinctOrder ??= this.byId.every(([id], i) => !i || this.byId[i - 1][0].localeCompare(id) !== 0);
    if (this.distinctOrder) {
      layout.distinctOrder = true;
      layout.byId = [];
      for (const row of this.byId) {
        if (!changed.has(row[0])) layout.byId.push(row);
        else if (groups.has(row[0])) layout.byId.push([row[0], groups.get(row[0])]);
      }
    }
    return layout;
  }
  hull(cells) {
    let shape = this.hulls.get(cells);
    if (shape === undefined) {
      const xy = readCoordinates(cells);
      shape = null;
      if (xy) {
        const signature = xy.map(value => Object.is(value, -0) ? '-0' : value).join(',');
        shape = this.geometries.get(signature);
        if (!shape) {
          shape = buildHull(xy);
          if (shape) {
            if (this.geometries.size >= this.geometryLimit) this.pruneGeometries();
            shape.signature = signature;
            this.geometries.set(signature, shape);
          }
        }
      }
      this.hulls.set(cells, shape);
    }
    return shape;
  }
  get geometryLimit() { return 2 * Math.max(1, this.groups.size); }
  pruneGeometries() {
    // An old movement grid can still read its bodies through the weak cache.
    this.geometries.clear();
    for (const cells of this.groups.values()) {
      const shape = this.hulls.get(cells);
      if (shape) this.geometries.set(shape.signature, shape);
    }
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

function readCoordinates(cells) {
  const xy = [];
  for (const { x, y } of cells) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) >= WORLD_WIDTH || Math.abs(y) > MAX_FLOOR) return null;
    xy.push(x, y);
  }
  return xy;
}
export function compileHull(cells) {
  const xy = readCoordinates(cells);
  return xy && buildHull(xy);
}

// A body turns about the same vertical axis on every row. Each cell sweeps
// across that axis, so all its row's swept intervals form one interval.
function buildHull(xy) {
  const rows = new Map(), used = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, duplicate = false;
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i], y = xy[i + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
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
  const offsetsRight = [], offsetsLeft = [];
  for (let i = 0; i < xy.length; i += 2) {
    offsetsRight.push(xy[i + 1] * WORLD_WIDTH + xy[i]);
    offsetsLeft.push(xy[i + 1] * WORLD_WIDTH - xy[i]);
  }
  return { xy, sweep, duplicate, offsetsRight, offsetsLeft, moveEdges: [],
    bounds: { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } };
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

export function fitsHullAt({ xy, duplicate, bounds, offsetsRight, offsetsLeft }, x, y, facing, grid, slot) {
  if (duplicate || y + bounds.minY < 0 || y + bounds.maxY >= MAX_FLOOR) return false;
  const { cells, obstacles } = grid;
  const left = facing === 1 ? bounds.minX : -bounds.maxX, right = facing === 1 ? bounds.maxX : -bounds.minX;
  if (x + left >= 0 && x + right < WORLD_WIDTH) {
    const offsets = facing === 1 ? offsetsRight : offsetsLeft, origin = y * WORLD_WIDTH + x;
    for (let i = 0; i < offsets.length; i++) {
      const index = origin + offsets[i], owner = cells[index];
      if ((owner && owner !== slot) || (obstacles[index] & 1)) return false;
    }
    return true;
  }
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
  const left = facing === 1 ? bounds.minX : -bounds.maxX, right = facing === 1 ? bounds.maxX : -bounds.minX;
  if (x + left >= 0 && x + right < WORLD_WIDTH) {
    const origin = y * WORLD_WIDTH + x;
    for (let i = 0; i < sweep.length; i += 3) {
      const base = origin + sweep[i + 2] * WORLD_WIDTH;
      const start = base + (facing === 1 ? sweep[i] : -sweep[i + 1]);
      const end = base + (facing === 1 ? sweep[i + 1] : -sweep[i]);
      for (let index = start; index <= end; index++) {
        const owner = cells[index];
        if ((owner && owner !== slot) || (obstacles[index] & 2)) return false;
      }
    }
    return true;
  }
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
