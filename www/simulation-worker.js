import { World, CONFIG } from './engine.js';
import { worldTables } from './simulation-changes.js';

// Only a user operation, a verified replica or archiving writes these fields.
// Natural simulation and geometry repair use them as lookup tables.
const inputFields = new Set(['ops', 'terrain', 'roots', 'participants', 'archivedCatalog', 'chatSources', 'chats', 'archives']);

// Track writes on the worker's private copy. Reads of old records do not put
// them in a message. Collections can be replaced by the simulation as a whole
// (notably contacts), in which case additions and removals must both be sent.
function trackWorld(source) {
  const proxies = new WeakMap(), originals = new WeakMap();
  const values = new Set(), rows = new Map();
  const raw = object => originals.get(object) || object;
  function mark(field, id) {
    if (id === undefined) { values.add(field); return; }
    if (!rows.has(field)) rows.set(field, new Set());
    rows.get(field).add(id);
  }
  // The same write barrier serves all records. Ordinary reads of coordinates,
  // glyphs and movement counters take the native property access path.
  const locations = new WeakMap();
  function child(location, key) {
    if (location.root) return { field: key, table: worldTables.has(key) };
    if (location.table) return { field: location.field, id: key };
    return location;
  }
  const writes = {
    set(target, key, value) {
      if (raw(target[key]) === raw(value) && Object.hasOwn(target, key)) return true;
      const location = child(locations.get(target), key);
      if (location.table) {
        const previous = target[key] || {};
        for (const id in previous) if (!Object.hasOwn(value || {}, id)) mark(key, id);
        for (const id in value) if (raw(previous[id]) !== raw(value[id])) mark(key, id);
      } else mark(location.field, location.id);
      target[key] = watch(value, location);
      return true;
    },
    deleteProperty(target, key) {
      if (!Object.hasOwn(target, key)) return true;
      const location = child(locations.get(target), key);
      mark(location.field, location.id);
      return delete target[key];
    }
  };
  function watch(object, location) {
    if (!object || typeof object !== 'object' || inputFields.has(location.field)) return object;
    // Terminal proofs are immutable during natural simulation. Keep the table
    // observed so a new active record or a replacement still enters the patch.
    if (location.field === 'breeding' && location.id !== undefined && object.status && object.status !== 'active') return object;
    object = raw(object);
    if (proxies.has(object)) return proxies.get(object);
    const proxy = new Proxy(object, writes);
    proxies.set(object, proxy); originals.set(proxy, object); locations.set(object, location);
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (value && typeof value === 'object') object[key] = watch(value, child(location, key));
    }
    return proxy;
  }
  // Spreads in the engine may copy references read through a proxy into a new
  // record. Only materialize the records actually crossing the worker boundary.
  function plain(value) {
    if (!value || typeof value !== 'object') return value;
    value = raw(value);
    if (Array.isArray(value)) return value.map(plain);
    const result = {};
    for (const key of Object.keys(value)) result[key] = plain(value[key]);
    return result;
  }
  return {
    data: watch(source, { root: true }),
    reset() { values.clear(); rows.clear(); },
    changes() {
      const patch = { values: {}, tables: {} };
      for (const field of values) patch.values[field] = plain(source[field]);
      for (const [field, ids] of rows) {
        const set = [], remove = [];
        for (const id of ids) {
          if (Object.hasOwn(source[field], id)) set.push([id, plain(source[field][id])]);
          else remove.push(id);
        }
        patch.tables[field] = { set, remove };
      }
      values.clear(); rows.clear();
      return patch;
    }
  };
}

export class WorkerSimulation {
  receive(message) {
    if (message.kind === 'open') {
      this.world = new World(message.values.tick, 'worker', { populate: false, ambient: message.ambient });
      this.world.data = message.values;
      for (const field of message.tables) this.world.data[field] = {};
      const fishes = this.world.data.fishes;
      // Live fish usually carry their original actor and gender. Only legacy
      // discrepancies need separate entries in the simulation's origin lookup.
      const catalog = new Proxy(Object.create(null), {
        get: (overrides, id) => Object.hasOwn(overrides, id) ? overrides[id] || undefined : fishes[id]
      });
      this.archive = { summary: { catalog, lastMeals: new Map(), grassMeals: new Set() } };
    } else if (message.kind === 'rows') {
      for (const [field, id, value, origin] of message.rows) {
        if (field === '@lastMeals') this.archive.summary.lastMeals.set(id, value);
        else if (field === '@grassMeals') this.archive.summary.grassMeals.add(id);
        else this.world.data[field][id] = value;
        if (field === 'fishes' && origin !== undefined) this.archive.summary.catalog[id] = origin;
      }
    } else if (message.kind === 'ready') {
      this.world.attachArchives(this.archive);
      this.tracker = trackWorld(this.world.data);
      this.world.data = this.tracker.data;
    } else if (message.kind === 'restore') {
      for (const [field, id, value] of message.rows) {
        if (value === undefined) delete this.world.data[field][id];
        else this.world.data[field][id] = value;
      }
      if (message.previous) {
        for (const [key, value] of Object.entries(message.previous)) {
          if (value === undefined) delete this.world.data[key];
          else this.world.data[key] = value;
        }
        this.world.foodRevision -= message.foodRevision;
        this.world.mealCache = null;
      }
      this.tracker.reset();
    } else if (message.kind === 'step' || message.kind === 'repair') {
      for (const { removed, meals } of message.archives || []) {
        for (const [field, ids] of Object.entries(removed)) {
          for (const id of ids) delete this.world.data[field]?.[id];
        }
        const { lastMeals, grassMeals } = this.archive.summary;
        for (const [id, at, grass] of meals) {
          if (at === undefined) lastMeals.delete(id); else lastMeals.set(id, at);
          if (grass) grassMeals.add(id); else grassMeals.delete(id);
        }
        this.world.mealCache = null;
      }
      for (const [id, nick] of message.names) this.world.data.participants[id] = nick;
      for (const [id, cell] of message.foods) this.world.data.chars[id] = cell;
      this.tracker.reset();
      if (this.world.data.tick !== message.base) throw new Error('后台模拟与当前世界步数不一致');
      const foodRevision = this.world.foodRevision;
      let geometry;
      if (message.kind === 'step') this.world.step(message.base + CONFIG.step);
      else if (message.geometry) geometry = this.world.reconcileGeometry(message.now);
      else this.world.reconcileChatFloor(message.now);
      return { patch: this.tracker.changes(), foodRevision: this.world.foodRevision - foodRevision, geometry };
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const simulation = new WorkerSimulation();
  globalThis.onmessage = ({ data }) => {
    try { postMessage({ result: simulation.receive(data) }); }
    catch (error) { postMessage({ error: error.message }); }
  };
}
