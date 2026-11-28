import { WORLD_WIDTH, wrapX } from './geography.js';

const side = 32;
const columns = Math.ceil(WORLD_WIDTH / side);
const sector = (x, y) => Math.floor(wrapX(x) / side) + columns * Math.floor(y / side);
const drawable = kind => kind === 'fish' || kind === 'scene' || kind === 'food' || kind === 'seaweed';

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
    }
    this.cells.set(id, entry);
    this.place(entry);
    return entry;
  }

  moveOwner(group, pose) {
    if (!group || group.x === pose?.x && group.y === pose?.y && group.facing === pose?.facing) return;
    group.x = pose?.x; group.y = pose?.y; group.facing = pose?.facing;
    for (const entry of group) this.place(entry);
  }

  reconcile() {
    const { chars, fishes, scenes } = this.data;
    this.queryKey = undefined;
    this.remaining = null;
    this.appended.clear();
    let order = 0;
    for (const id in chars) {
      const cell = chars[id];
      let entry = this.cells.get(id);
      if (!drawable(cell?.kind)) {
        if (entry) this.remove(id);
        continue;
      }
      if (!entry || entry.kind !== cell.kind || entry.entity !== cell.entity) entry = this.put(id, cell);
      else {
        entry.cell = cell;
        if (entry.x !== cell.x || entry.y !== cell.y) {
          entry.x = cell.x; entry.y = cell.y;
          this.place(entry);
        }
      }
      entry.order = order++;
    }
    if (order !== this.cells.size) for (const id of this.cells.keys()) if (!Object.hasOwn(chars, id)) this.remove(id);
    this.order = order;
    for (const [id, group] of this.owners.fish) this.moveOwner(group, fishes[id]);
    for (const [id, group] of this.owners.scene) this.moveOwner(group, scenes[id]);
  }

  update(tables) {
    const { chars, fishes, scenes } = tables;
    if (!chars && !fishes && !scenes) return;
    if (chars) this.queryKey = undefined;
    for (const id of chars?.remove || []) this.remove(id);
    for (const [id, cell] of chars?.set || []) {
      if (this.remaining && !this.cells.has(id)) this.appended.add(id);
      else this.put(id, cell);
    }
    for (const [changes, owners] of [[fishes, this.owners.fish], [scenes, this.owners.scene]]) {
      if (!changes) continue;
      for (const id of changes.remove || []) this.moveOwner(owners.get(id));
      for (const [id, pose] of changes.set || []) this.moveOwner(owners.get(id), pose);
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
