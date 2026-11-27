import { BodyLayout } from './motion-hull.js';
import { World, CONFIG, indexEcologyCharacters } from './engine.js';
import { shanghaiDay } from './fish-status.js';
import { worldTables } from './simulation-changes.js';
import { encodeFields, motionFields } from './simulation-delta.js';

const motionEdit = { properties: motionFields };

// Only a user operation, a verified replica or archiving writes these fields.
// Natural simulation and geometry repair use them as lookup tables.
const inputFields = new Set(['ops', 'terrain', 'roots', 'participants', 'archivedCatalog', 'chatSources', 'chats', 'archives']);

// Track writes on the worker's private copy. Reads of old records do not put
// them in a message. Collections can be replaced by the simulation as a whole
// (notably contacts), in which case additions and removals must both be sent.
function trackWorld(source) {
  const knownFish = new Map(Object.keys(source.fishes).map((id, index) => [id, index]));
  const proxies = new WeakMap(), originals = new WeakMap();
  const values = new Set(), rows = new Map(), lifeFields = new Set(), bondRows = new Map();
  const raw = object => originals.get(object) || object;
  let characters, ecology, previousBonds, orderedBonds = false;
  let fishRoster, poseRevision = 0;
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
    if (field === 'chars' && property === undefined) return { field, id, property: key };
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
      else if (!bondRows.has(key)) bondRows.set(key, raw((previousBonds || target)[key]));
      else if (!Object.hasOwn(target, key) && bondRows.get(key) !== undefined) orderedBonds = true;
    } else if (part === undefined && key === 'bonds' && target[key] && value) {
      const previous = raw(target[key]), next = raw(value);
      const before = Object.keys(previous), after = Object.keys(next);
      if (orderedBonds || before.length !== after.length || before.some((id, index) => after[index] !== id)) {
        previousBonds ??= previous;
        orderedBonds = true;
        return;
      }
      for (const id of after) if (!bondRows.has(id) && raw(previous[id]) !== raw(next[id])) bondRows.set(id, raw(previous[id]));
      if (after.length && bondRows.size === after.length) orderedBonds = true;
    } else lifeFields.add(part ?? key);
  }
  function mark(target, parent, key, value, deleting = false) {
    const { field, id, property } = parent;
    if (parent.root && (key === 'fishes' || key === 'travel') ||
        field === 'fishes' && (parent.table || !property && (key === 'id' || key === 'created' || key === 'lastFed' || key === 'lastMealAt')) ||
        field === 'travel' && parent.table && !value) fishRoster = undefined;
    if (parent.root && key === 'fishes' || field === 'fishes' && (parent.table || !property && (key === 'x' || key === 'y' || key === 'facing'))) poseRevision++;
    if (parent.root && key === 'chars') {
      ecology = undefined;
      characters = undefined;
      characterViews.clear();
    } else if (field === 'chars') {
      if (parent.table) {
        ecology = undefined;
        characters = undefined;
        invalidateCharacterViews(target[key]?.kind, value?.kind);
      } else if (property === 'path' || !property && (key === 'kind' || key === 'entity' || key === 'path' || key === 'wild' || target.kind === 'fish' && (key === 'x' || key === 'y' || key === 'id'))) {
        ecology = undefined;
        if (key === 'kind' && target === raw(source.chars[id])) invalidateCharacterViews(target.kind, value);
      }
    }
    if (parent.root) {
      // The contact clock replaces the entire ordered table, including rows
      // that kept their value but moved after another pair joined or left.
      if (key === 'contacts') values.add(key);
      else if (worldTables.has(key) && !deleting) {
        const previous = raw(target[key]) || {}, next = raw(value) || {};
        for (const id in previous) if (!Object.hasOwn(next, id)) tableChanges(key).set(id, null);
        for (const id in next) if (raw(previous[id]) !== raw(next[id])) tableChanges(key).set(id, null);
      } else values.add(key);
    } else if (parent.table) tableChanges(field).set(key, null);
    else if (parent.editable) {
      const changed = tableChanges(field);
      if (!changed.has(id)) changed.set(id, { properties: new Set() });
      let edit = changed.get(id);
      if (!edit) return;
      if (edit === motionEdit || typeof edit === 'string') {
        edit = edit === motionEdit ? { properties: new Set(motionFields) } : { properties: new Set(), days: new Set([edit]) };
        changed.set(id, edit);
      }
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
    const bondTable = location.field === 'life' && location.part === 'bonds' && location.bond === undefined;
    const proxy = new Proxy(object, bondTable ? {
      ...writes,
      get(table, key, receiver) {
        const value = Reflect.get(table, key, receiver);
        return Object.hasOwn(table, key) && value && typeof value === 'object' ? watch(value, child(location, key)) : value;
      }
    } : writes);
    proxies.set(object, proxy); originals.set(proxy, object); locations.set(object, location);
    if (bondTable) return proxy;
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
    if (typeof edit === 'string') return [id, edit, raw(row.days)[edit]];
    const delta = [id, ...encodeFields(row, edit.properties, plain)];
    if (edit.days && !edit.properties.has('days')) delta.push(encodeFields(raw(row.days), edit.days, plain));
    return delta;
  }
  function encodeBond(id, row) {
    const next = raw(row);
    if (!bondRows.has(id) && !previousBonds) return [id];
    const old = bondRows.has(id) ? bondRows.get(id) : raw(previousBonds[id]);
    if (old === next) return [id];
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
    if (orderedBonds) {
      const keys = Object.keys(table), counters = new Float64Array(keys.length * 2), at = source.life.at;
      for (const [i, id] of keys.entries()) {
        const row = raw(table[id]);
        if (row && Object.is(row.at, at) && Object.is(row.lastNear, at) && Number.isFinite(row.seconds) && Number.isFinite(row.run) &&
            typeof row.a === 'string' && typeof row.b === 'string' && !row.a.includes('|') && id === row.a + '|' + row.b &&
            Object.keys(row).join(',') === 'a,b,seconds,at,lastNear,run') {
          counters[i * 2] = row.seconds;
          counters[i * 2 + 1] = row.run;
        } else {
          counters[i * 2] = NaN;
          set.push(encodeBond(id, row));
        }
      }
      return { keys, counters, at, set };
    }
    for (const id of bondRows.keys()) {
      if (Object.hasOwn(table, id)) set.push(encodeBond(id, table[id]));
      else remove.push(id);
    }
    return { set, remove, ordered: orderedBonds };
  }
  function reset() {
    values.clear(); rows.clear(); lifeFields.clear(); bondRows.clear(); previousBonds = undefined; orderedBonds = false;
  }
  return {
    data: watch(source, { root: true }),
    // Callers enumerate this read-only list. Its rows still carry tracked writes.
    charValues,
    bondEntries: () => Object.entries(raw(source.life.bonds)),
    ecologyCharacters: () => ecology ??= indexEcologyCharacters(allCharacters()),
    poseRevision: () => poseRevision,
    readFish: id => raw(source.fishes[id]),
    fishValues: () => fishRoster ??= Object.values(raw(source.fishes)),
    // Swimming owns these six scalar fields until the ordered movement pass
    // completes. Other writes to the same fish still join the ordinary edit.
    movingFish(fish) {
      const edits = tableChanges('fishes'), id = fish.id;
      if (!edits.has(id)) edits.set(id, motionEdit);
      else {
        const edit = edits.get(id);
        if (edit && edit !== motionEdit) for (const key of motionFields) edit.properties.add(key);
      }
      poseRevision++;
      return raw(fish);
    },
    recordMovement(id, distance, now, day) {
      if (!Number.isFinite(distance) || distance <= 0 || !source.fishes[id]) return;
      day ??= shanghaiDay(now);
      const table = source.travel, record = raw(table[id]);
      if (!record) { table[id] = { since: now, days: { [day]: distance } }; return; }
      const days = raw(record.days), edits = tableChanges('travel');
      days[day] = (days[day] || 0) + distance;
      if (!edits.has(id)) edits.set(id, day);
      else {
        const prior = edits.get(id);
        if (typeof prior === 'string' && prior !== day) edits.set(id, { properties: new Set(), days: new Set([prior, day]) });
        else if (prior && typeof prior !== 'string') (prior.days ||= new Set()).add(day);
      }
    },
    reset,
    changes() {
      const patch = { values: {}, tables: {} };
      for (const field of values) patch.values[field] = plain(source[field]);
      for (const [field, edits] of rows) {
        if (values.has(field)) continue;
        const set = [], remove = [];
        const table = raw(source[field]) || {};
        let motion, offset = 0;
        for (const [id, edit] of edits) {
          if (!Object.hasOwn(table, id)) { remove.push(id); continue; }
          const row = raw(table[id]);
          if (edit === motionEdit && row.posAt === source.tick && Number.isFinite(row.x) && Number.isFinite(row.y) &&
              Number.isFinite(row.facing) && Number.isFinite(row.cx) && Number.isFinite(row.cy)) {
            motion ??= new Float64Array(edits.size * 5);
            set.push(knownFish.get(id) ?? id);
            motion[offset++] = row.x;
            motion[offset++] = row.y;
            motion[offset++] = row.facing;
            motion[offset++] = row.cx;
            motion[offset++] = row.cy;
          } else set.push(encodeRow(id, row, edit));
        }
        patch.tables[field] = motion ? { set, remove, motion: motion.subarray(0, offset) } : { set, remove };
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
      this.world.bondEntries = this.tracker.bondEntries;
      this.world.ecologyCharacters = this.tracker.ecologyCharacters;
      this.world.fishGroups = () => this.world.ecologyCharacters().groups;
      this.world.poseRevision = this.tracker.poseRevision;
      this.world.stableFishRoster = this.tracker.fishValues;
      this.world.readFish = this.tracker.readFish;
      let layout;
      this.world.bodyLayout = groups => layout?.groups === groups ? layout : (layout = new BodyLayout(groups));
      this.world.movingFish = this.tracker.movingFish;
      this.world.recordMovement = this.tracker.recordMovement;
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
        if (meals.length) this.world.appliedClaims = undefined;
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
    try {
      const result = simulation.receive(data), patch = result?.patch;
      const buffers = [patch?.tables.fishes?.motion?.buffer, patch?.life?.bonds?.counters?.buffer].filter(Boolean);
      postMessage({ result }, buffers);
    }
    catch (error) { postMessage({ error: error.message }); }
  };
}
