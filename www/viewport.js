import { WORLD_WIDTH, wrapX } from './geography.js';

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

function staysInSector(group, pose) {
  if (!Number.isInteger(pose?.x) || !Number.isInteger(pose.y) || Math.abs(pose.facing) !== 1) return false;
  const range = group.range ??= sectorRange(group);
  if (!range || pose.y < range.top || pose.y >= range.bottom) return false;
  return pose.facing === 1 ? pose.x >= range.left && pose.x < range.right :
    pose.x >= range.flippedLeft && pose.x < range.flippedRight;
}

// Several cells can share an owner. Moving the owner changes their sectors
// without changing the insertion order used by painting and hit testing.
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
    const { cell } = entry;
    let x = cell.x, y = cell.y;
    if (entry.owner) {
      const fish = cell.kind === 'fish';
      const owner = (fish ? this.data.fishes : this.data.scenes)[cell.entity];
      if (!owner) return this.move(entry, undefined);
      x = owner.x + (fish ? owner.facing : 1) * x;
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
      if (!entry.owner.size) this.owners[entry.kind].delete(entry.entity);
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
        const group = new Set(), pose = (cell.kind === 'fish' ? this.data.fishes : this.data.scenes)[cell.entity];
        if (pose) { group.x = pose.x; group.y = pose.y; group.facing = pose.facing; }
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
    if (!group || group.x === pose?.x && group.y === pose?.y && group.facing === pose?.facing) return;
    const inside = Math.abs(group.facing) === 1 && Math.abs(pose?.facing) === 1 && staysInSector(group, pose);
    group.x = pose?.x; group.y = pose?.y; group.facing = pose?.facing;
    if (!inside) {
      group.range = null;
      for (const entry of group) this.place(entry);
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

  syncOwners() {
    for (const [id, group] of this.owners.fish) this.moveOwner(group, this.data.fishes[id]);
    for (const [id, group] of this.owners.scene) this.moveOwner(group, this.data.scenes[id]);
  }

  reconcileMerge(changedChars) {
    this.queryKey = undefined;
    for (const id of changedChars) this.refresh(id, this.data.chars[id]);
    this.syncOwners();
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
    this.syncOwners();
  }

  update(tables) {
    const { chars, fishes, scenes } = tables;
    if (!chars && !fishes && !scenes) return;
    if (chars) this.queryKey = undefined;
    for (const id of chars?.remove || []) this.remove(id);
    for (const [id, cell] of chars?.set || []) {
      if (this.remaining && !this.cells.has(id)) this.appended.add(id);
      else this.refresh(id, cell);
    }
    for (const [changes, owners] of [[fishes, this.owners.fish], [scenes, this.owners.scene]]) {
      if (!changes) continue;
      for (const id of changes.remove || []) this.moveOwner(owners.get(id));
      const frame = changes.frame;
      if (frame?.moved) {
        for (const i of frame.moved) this.moveOwner(owners.get(frame.idAt(i)), frame.records[i]);
      } else for (const [id, pose] of changes.set || []) this.moveOwner(owners.get(id), pose);
    }
  }

  fishCells(id) { return Array.from(this.owners.fish.get(id) || [], entry => entry.cell); }

  query(left, right, top, bottom) {
    const first = Math.floor(wrapX(left) / side), last = Math.floor(wrapX(right) / side);
    const upper = Math.floor(top / side), lower = Math.floor(bottom / side);
    const all = right - left >= WORLD_WIDTH;
    const wraps = Math.floor(left / WORLD_WIDTH) !== Math.floor(right / WORLD_WIDTH);
    const key = [first, last, upper, lower, all, wraps].join(',');
    if (key === this.queryKey) return this.result;
    const entries = new Set();
    this.queriedSectors = new Set();
    const visit = (a, b) => {
      for (let row = upper; row <= lower; row++) for (let col = a; col <= b; col++) {
        const id = row * columns + col;
        this.queriedSectors.add(id);
        for (const entry of this.sectors.get(id) || []) {
          // Fish shapes, eye placement and echo effects use the entire visible body.
          if (entry.kind === 'fish') { if (!entries.has(entry)) for (const part of entry.owner) entries.add(part); }
          else entries.add(entry);
        }
      }
    };
    if (all) visit(0, columns - 1);
    else if (wraps) { visit(first, columns - 1); visit(0, last); }
    else visit(first, last);
    this.queryKey = key;
    this.result = Array.from(entries).sort((a, b) => a.order - b.order).map(entry => entry.cell);
    return this.result;
  }
}
