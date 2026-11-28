import { WORLD_WIDTH, wrapX } from './geography.js';
import { SimulationRows } from './simulation-rows.js';

const side = 32;
const columns = Math.ceil(WORLD_WIDTH / side);
const sector = (x, y) => Math.floor(wrapX(x) / side) + columns * Math.floor(y / side);
const drawable = kind => kind === 'fish' || kind === 'scene' || kind === 'food' || kind === 'seaweed';

// Intersect the anchor positions that keep each glyph in its current sector.
// This also covers bodies spanning several sectors and turns about their anchor.
function sectorRange(group) {
  if (!Number.isInteger(group.x) || group.x < 0 || group.x >= WORLD_WIDTH ||
      !Number.isInteger(group.y) || Math.abs(group.y) > WORLD_WIDTH || Math.abs(group.facing) !== 1) return;
  let left = -Infinity, right = Infinity, flippedLeft = -Infinity, flippedRight = Infinity;
  let top = -Infinity, bottom = Infinity;
  for (const entry of group) {
    if (!Number.isInteger(entry.x) || !Number.isInteger(entry.y) ||
        Math.abs(entry.x) > WORLD_WIDTH || Math.abs(entry.y) > WORLD_WIDTH) return;
    const x = group.x + group.facing * entry.x, y = group.y + entry.y;
    const wrapped = wrapX(x), column = wrapped - wrapped % side, row = Math.floor(y / side) * side;
    const start = x - wrapped + column, end = start + Math.min(side, WORLD_WIDTH - column);
    left = Math.max(left, start - entry.x); right = Math.min(right, end - entry.x);
    flippedLeft = Math.max(flippedLeft, start + entry.x); flippedRight = Math.min(flippedRight, end + entry.x);
    top = Math.max(top, row - entry.y); bottom = Math.min(bottom, row + side - entry.y);
  }
  return { left, right, flippedLeft, flippedRight, top, bottom };
}

function staysInSector(group, x, y, facing) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(facing) !== 1) return false;
  const range = group.range ??= sectorRange(group);
  if (!range || y < range.top || y >= range.bottom) return false;
  return facing === 1 ? x >= range.left && x < range.right : x >= range.flippedLeft && x < range.flippedRight;
}

function bodyBounds(group) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const { x, y } of group) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > WORLD_WIDTH || Math.abs(y) > WORLD_WIDTH) return false;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { left, right, top, bottom };
}

// Integer bodies can be rejected by their bounds. Older coordinates still use
// the glyph test, which rounds wrapped positions the same way as drawing.
function reachesFishSector(bounds, x, y, facing, x1, x2, y1, y2, wraps, all) {
  if (!bounds || !Number.isInteger(x) || x < 0 || x >= WORLD_WIDTH ||
      !Number.isInteger(y) || Math.abs(y) > WORLD_WIDTH || Math.abs(facing) !== 1) return true;
  if (y + bounds.top >= y2 || y + bounds.bottom < y1) return false;
  if (all) return true;
  const left = x + (facing === 1 ? bounds.left : -bounds.right);
  const right = x + (facing === 1 ? bounds.right : -bounds.left);
  if (wraps) return left < x2 || right >= x1;
  return (left < x2 && right >= x1) ||
    (left + WORLD_WIDTH < x2 && right + WORLD_WIDTH >= x1) ||
    (left - WORLD_WIDTH < x2 && right - WORLD_WIDTH >= x1);
}

// Fish groups read their committed poses when queried. Other cells retain
// sector membership and share the same order used by painting and hit testing.
export class ViewportCells {
  constructor(data, progressive = false) {
    this.data = data;
    this.cells = new Map();
    this.owners = { fish: new Map(), scene: new Map() };
    this.sectors = new Map();
    this.order = 0;
    this.remaining = this.initialCells();
    this.appended = new Set();
    if (!progressive) this.advance(Infinity);
  }
  *initialCells() {
    for (const id in this.data.chars) yield id;
  }
  advance(budget = 5) {
    if (!this.remaining) return;
    const start = performance.now();
    this.queryKey = undefined;
    for (let n = 0; ; n++) {
      const next = this.remaining.next();
      if (next.done) {
        this.remaining = null;
        for (const id of this.appended) {
          if (!this.cells.has(id) && this.data.chars[id]) this.put(id, this.data.chars[id]);
        }
        this.appended.clear();
        return;
      }
      const cell = this.data.chars[next.value];
      if (cell) this.put(next.value, cell);
      if (n % 128 === 127 && performance.now() - start >= budget) return;
    }
  }

  place(entry) {
    if (entry.kind === 'fish') {
      entry.owner.bounds = undefined;
      this.queryKey = undefined;
      return;
    }
    const { cell } = entry;
    let x = cell.x, y = cell.y;
    if (entry.owner) {
      const owner = this.data.scenes[cell.entity];
      if (!owner) return this.move(entry, undefined);
      x = owner.x + x;
      y += owner.y;
    }
    this.move(entry, sector(x, y));
  }

  move(entry, next) {
    if (entry.sector === next) return;
    if (this.queriedSectors?.has(entry.sector) || this.queriedSectors?.has(next)) this.queryKey = undefined;
    if (entry.sector !== undefined) {
      const previous = this.sectors.get(entry.sector);
      previous.delete(entry);
      if (!previous.size) this.sectors.delete(entry.sector);
    }
    entry.sector = next;
    if (next !== undefined) {
      if (!this.sectors.has(next)) this.sectors.set(next, new Set());
      this.sectors.get(next).add(entry);
    }
  }

  remove(id) {
    const entry = this.cells.get(id);
    if (!entry) return;
    this.move(entry, undefined);
    if (entry.owner) {
      entry.owner.delete(entry);
      entry.owner.range = null;
      if (entry.kind === 'fish') {
        entry.owner.bounds = undefined;
        this.queryKey = undefined;
      }
      if (!entry.owner.size) {
        this.owners[entry.kind].delete(entry.entity);
        if (entry.kind === 'fish') this.fishGroups = null;
      }
    }
    this.cells.delete(id);
    return entry.order;
  }

  put(id, cell) {
    const oldOrder = this.remove(id);
    if (!drawable(cell.kind)) return;
    const entry = { cell, kind: cell.kind, entity: cell.entity, x: cell.x, y: cell.y, order: oldOrder ?? this.order++ };
    const owners = this.owners[cell.kind];
    if (owners) {
      if (!owners.has(cell.entity)) {
        const group = new Set();
        if (cell.kind === 'fish') {
          group.id = cell.entity;
          this.fishGroups = null;
        } else {
          const pose = this.data.scenes[cell.entity];
          if (pose) { group.x = pose.x; group.y = pose.y; group.facing = pose.facing; }
        }
        owners.set(cell.entity, group);
      }
      entry.owner = owners.get(cell.entity);
      entry.owner.add(entry);
      entry.owner.range = null;
    }
    this.cells.set(id, entry);
    this.place(entry);
    return entry;
  }

  moveOwner(group, pose) {
    this.moveOwnerTo(group, pose?.x, pose?.y, pose?.facing);
  }

  moveOwnerTo(group, x, y, facing) {
    if (!group || group.x === x && group.y === y && group.facing === facing) return;
    const inside = Math.abs(group.facing) === 1 && staysInSector(group, x, y, facing);
    group.x = x; group.y = y; group.facing = facing;
    if (!inside) {
      group.range = null;
      for (const entry of group) this.move(entry, x === undefined ? undefined : sector(x + entry.x, y + entry.y));
    }
  }

  refresh(id, cell) {
    const entry = this.cells.get(id);
    if (!drawable(cell?.kind)) { this.remove(id); return; }
    if (!entry || entry.kind !== cell.kind || entry.entity !== cell.entity) return this.put(id, cell);
    entry.cell = cell;
    if (entry.x !== cell.x || entry.y !== cell.y) {
      entry.x = cell.x;
      entry.y = cell.y;
      if (entry.owner) entry.owner.range = null;
      this.place(entry);
    }
    return entry;
  }

  reconcileMerge({ chars, fishes, scenes }) {
    if (chars.size) this.queryKey = undefined;
    for (const id of chars) this.refresh(id, this.data.chars[id]);
    if (fishes.size) this.fishQueryDirty = true;
    for (const id of scenes) this.moveOwner(this.owners.scene.get(id), this.data.scenes[id]);
  }

  reconcile() {
    const { chars } = this.data;
    this.queryKey = undefined;
    this.remaining = null;
    this.appended.clear();
    let order = 0;
    for (const id in chars) {
      const entry = this.refresh(id, chars[id]);
      if (entry) entry.order = order++;
    }
    if (order !== this.cells.size) for (const id of this.cells.keys()) if (!Object.hasOwn(chars, id)) this.remove(id);
    this.order = order;
    for (const [id, group] of this.owners.scene) this.moveOwner(group, this.data.scenes[id]);
  }

  update(tables) {
    const { chars, fishes, scenes } = tables;
    if (!chars && !fishes && !scenes) return;
    if (chars) this.queryKey = undefined;
    if (fishes) this.fishQueryDirty = true;
    for (const id of chars?.remove || []) this.remove(id);
    for (const [id, cell] of chars?.set || []) {
      if (this.remaining && !this.cells.has(id)) this.appended.add(id);
      else this.refresh(id, cell);
    }
    if (scenes) {
      for (const id of scenes.remove || []) this.moveOwner(this.owners.scene.get(id));
      for (const [id, pose] of scenes.set || []) this.moveOwner(this.owners.scene.get(id), pose);
    }
  }

  fishCells(id) { return Array.from(this.owners.fish.get(id) || [], entry => entry.cell); }

  query(left, right, top, bottom) {
    const first = Math.floor(wrapX(left) / side), last = Math.floor(wrapX(right) / side);
    const upper = Math.floor(top / side), lower = Math.floor(bottom / side);
    const all = right - left >= WORLD_WIDTH;
    const wraps = Math.floor(left / WORLD_WIDTH) !== Math.floor(right / WORLD_WIDTH);
    const key = [first, last, upper, lower, all, wraps].join(',');
    if (key === this.queryKey && !this.fishQueryDirty) return this.result;
    const previous = key === this.queryKey && this.result;
    const entries = new Set();
    this.queriedSectors = new Set();
    const visit = (a, b) => {
      for (let row = upper; row <= lower; row++) for (let col = a; col <= b; col++) {
        const id = row * columns + col;
        this.queriedSectors.add(id);
        for (const entry of this.sectors.get(id) || []) entries.add(entry);
      }
    };
    if (all) visit(0, columns - 1);
    else if (wraps) { visit(first, columns - 1); visit(0, last); }
    else visit(first, last);
    const x1 = first * side, x2 = Math.min(WORLD_WIDTH, (last + 1) * side), y1 = upper * side, y2 = (lower + 1) * side;
    const { fishes } = this.data, rows = SimulationRows.current(fishes), coordinates = {};
    if (!this.fishGroups || this.fishRows !== rows) {
      this.fishGroups = [...this.owners.fish.values()];
      for (const group of this.fishGroups) group.slot = rows?.at(group.id);
      this.fishRows = rows;
    }
    for (const group of this.fishGroups) {
      let slot = group.slot;
      if (rows && (!slot || slot.removed)) slot = group.slot = rows.at(group.id);
      const frame = slot?.frame;
      const pose = frame ? frame.readPose(slot.index, coordinates) : slot ? slot.value : fishes[group.id];
      if (pose?.x === undefined) continue;
      const { x, y, facing } = pose;
      const bounds = group.bounds ??= bodyBounds(group);
      if (!reachesFishSector(bounds, x, y, facing, x1, x2, y1, y2, wraps, all)) continue;
      for (const part of group) if (this.queriedSectors.has(sector(x + facing * part.x, y + part.y))) {
        // Fish shapes, eye placement and echo effects use the entire visible body.
        for (const part of group) entries.add(part);
        break;
      }
    }
    this.fishQueryDirty = false;
    this.queryKey = key;
    const result = Array.from(entries).sort((a, b) => a.order - b.order).map(entry => entry.cell);
    if (!previous || previous.length !== result.length || result.some((cell, i) => cell !== previous[i])) this.result = result;
    return this.result;
  }
}
