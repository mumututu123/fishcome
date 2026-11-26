import { breedingForBroadcast, stopBreedingBroadcast } from './breeding.js';

// These dictionaries merge by record ID. Contacts are different: a newer
// contactAt replaces the entire contact table, including its unchanged rows.
const rowFields = ['chars', 'fishes', 'scenes', 'participants', 'ops', 'chats', 'chatSources', 'travel', 'rocks'];
const sameRow = (left, right) => left === right || left !== undefined && JSON.stringify(left) === JSON.stringify(right);

function packet(data, rows, breeding) {
  return {
    protocol: 1, roots: data.roots, terrain: data.terrain, tick: data.tick,
    seaweedHour: data.seaweedHour, bubbleMinute: data.bubbleMinute, bubbles: data.bubbles,
    ...rows, breeding, contacts: data.contacts, contactAt: data.contactAt, notices: [],
    life: data.life, legends: data.legends, ecology: data.ecology, population: data.population, archives: data.archives
  };
}

function fullRows(data) { return Object.fromEntries(rowFields.map(field => [field, data[field] || {}])); }

function baseline(world, breeding, at) {
  return { initial: fullRows(world), updates: Object.fromEntries(rowFields.map(field => [field, new Map()])), breeding, fullAt: at };
}

function changedRows(data, base, pending) {
  const rows = {};
  for (const field of rowFields) {
    const table = data[field] || {}, initial = base.initial[field], updates = base.updates[field];
    const changed = rows[field] = {};
    const check = id => {
      if (!Object.hasOwn(table, id)) { updates.set(id, undefined); return; }
      const sent = updates.has(id) ? updates.get(id) : initial[id];
      if (!sameRow(sent, table[id])) changed[id] = table[id];
    };
    if (pending) {
      for (const id of pending.get(field) || []) check(id);
    } else {
      // Foreground edits and merges can modify records in place. Reconcile with
      // the last sent values once, then return to tracking known worker writes.
      for (const id in table) if (Object.hasOwn(table, id)) check(id);
      for (const id in initial) if (!Object.hasOwn(table, id)) updates.set(id, undefined);
      for (const id of updates.keys()) if (!Object.hasOwn(table, id)) updates.set(id, undefined);
    }
  }
  return rows;
}

export class WorldBroadcast {
  constructor(subscribe) {
    this.observesChanges = !!subscribe;
    subscribe?.((world, patch) => {
      if (world.data !== this.source || !this.pending) return;
      if (!patch) { this.pending = null; return; }
      for (const field of rowFields) {
        if (Object.hasOwn(patch.values || {}, field)) { this.pending = null; return; }
        const changes = patch.tables?.[field];
        if (!changes) continue;
        let ids = this.pending.get(field);
        if (!ids) this.pending.set(field, ids = new Set());
        for (const [id] of changes.set) ids.add(id);
        for (const id of changes.remove) ids.add(id);
      }
    });
  }

  reset() {
    if (this.source) stopBreedingBroadcast(this.trackedBreeding);
    this.source = null;
    this.previous = null;
    this.pending = null;
    this.generation = (this.generation || 0) + 1;
  }

  takeChanges(data) {
    const pending = this.pending;
    this.source = data;
    this.trackedBreeding = data.breeding;
    this.pending = this.observesChanges ? new Map() : null;
    return pending;
  }

  async captureJoined(data, capture) {
    if (this.previous || this.busy) return capture();
    const generation = this.generation;
    this.takeChanges(data);
    breedingForBroadcast(data.breeding, true);
    this.busy = true;
    try {
      const snapshot = await capture();
      if (generation === this.generation) this.previous = baseline(snapshot, data.breeding, Date.now());
      return snapshot;
    } finally { this.busy = false; }
  }

  async send(network, data, now = Date.now(), captureFull) {
    if (!network.live().length) { this.reset(); return; }
    if ((network.replicaPeers && !network.replicaPeers().length) || this.busy) return;
    this.busy = true;
    try {
      if (this.source && (this.source !== data || this.trackedBreeding !== data.breeding)) this.reset();
      const previous = this.previous && now - this.previous.fullAt <= 30000 ? this.previous : null;
      const pending = this.takeChanges(data);
      const generation = this.generation, breeding = breedingForBroadcast(data.breeding, !previous);
      let world;
      if (previous) {
        world = structuredClone(packet(data, changedRows(data, previous, pending), breeding));
        // The baseline shares immutable rows with the last captured version.
        // Keep later writes separate while joins still read that version.
        for (const field of rowFields) {
          for (const [id, value] of Object.entries(world[field])) previous.updates[field].set(id, value);
        }
      } else {
        const source = captureFull ? await captureFull() : data;
        if (generation !== this.generation) return;
        const full = packet(source, fullRows(source), source.breeding);
        world = captureFull ? full : structuredClone(full);
        this.previous = baseline(world, data.breeding, now);
      }
      return await network.broadcast('world', { delta: !!previous, world }, { capturedWorld: true });
    } catch (error) {
      this.reset();
      throw error;
    } finally { this.busy = false; }
  }
}
