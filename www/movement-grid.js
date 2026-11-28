import { WORLD_WIDTH, MAX_FLOOR, terrainOf, wrapX, worldKey } from './geography.js';
import { obstacleMask } from './motion-hull.js';

const occupancyRows = MAX_FLOOR + 1;

export function foreignOwner(owners, id, pair) {
  if (owners) for (const owner of owners) {
    if (pair?.status === 'active' ? owner !== pair.male && owner !== pair.female : owner !== id) return true;
  }
  return false;
}

// The moving population probes an integer sea. Most occupied cells have one
// owner, so the cells of one fish can share a read-only singleton.
export class MovementGrid {
  cells = new Int32Array(WORLD_WIDTH * occupancyRows);
  slots = new Map();
  owners = [undefined];
  singles = [];
  overlaps = new Map();
  fractional = new Map();
  overlapped = false;
  integerCells = true;
  constructor(layout) { this.layout = layout; }
  swimmers(world, speed) {
    const roster = world.stableFishRoster?.();
    if (!roster) return this.layout.ordered;
    if (this.roster !== roster) {
      this.roster = roster;
      const entries = this.swimmerBodies ??= new WeakMap();
      this.swimmersById = this.layout.ordered.map(([id, cells]) => {
        const fish = world.readFish(id), cached = entries.get(cells);
        if (cached && cached[0] === id && cached[3].fish === fish) return cached;
        const hull = this.layout.hull(cells);
        const entry = [id, cells, null, { fish, ordinal: world.swimOrdinal?.(id), hull, slot: this.slots.get(id),
          speedX: hull && speed * hull.bounds.width / cells.length, speedY: hull && speed * hull.bounds.height / cells.length,
          intended: undefined }];
        entries.set(cells, entry);
        return entry;
      });
    }
    return this.swimmersById;
  }
  index(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= occupancyRows) return worldKey(x, y);
    return y * WORLD_WIDTH + (x >= 0 && x < WORLD_WIDTH ? x : wrapX(x));
  }
  get(x, y) {
    const k = this.index(x, y);
    if (typeof k !== 'number') return this.fractional.get(k);
    const slot = this.cells[k];
    if (slot <= 0) return slot && this.overlaps.get(k) || undefined;
    return this.singles[slot] ??= new Set([this.owners[slot]]);
  }
  clear(x, y) {
    const k = this.index(x, y);
    if (typeof k !== 'number') { this.fractional.delete(k); return; }
    if (this.cells[k] < 0) this.overlaps.delete(k);
    this.cells[k] = 0;
  }
  slot(id) {
    let slot = this.slots.get(id);
    if (slot === undefined) {
      slot = this.owners.length;
      this.slots.set(id, slot);
      this.owners.push(id);
    }
    return slot;
  }
  setCell(x, y, id, slot, remove) {
    const k = this.index(x, y);
    if (typeof k !== 'number') {
      if (!Number.isInteger(x) || !Number.isInteger(y)) this.integerCells = false;
      let group = this.fractional.get(k);
      if (remove) {
        if (group?.delete(id) && !group.size) this.fractional.delete(k);
      } else {
        if (!group) this.fractional.set(k, group = new Set());
        group.add(id);
        if (group.size > 1) this.overlapped = true;
      }
      return;
    }
    const current = this.cells[k];
    if (!remove && !current) { this.cells[k] = slot; return; }
    if (current === slot) { if (remove) this.cells[k] = 0; return; }
    if (current < 0) {
      const group = this.overlaps.get(k);
      if (!remove) group.add(id);
      else if (group.delete(id) && group.size === 1) {
        this.cells[k] = this.slots.get(group.values().next().value);
        this.overlaps.delete(k);
      }
    } else if (!remove) {
      this.overlapped = true;
      this.cells[k] = -1;
      this.overlaps.set(k, new Set([this.owners[current], id]));
    }
  }
  add(x, y, id) {
    const slot = this.slot(id);
    this.setCell(x, y, id, slot, false);
    (this.additions ??= []).push([x, y, id, slot]);
  }
  reconcile(world, layout, bodies, poses) {
    if (this.overlapped || !this.integerCells) return false;
    const changed = new Set([...bodies, ...poses.keys()]);
    for (const id of changed) {
      const oldBody = this.layout.groups.get(id);
      if (oldBody && !this.layout.hull(oldBody)) return false;
    }
    for (const [x, y, id, slot] of this.additions || []) this.setCell(x, y, id, slot, true);
    this.additions = undefined;
    for (const id of changed) {
      const old = this.layout.groups.get(id), previous = poses.has(id) ? poses.get(id) : world.readFish(id);
      if (!old || !previous) continue;
      const { xy } = this.layout.hull(old), slot = this.slots.get(id);
      for (let i = 0; i < xy.length; i += 2) {
        this.setCell(previous.x + previous.facing * xy[i], previous.y + xy[i + 1], id, slot, true);
      }
    }
    // Movement order and the adjacent-pair search use the same current body collection.
    if (this.layout !== layout) this.roster = undefined;
    this.layout = layout;
    for (const id of changed) {
      const fish = world.readFish(id), body = layout.groups.get(id);
      if (fish && body) this.update(fish, body);
    }
    return !this.overlapped;
  }
  visibleFoodOwners(foods, radius) {
    // The eyes are a subset of occupied body cells. Select every owner with
    // any cell in range before the ordered pass starts moving its first fish.
    if (this.overlapped || this.fractional.size) return;
    const size = 10, columns = WORLD_WIDTH / size, rows = Math.ceil(occupancyRows / size);
    const sectors = new Uint8Array(rows * columns), nearby = new Uint8Array(this.owners.length);
    for (const food of foods) {
      if (!Number.isSafeInteger(food.x) || !Number.isSafeInteger(food.y) || Math.abs(food.x) > 2 * WORLD_WIDTH) return;
      const x = wrapX(food.x), top = Math.max(0, Math.floor((food.y - radius) / size));
      const bottom = Math.min(rows - 1, Math.floor((food.y + radius) / size));
      for (let y = top; y <= bottom; y++) {
        for (let bx = Math.floor((x - radius) / size); bx <= Math.floor((x + radius) / size); bx++) {
          const column = (bx + columns) % columns, sector = y * columns + column;
          if (sectors[sector]) continue;
          sectors[sector] = 1;
          const endY = Math.min((y + 1) * size, occupancyRows);
          for (let cy = y * size; cy < endY; cy++) {
            const start = cy * WORLD_WIDTH + column * size;
            for (let i = start; i < start + size; i++) {
              const slot = this.cells[i];
              if (slot) nearby[slot] = 1;
            }
          }
        }
      }
    }
    return nearby;
  }
  prepareMovement(data, scenery, foods, weeds) {
    const depths = terrainOf(data).depths;
    if (this.depths !== depths) {
      this.depths = depths;
      const terrain = this.terrain = new Uint8Array(WORLD_WIDTH * MAX_FLOOR);
      for (let x = 0; x < WORLD_WIDTH; x++) for (let y = Math.max(0, Math.ceil(depths[x])); y < MAX_FLOOR; y++) {
        terrain[y * WORLD_WIDTH + x] = 3;
      }
    }
    this.obstacles = obstacleMask(scenery, foods, weeds, this.terrain.slice());
  }
  clearCell(x, y, id, pair, obstacle) {
    const column = x >= 0 && x < WORLD_WIDTH ? x : wrapX(x);
    if (y < 0 || y >= this.depths[column]) return false;
    const index = y * WORLD_WIDTH + column;
    if (this.obstacles[index] & obstacle) return false;
    const slot = this.cells[index];
    if (!slot) return true;
    if (slot < 0) return !foreignOwner(this.overlaps.get(index), id, pair);
    const owner = this.owners[slot];
    return pair?.status === 'active' ? owner === pair.male || owner === pair.female : owner === id;
  }
  update(fish, cells, remove = false) {
    const { x, y, facing, id } = fish, slot = this.slot(id), xy = this.layout.hull(cells)?.xy;
    if (xy) {
      for (let i = 0; i < xy.length; i += 2) this.setCell(x + facing * xy[i], y + xy[i + 1], id, slot, remove);
    } else {
      for (const cell of cells) this.setCell(x + facing * cell.x, y + cell.y, id, slot, remove);
    }
  }
  moveFish(fish, body, x, y, facing, hull, slot) {
    if (slot !== undefined && !this.overlapped && y + hull.bounds.minY >= 0 && y + hull.bounds.maxY < occupancyRows &&
        fish.y + hull.bounds.minY >= 0 && fish.y + hull.bounds.maxY < occupancyRows) {
      const { xy } = hull, cells = this.cells;
      for (let i = 0; i < xy.length; i += 2) {
        const column = x + facing * xy[i];
        cells[(y + xy[i + 1]) * WORLD_WIDTH + (column >= 0 && column < WORLD_WIDTH ? column : wrapX(column))] = 0;
      }
      const { x: nextX, y: nextY, facing: nextFacing } = fish;
      for (let i = 0; i < xy.length; i += 2) {
        const column = nextX + nextFacing * xy[i];
        cells[(nextY + xy[i + 1]) * WORLD_WIDTH + (column >= 0 && column < WORLD_WIDTH ? column : wrapX(column))] = slot;
      }
    } else {
      this.update({ id: fish.id, x, y, facing }, body, true);
      this.update(fish, body);
    }
  }
}
