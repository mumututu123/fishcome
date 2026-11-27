import { World, CONFIG } from './engine.js';
import { worldTables } from './simulation-changes.js';
import { encodeFields } from './simulation-delta.js';

// Only a user operation, a verified replica or archiving writes these fields.
// Natural simulation and geometry repair use them as lookup tables.
const inputFields = new Set(['ops', 'terrain', 'roots', 'participants', 'archivedCatalog', 'chatSources', 'chats', 'archives']);

// Track writes on the worker's private copy. Reads of old records do not put
// them in a message. Collections can be replaced by the simulation as a whole
// (notably contacts), in which case additions and removals must both be sent.
function trackWorld(source) {
  const proxies = new WeakMap(), originals = new WeakMap();
  const values = new Set(), rows = new Map(), lifeFields = new Set(), bondRows = new Map();
  const raw = object => originals.get(object) || object;
  let characters, orderedBonds = false;
  const characterViews = new Map();
  const allCharacters = () => characters ??= Object.values(raw(source.chars));
  function charValues(...kinds) {
    if (kinds[0] === undefined) return allCharacters();
    const key = JSON.stringify(kinds), cached = characterViews.get(key);
    if (cached) return cached.cells;
    const cells = allCharacters().filter(cell => kinds.includes(cell.kind));
    characterViews.set(key, { kinds, cells });
    return cells;
  }
  function invalidateCharacterViews(previous, next) {
    for (const [key, view] of characterViews) if (view.kinds.includes(previous) || view.kinds.includes(next)) characterViews.delete(key);
  }
  function tableChanges(field) {
    if (!rows.has(field)) rows.set(field, new Map());
    return rows.get(field);
  }
  const locations = new WeakMap();
  function child(location, key) {
    if (location.root) return { field: key, table: worldTables.has(key) };
    const { field, id, property, part, bond } = location;
    if (location.table) return { field, id: key, editable: field === 'fishes' || field === 'travel' };
    if (location.editable && property === undefined) return { ...location, property: key };
    if (field === 'travel' && property === 'days' && location.day === undefined) return { ...location, day: key };
    if (field === 'life') {
      if (part === undefined) return { field, part: key };
      if (part === 'bonds' && bond === undefined) return { ...location, bond: key };
    }
    return location;
  }
  function markLife(location, target, key, value) {
    const { part, bond } = location;
    if (part === 'bonds') {
      if (bond !== undefined) bondRows.set(bond, null);
      else if (!bondRows.has(key)) bondRows.set(key, raw(target[key]));
    } else if (part === undefined && key === 'bonds' && target[key] && value) {
      const previous = raw(target[key]), next = raw(value);
      const before = Object.keys(previous), after = Object.keys(next);
      if (before.length !== after.length) orderedBonds = true;
      for (const [index, id] of after.entries()) {
        if (before[index] !== id) orderedBonds = true;
        if (!bondRows.has(id) && raw(previous[id]) !== raw(next[id])) bondRows.set(id, raw(previous[id]));
      }
    } else lifeFields.add(part ?? key);
  }
  function mark(target, parent, key, value, deleting = false) {
    const { field, id, property } = parent;
    if (parent.root && key === 'chars') {
      characters = undefined;
      characterViews.clear();
    } else if (field === 'chars') {
      if (parent.table) {
        characters = undefined;
        invalidateCharacterViews(target[key]?.kind, value?.kind);
      } else if (key === 'kind' && target === raw(source.chars[id])) invalidateCharacterViews(target.kind, value);
    }
    if (parent.root) {
      if (worldTables.has(key) && !deleting) {
        const previous = raw(target[key]) || {}, next = raw(value) || {};
        for (const id in previous) if (!Object.hasOwn(next, id)) tableChanges(key).set(id, null);
        for (const id in next) if (raw(previous[id]) !== raw(next[id])) tableChanges(key).set(id, null);
      } else values.add(key);
    } else if (parent.table) tableChanges(field).set(key, null);
    else if (parent.editable) {
      const changed = tableChanges(field);
      if (!changed.has(id)) changed.set(id, { properties: new Set() });
      const edit = changed.get(id);
      if (!edit) return;
      if (field === 'travel' && property === 'days') (edit.days ||= new Set()).add(parent.day ?? key);
      else edit.properties.add(property ?? key);
    } else if (field === 'life') markLife(parent, target, key, value);
    else if (id === undefined) values.add(field);
    else tableChanges(field).set(id, null);
  }
  // Ordinary reads use the record. Every mutation still goes through this barrier.
  const writes = {
    set(target, key, value) {
      if (raw(target[key]) === raw(value) && Object.hasOwn(target, key)) return true;
      const parent = locations.get(target);
      mark(target, parent, key, value);
      target[key] = value && typeof value === 'object' ? watch(value, child(parent, key)) : value;
      return true;
    },
    deleteProperty(target, key) {
      if (!Object.hasOwn(target, key)) return true;
      mark(target, locations.get(target), key, undefined, true);
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
  function encodeRow(id, row, edit) {
    if (!edit) return [id, plain(row)];
    row = raw(row);
    const delta = [id, ...encodeFields(row, edit.properties, plain)];
    if (edit.days && !edit.properties.has('days')) delta.push(encodeFields(raw(row.days), edit.days, plain));
    return delta;
  }
  function encodeBond(id, row) {
    if (!bondRows.has(id)) return [id];
    const old = bondRows.get(id), next = raw(row);
    if (!old || !next) return [id, plain(row)];
    const before = Object.keys(old), after = Object.keys(next);
    // Existing bond records come from saves as well. A replacement can put its
    // fields in a different order, which the full row preserves.
    if (before.length !== after.length || after.some((key, index) => key !== before[index])) return [id, plain(row)];
    const changed = after.filter(key => raw(old[key]) !== raw(next[key]));
    return changed.length ? [id, ...encodeFields(next, changed, plain)] : [id];
  }
  function encodeBonds(table) {
    table = raw(table);
    const set = [], remove = [];
    if (orderedBonds) for (const id of Object.keys(table)) set.push(encodeBond(id, table[id]));
    else for (const id of bondRows.keys()) {
      if (Object.hasOwn(table, id)) set.push(encodeBond(id, table[id]));
      else remove.push(id);
    }
    return { set, remove, ordered: orderedBonds };
  }
  function reset() {
    values.clear(); rows.clear(); lifeFields.clear(); bondRows.clear(); orderedBonds = false;
  }
  return {
    data: watch(source, { root: true }),
    // Callers enumerate this read-only list. Its rows still carry tracked writes.
    charValues,
    reset,
    changes() {
      const patch = { values: {}, tables: {} };
      for (const field of values) patch.values[field] = plain(source[field]);
      for (const [field, edits] of rows) {
        const set = [], remove = [];
        const table = raw(source[field]) || {};
        for (const [id, edit] of edits) {
          if (Object.hasOwn(table, id)) set.push(encodeRow(id, table[id], edit));
          else remove.push(id);
        }
        patch.tables[field] = { set, remove };
      }
      if (!values.has('life') && (lifeFields.size || bondRows.size || orderedBonds)) {
        const life = raw(source.life);
        patch.life = { properties: encodeFields(life, lifeFields, plain) };
        if (!lifeFields.has('bonds') && (bondRows.size || orderedBonds)) patch.life.bonds = encodeBonds(life.bonds);
      }
      reset();
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
      this.world.charValues = this.tracker.charValues;
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
      const swims = [];
      if (message.kind === 'step') this.world.step(message.base + CONFIG.step, swims);
      else if (message.geometry) geometry = this.world.reconcileGeometry(message.now);
      else this.world.reconcileChatFloor(message.now);
      const patch = this.tracker.changes();
      if (swims.length) patch.swims = swims;
      return { patch, foodRevision: this.world.foodRevision - foodRevision, geometry };
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
