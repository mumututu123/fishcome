const tables = new WeakMap();

// Keep the ordinary enumerable dictionary at the page boundary. Each slot's
// getter reads the last committed frame. A foreground write still replaces the
// row, and a reference read before the next step keeps its earlier position.
export class SimulationRows {
  static snapshot(table) {
    const source = tables.get(table);
    if (!source) return;
    const ids = Object.keys(table), positions = new Map();
    const frames = new Array(ids.length), slots = new Int32Array(ids.length), values = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], slot = source.byId.get(id);
      positions.set(id, i);
      const ownsSlot = slot && Object.getOwnPropertyDescriptor(table, id).get === slot.read;
      if (ownsSlot && slot.frame) { frames[i] = slot.frame; slots[i] = slot.index; }
      else values[i] = ownsSlot ? slot.value : table[id];
    }
    return { ids, get(id, absent) {
      const i = positions.get(id);
      if (i === undefined) return absent;
      return frames[i] ? frames[i].readForCheckpoint(slots[i]) : values[i];
    } };
  }

  static readForCheckpoint(table, id) {
    const slot = tables.get(table)?.byId.get(id);
    return slot?.frame && Object.getOwnPropertyDescriptor(table, id)?.get === slot.read ? slot.frame.readForCheckpoint(slot.index) : table[id];
  }

  static current(table) {
    const rows = tables.get(table);
    if (rows?.knownFish) return rows;
  }

  static invalidate(table) {
    const existing = tables.get(table);
    if (existing) existing.knownFish = null;
  }

  static removed(table, ids) {
    const existing = tables.get(table);
    if (existing) for (const id of ids) existing.remove(id);
  }

  static for(table, knownFish) {
    const existing = tables.get(table);
    if (existing?.knownFish === knownFish) return existing;
    return new SimulationRows(table, knownFish, existing);
  }

  constructor(table, knownFish, previous) {
    this.byId = new Map();
    this.knownFish = knownFish;
    for (const id of Object.keys(table)) {
      const prior = previous?.byId.get(id);
      if (prior && Object.getOwnPropertyDescriptor(table, id).get === prior.read) this.byId.set(id, prior);
      else this.add(table, id, table[id]);
    }
    this.slots = knownFish.map(id => this.byId.get(id));
    tables.set(table, this);
  }

  add(table, id, value, ordinal) {
    const slot = { value, frame: null, index: 0 };
    slot.read = () => slot.frame ? slot.frame.recordAt(slot.index) : slot.value;
    Object.defineProperty(table, id, { configurable: true, enumerable: true, get: slot.read, set(value) {
      slot.value = value;
      slot.frame = null;
    } });
    this.byId.set(id, slot);
    if (ordinal !== undefined) this.slots[ordinal] = slot;
    return slot;
  }

  remove(id) {
    const slot = this.byId.get(id);
    if (slot) slot.removed = true;
    this.byId.delete(id);
  }

  at(id, ordinal) {
    const slot = ordinal === undefined ? this.byId.get(id) : this.slots[ordinal];
    return slot?.removed || !slot ? this.byId.get(id) : slot;
  }
}
