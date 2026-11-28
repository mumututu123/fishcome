import { BodyMembership } from './body-membership.js';
import { BodyLayout } from './motion-hull.js';
import { World, CONFIG, indexEcologyCharacters } from './engine.js';
import { shanghaiDay } from './fish-status.js';
import { worldTables } from './simulation-changes.js';
import { encodeFields, motionFields } from './simulation-delta.js';
import { advanceBond, encodeBondIntervals } from './bond-interval.js';
import { jsonDigest } from './step-digest.js';

const motionEdit = { properties: motionFields };

// Only a user operation, a verified replica or archiving writes these fields.
// Natural simulation and geometry repair use them as lookup tables.
const inputFields = new Set(['ops', 'terrain', 'roots', 'participants', 'archivedCatalog', 'chatSources', 'chats', 'archives']);

// Track writes on the worker's private copy. Reads of old records do not put
// them in a message. Collections can be replaced by the simulation as a whole
// (notably contacts), in which case additions and removals must both be sent.
function trackWorld(source) {
  const knownFish = new Map(Object.keys(source.fishes).map((id, index) => [id, index]));
  const fishIds = Array.from(knownFish.keys());
  const daysByOrdinal = new Array(knownFish.size);
  // These are the worker's private, mutable records. Keeping the observation
  // with its record avoids growing a world-sized hash table on a step.
  const observation = Symbol('simulation observation');
  const values = new Set(), rows = new Map(), lifeFields = new Set(), bondRows = new Map();
  const populationFields = new Set(), patients = new Set();
  const illnessSchedule = { due: -Infinity };
  const raw = object => object?.[observation]?.target ?? object;
  const bondTimes = new WeakMap();
  let characters, ecology, membership, meals, previousBonds, activeBonds, publishedBonds, orderedBonds = false;
  let fishRoster, previousStories, poseRevision = 0, originRevision = 0;
  const mealEdits = new Set();
  const characterViews = new Map();
  const activeKinds = ['food', 'seaweed', 'scene'];
  const activeKey = JSON.stringify(activeKinds);
  let poses = new Map();
  const allCharacters = () => characters ??= Object.values(raw(source.chars));
  function charValues(...kinds) {
    if (kinds[0] === undefined) return allCharacters();
    const key = JSON.stringify(kinds), cached = characterViews.get(key);
    if (cached) return cached.cells;
    // Settling changes the food and scenery lists together. Rebuild them from
    // their shared membership, without revisiting every glyph of every fish.
    if (key === activeKey && membership) {
      const cells = membership.activeCells();
      characterViews.set(key, { kinds, cells });
      return cells;
    }
    const source = key !== activeKey && kinds.every(kind => activeKinds.includes(kind))
      ? charValues(...activeKinds) : allCharacters();
    const cells = source.filter(cell => kinds.includes(cell.kind));
    characterViews.set(key, { kinds, cells });
    return cells;
  }
  function invalidateCharacterViews(previous, next, sameRow = false) {
    for (const [key, view] of characterViews) {
      const before = view.kinds.includes(previous), after = view.kinds.includes(next);
      if (sameRow ? before !== after : before || after) characterViews.delete(key);
    }
  }
  function ecologyCharacters() {
    if (!ecology) {
      // Food settling into scenery keeps the same position in this combined
      // view. It changes neither the shape of a swimmer nor a previous meal.
      membership ??= new BodyMembership(raw(source.chars), activeKinds);
      membership.flush();
      const cells = meals ? charValues(...activeKinds) : allCharacters();
      ecology = indexEcologyCharacters(cells, membership.groups, meals);
      const { pastMeals, pastGrass, latestMeals } = ecology;
      meals = { pastMeals, pastGrass, latestMeals };
    }
    return ecology;
  }
  function mealPath(path) { return path?.some(event => event?.reason === 'eat'); }
  function noteCharacterChange(target, parent, key, value, deleting) {
    if (parent.table) {
      const previous = target[key];
      membership?.mark(key, true, deleting);
      if (mealPath(previous?.path) || mealPath(value?.path)) meals = undefined;
      characters = ecology = undefined;
      invalidateCharacterViews(previous?.kind, value?.kind);
      return;
    }
    if (parent.property === 'path') {
      // A path edit can replace an event, edit its payload, or truncate its array.
      const changesMeal = Array.isArray(target) ? key === 'length' || target[key]?.reason === 'eat' || value?.reason === 'eat'
        : target.reason === 'eat' || key === 'reason' && value === 'eat';
      if (meals && Array.isArray(target) && target === raw(source.chars[parent.id]?.path) && key === String(target.length) && value?.reason === 'eat') {
        const { target: diner, t } = value;
        meals.pastMeals.add(diner);
        if (source.chars[parent.id]?.wild) meals.pastGrass.add(diner);
        if (Number.isFinite(t) && t > (meals.latestMeals.get(diner) ?? -Infinity)) {
          meals.latestMeals.set(diner, t);
          mealEdits.add(diner);
        }
      } else if (changesMeal) meals = ecology = undefined;
      return;
    }
    if (parent.property !== undefined) return;
    if (key === 'kind') {
      membership?.mark(parent.id);
      if (target === raw(source.chars[parent.id])) invalidateCharacterViews(target.kind, value, true);
      ecology = undefined;
    } else if (target.kind === 'fish' && (key === 'entity' || key === 'x' || key === 'y' || key === 'id')) {
      membership?.mark(parent.id);
      ecology = undefined;
    } else if (key === 'path' && (mealPath(target.path) || mealPath(value)) || key === 'wild' && mealPath(target.path)) {
      meals = ecology = undefined;
    }
  }
  function tableChanges(field) {
    if (!rows.has(field)) rows.set(field, new Map());
    return rows.get(field);
  }
  function child(location, key) {
    if (location.root) return { field: key, table: worldTables.has(key) };
    const { field, id, property, part, bond } = location;
    if (location.table) return { field, id: key, editable: field === 'fishes' || field === 'travel' };
    if (field === 'chars' && property === undefined) return { field, id, property: key };
    if (location.editable && property === undefined) return { ...location, property: key };
    if (field === 'travel' && property === 'days' && location.day === undefined) return { ...location, day: key };
    if (field === 'population') {
      if (part === undefined) return { field, part: key };
      if (part === 'illnesses' && id === undefined) return { ...location, id: key };
    }
    if (field === 'life') {
      if (part === undefined) return { field, part: key };
      if (part === 'bonds' && bond === undefined) return { ...location, bond: key };
    }
    return location;
  }
  function markLife(location, target, key, value) {
    const { part, bond } = location;
    if (part === undefined && key === 'stories' && target.stories && value &&
        !Array.isArray(value) && typeof value === 'object' && !lifeFields.has('stories')) {
      previousStories ??= raw(target.stories);
      return;
    }
    if ((part ?? key) === 'stories') previousStories = undefined;
    if (part === 'bonds' || part === undefined && key === 'bonds') {
      materializeBonds(raw(source.life.bonds));
      if (previousBonds) materializeBonds(previousBonds);
      activeBonds = publishedBonds = undefined;
    }
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
    if (parent.root && (key === 'population' || key === 'fishes') ||
        field === 'fishes' && parent.table && deleting && source.population?.illnesses[key]) illnessSchedule.due = -Infinity;
    if (parent.root && key === 'life') activeBonds = publishedBonds = undefined;
    if (parent.root && (key === 'fishes' || key === 'ops' || key === 'breeding') ||
        field === 'fishes' && (parent.table || !property && (key === 'id' || key === 'gender')) ||
        field === 'breeding' && (key === 'baby' || key === 'gender' || key === 'status' ||
          parent.table && (target[key]?.status === 'born' || value?.status === 'born'))) originRevision++;
    if (parent.root && (key === 'fishes' || key === 'travel') ||
        field === 'fishes' && (parent.table || !property && (key === 'id' || key === 'created')) ||
        field === 'travel' && parent.table && !value) fishRoster = undefined;
    if (field === 'fishes' && !parent.table && !property && (key === 'lastFed' || key === 'lastMealAt')) mealEdits.add(id);
    if (parent.root && key === 'travel') daysByOrdinal.fill(undefined);
    else if (field === 'travel' && (parent.table || !property && key === 'days')) {
      const ordinal = knownFish.get(parent.table ? key : id);
      if (ordinal !== undefined) daysByOrdinal[ordinal] = undefined;
    }
    if (parent.root && key === 'fishes') {
      poseRevision++;
      poses = undefined;
    } else if (field === 'fishes' && (parent.table || !property && (key === 'x' || key === 'y' || key === 'facing'))) {
      poseRevision++;
      const fish = parent.table ? target[key] : target, moved = parent.table ? key : id;
      if (poses && !poses.has(moved)) poses.set(moved, fish && { x: fish.x, y: fish.y, facing: fish.facing });
    }
    if (parent.root && key === 'chars') {
      ecology = membership = meals = undefined;
      characters = undefined;
      characterViews.clear();
    } else if (field === 'chars') noteCharacterChange(target, parent, key, value, deleting);
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
    else if (parent.editable || (field === 'chars' && property === undefined && !deleting &&
      (value === null || typeof value !== 'object'))) {
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
    } else if (field === 'population') {
      const part = parent.part ?? key;
      if (part === 'illnesses') {
        if (parent.part === 'illnesses' && id === undefined && !deleting && source.fishes[key] &&
            value && value.deadline === undefined && Number.isFinite(value.nextLossAt)) {
          if (!value.curedAt) illnessSchedule.due = Math.min(illnessSchedule.due, value.nextLossAt);
        } else illnessSchedule.due = -Infinity;
      }
      // Replacing the table, or reinserting a removed patient, establishes a new order.
      if (parent.part === 'illnesses' && (id !== undefined || !patients.has(key) || Object.hasOwn(target, key))) patients.add(id ?? key);
      else populationFields.add(part);
    } else if (field === 'life') markLife(parent, target, key, value);
    else if (id === undefined) values.add(field);
    else tableChanges(field).set(id, null);
  }
  // Ordinary reads use the record. Every mutation still goes through this barrier.
  const writes = {
    set(target, key, value) {
      if (raw(target[key]) === raw(value) && Object.hasOwn(target, key)) return true;
      const parent = target[observation].location;
      mark(target, parent, key, value);
      target[key] = value && typeof value === 'object' && !isPatientTable(parent) ? watch(value, child(parent, key)) : value;
      return true;
    },
    deleteProperty(target, key) {
      if (!Object.hasOwn(target, key)) return true;
      mark(target, target[observation].location, key, undefined, true);
      return delete target[key];
    }
  };
  function isPatientTable(location) {
    return location.field === 'population' && location.part === 'illnesses' && location.id === undefined;
  }
  function watch(object, location) {
    if (!object || typeof object !== 'object' || inputFields.has(location.field)) return object;
    // Terminal proofs are immutable during natural simulation. Keep the table
    // observed so a new active record or a replacement still enters the patch.
    if (location.field === 'breeding' && location.id !== undefined && object.status && object.status !== 'active') return object;
    const existing = object[observation];
    if (existing) return existing.proxy;
    const bondTable = location.field === 'life' && location.part === 'bonds' && location.bond === undefined;
    const contactTable = location.field === 'contacts' && location.table;
    const lazy = bondTable || contactTable || isPatientTable(location);
    const proxy = new Proxy(object, lazy ? {
      ...writes,
      get(table, key, receiver) {
        if (key === observation) return table[key];
        let value = Reflect.get(table, key, receiver);
        if (bondTable && value && typeof value === 'object') {
          const at = bondTimes.get(table);
          if (at !== undefined) {
            const row = raw(value);
            // A caller may still hold an older table. Its first mutable read
            // owns a private row even when several observations share an anchor.
            if (at !== null && row.at !== at) value = table[key] = advanceBond(row, at);
            else if (!row[observation]) value = table[key] = { ...row };
          }
        }
        return Object.hasOwn(table, key) && value && typeof value === 'object' ? watch(value, child(location, key)) : value;
      }
    } : writes);
    Object.defineProperty(object, observation, { value: { target: object, location, proxy } });
    if (lazy) return proxy;
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
    if (bondTimes.get(value) != null) materializeBonds(value);
    if (Array.isArray(value)) return value.map(plain);
    const result = {};
    for (const key of Object.keys(value)) result[key] = plain(value[key]);
    return result;
  }
  function logicalChanges(patch) {
    // Ordinals belong to one worker's roster. A worker retained across a
    // connection and one opened from the same current checkpoint can assign
    // different numbers to the same fish and encode equal bonds differently.
    const idOf = ref => typeof ref === 'number' ? fishIds[ref] : Array.isArray(ref) ? ref[0] : ref;
    const tables = { ...patch.tables };
    for (const field of ['fishes', 'travel']) {
      const changes = tables[field];
      if (!changes) continue;
      const rows = raw(source[field]);
      tables[field] = { remove: changes.remove, set: changes.set.map(ref => {
        const id = idOf(ref);
        return [id, raw(rows[id])];
      }) };
    }
    const logical = { ...patch, tables };
    if (patch.life?.bonds) {
      const table = raw(source.life.bonds), at = bondTimes.get(table);
      const bonds = Object.keys(table).map(key => {
        const row = raw(table[key]);
        return [key, at == null ? row : advanceBond(row, at)];
      });
      logical.life = { ...patch.life, bonds };
    }
    if (patch.swims) logical.swims = patch.swims.map(ids => ids.map(idOf));
    return logical;
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
  function materializeBonds(table) {
    const at = bondTimes.get(table);
    if (at == null) return table;
    for (const key in table) if (table[key].at !== at) table[key] = advanceBond(raw(table[key]), at);
    bondTimes.set(table, null);
    return table;
  }
  function encodeBonds(table) {
    table = raw(table);
    if (activeBonds?.table === table) {
      const { keys, at, base } = activeBonds;
      publishedBonds = { table, keys, at, retain: row => row[observation]?.target === row ? { ...row } : row };
      if (base) return encodeBondIntervals(base, table, keys, at);
      const counters = new Float64Array(keys.length * 2);
      for (let i = 0; i < keys.length; i++) {
        const row = table[keys[i]];
        counters[i * 2] = row.seconds;
        counters[i * 2 + 1] = row.run;
      }
      return { keys, counters, at, set: [] };
    }
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
  function finitePose(row) {
    return Number.isFinite(row.x) && Number.isFinite(row.y) && Number.isFinite(row.facing) &&
      Number.isFinite(row.cx) && Number.isFinite(row.cy);
  }
  function movingFish(fish) {
    const edits = tableChanges('fishes'), id = fish.id;
    if (!edits.has(id)) edits.set(id, motionEdit);
    else {
      const edit = edits.get(id);
      if (edit && edit !== motionEdit) for (const key of motionFields) edit.properties.add(key);
    }
    poseRevision++;
    return raw(fish);
  }
  // Ordinary fish publish their motion directly in the wire format. Later
  // feeding, death or repairs can still supersede that row in the same step.
  let swimming;
  function readDays(id, ordinal) {
    const record = raw(source.travel[id]);
    if (record) return daysByOrdinal[ordinal] = raw(record.days);
  }
  function beginSwimBatch() {
    const count = knownFish.size;
    return { motion: new Float64Array(count * 5), poses: [], travel: [], distances: new Float64Array(count),
      poseIndex: new Int32Array(count), tripIndex: new Int32Array(count), daysByOrdinal, readDays };
  }
  function completeSwimBatch(frame, day) {
    if (frame.poses.length) {
      poseRevision++;
      tableChanges('fishes');
    }
    if (frame.travel.length) {
      frame.day = day;
      tableChanges('travel');
    }
    if (frame.poses.length || frame.travel.length) swimming = frame;
  }
  function frameRows(field, edits) {
    if (!swimming || (field !== 'fishes' && field !== 'travel')) return [];
    const poses = field === 'fishes', list = poses ? swimming.poses : swimming.travel;
    const index = poses ? swimming.poseIndex : swimming.tripIndex;
    let holes = 0;
    for (const id of edits.keys()) {
      const at = index[knownFish.get(id)];
      if (!at) continue;
      list[at - 1] = null;
      edits.set(id, null);
      holes++;
    }
    if (holes) {
      let count = 0;
      for (let i = 0; i < list.length; i++) if (list[i] !== null) {
        list[count] = list[i];
        if (i !== count) {
          if (poses) swimming.motion.copyWithin(count * 5, i * 5, i * 5 + 5);
          else swimming.distances[count] = swimming.distances[i];
        }
        count++;
      }
      list.length = count;
    }
    return list;
  }
  function reset() {
    swimming = undefined;
    populationFields.clear(); patients.clear();
    previousStories = undefined;
    values.clear(); rows.clear(); lifeFields.clear(); bondRows.clear(); previousBonds = activeBonds = undefined; orderedBonds = false;
  }
  return {
    data: watch(source, { root: true }),
    // Callers enumerate this read-only list. Its rows still carry tracked writes.
    charValues,
    illnessSchedule,
    readBonds: () => materializeBonds(raw(source.life.bonds)),
    readStories: () => raw(source.life.stories),
    activeBondSpans: at => publishedBonds?.at === at && publishedBonds.table === raw(source.life.bonds) ? publishedBonds : null,
    writeActiveBonds(table, keys, at, base) {
      const previous = raw(source.life.bonds);
      previousBonds ??= previous;
      raw(source.life).bonds = watch(table, { field: 'life', part: 'bonds' });
      orderedBonds = true;
      bondTimes.set(table, base ? at : null);
      activeBonds = { table, keys, at, base };
    },
    ecologyCharacters,
    bodyEdits: (before, after) => membership?.edits(before, after),
    poseEdits: () => poses,
    clearPoseEdits: () => { if (poses) poses.clear(); else poses = new Map(); },
    poseRevision: () => poseRevision,
    readFish: id => raw(source.fishes[id]),
    readContacts: () => raw(source.contacts),
    fishValues: () => fishRoster ??= Object.values(raw(source.fishes)),
    mealEdits,
    originRevision: () => originRevision,
    invalidateOrigins: () => { originRevision++; },
    // Swimming owns these six scalar fields until the ordered movement pass
    // completes. Other writes to the same fish still join the ordinary edit.
    movingFish,
    swimOrdinal: id => knownFish.get(id),
    beginSwimBatch,
    completeSwimBatch,
    recordMovement(id, distance, now, day) {
      if (!Number.isFinite(distance) || distance <= 0 || !source.fishes[id]) return;
      day ??= shanghaiDay(now);
      const table = source.travel, record = raw(table[id]);
      if (!record) { table[id] = { since: now, days: { [day]: distance } }; return; }
      const days = raw(record.days);
      days[day] = (days[day] || 0) + distance;
      const edits = tableChanges('travel');
      if (!edits.has(id)) edits.set(id, day);
      else {
        const prior = edits.get(id);
        if (typeof prior === 'string' && prior !== day) edits.set(id, { properties: new Set(), days: new Set([prior, day]) });
        else if (prior && typeof prior !== 'string') (prior.days ||= new Set()).add(day);
      }
    },
    reset,
    logicalChanges,
    changes() {
      const patch = { values: {}, tables: {} };
      for (const field of values) patch.values[field] = plain(source[field]);
      if (!values.has('population') && (populationFields.size || patients.size)) {
        const population = raw(source.population);
        patch.population = { properties: encodeFields(population, populationFields, plain) };
        if (patients.size && !populationFields.has('illnesses')) {
          patch.population.illnesses = encodeFields(raw(population.illnesses), patients, plain);
        }
      }
      for (const [field, edits] of rows) {
        if (values.has(field)) continue;
        const set = frameRows(field, edits), remove = [];
        const distances = field === 'travel' && swimming?.distances?.subarray(0, set.length);
        const table = raw(source[field]) || {};
        let motion = field === 'fishes' ? swimming?.motion : undefined;
        let offset = motion ? set.length * 5 : 0;
        for (const [id, edit] of edits) {
          if (!Object.hasOwn(table, id)) { remove.push(id); continue; }
          const row = raw(table[id]);
          if (edit === motionEdit && row.posAt === source.tick && finitePose(row)) {
            motion ??= new Float64Array(edits.size * 5);
            if (offset + 5 > motion.length) {
              const full = new Float64Array(offset + edits.size * 5);
              full.set(motion); motion = full;
            }
            set.push(knownFish.get(id) ?? id);
            motion[offset++] = row.x;
            motion[offset++] = row.y;
            motion[offset++] = row.facing;
            motion[offset++] = row.cx;
            motion[offset++] = row.cy;
          } else set.push(encodeRow(id, row, edit));
        }
        if (motion && offset * 2 < motion.length) motion = motion.slice(0, offset);
        patch.tables[field] = { set, remove };
        if (motion) patch.tables[field].motion = motion.subarray(0, offset);
        if (distances?.length) Object.assign(patch.tables[field], { day: swimming.day, distances });
      }
      if (!values.has('life') && (lifeFields.size || previousStories || bondRows.size || orderedBonds)) {
        const life = raw(source.life);
        patch.life = { properties: encodeFields(life, lifeFields, plain) };
        if (previousStories) {
          // The bounded chronicle reorders on insertion. Preserve the previous
          // order as a dictionary, even for stories from older saves.
          const before = new Map(Object.keys(previousStories).map((id, i) => [id, i]));
          patch.life.stories = Object.entries(raw(life.stories)).map(([id, row]) =>
            before.has(id) && raw(previousStories[id]) === raw(row) ? before.get(id) : [id, plain(row)]);
        }
        if (!lifeFields.has('bonds') && (bondRows.size || orderedBonds)) patch.life.bonds = encodeBonds(life.bonds);
      }
      reset();
      return patch;
    }
  };
}

export class WorkerSimulation {
  receive(message) {
    if (message.kind === 'step-proof') {
      const patch = this.agreedPatch;
      if (!patch || patch.values.tick !== message.tick) throw new Error('没有此步待确认的生态变化');
      this.agreedPatch = undefined;
      return jsonDigest(this.tracker.logicalChanges(patch));
    }
    this.agreedPatch = undefined;
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
      this.world.readBonds = this.tracker.readBonds;
      this.world.readStories = this.tracker.readStories;
      this.world.activeBondSpans = this.tracker.activeBondSpans;
      this.world.writeActiveBonds = this.tracker.writeActiveBonds;
      this.world.ecologyCharacters = this.tracker.ecologyCharacters;
      this.world.fishGroups = () => this.world.ecologyCharacters().groups;
      this.world.poseRevision = this.tracker.poseRevision;
      this.world.originRevision = this.tracker.originRevision;
      this.world.stableFishRoster = this.tracker.fishValues;
      this.world.illnessSchedule = this.tracker.illnessSchedule;
      this.world.mealEdits = this.tracker.mealEdits;
      this.world.readFish = this.tracker.readFish;
      this.world.readContacts = this.tracker.readContacts;
      let layout;
      this.world.bodyLayout = groups => {
        if (layout?.groups !== groups) {
          const previous = layout;
          const change = previous && this.tracker.bodyEdits(previous.groups, groups);
          layout = previous ? previous.updated(groups, change?.ids, change?.sameOrder) : new BodyLayout(groups);
        }
        return layout;
      };
      this.world.bodyEdits = this.tracker.bodyEdits;
      this.world.poseEdits = this.tracker.poseEdits;
      this.world.clearPoseEdits = this.tracker.clearPoseEdits;
      this.world.movingFish = this.tracker.movingFish;
      this.world.swimOrdinal = this.tracker.swimOrdinal;
      this.world.beginSwimBatch = this.tracker.beginSwimBatch;
      this.world.completeSwimBatch = this.tracker.completeSwimBatch;
      this.world.recordMovement = this.tracker.recordMovement;
      // Index the checkpoint's existing bodies while loading it. Building
      // these lookups needs no future time, input, or simulated movement.
      const groups = this.world.ecologyCharacters().groups;
      this.world.movementGrid(groups).swimmers(this.world, CONFIG.speed);
    } else if (message.kind === 'restore') {
      this.tracker.invalidateOrigins();
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
      if (swims.length) {
        // The page and worker already share this roster for position rows.
        // Fish born since the worker opened still use their full ID.
        for (const ids of swims) if (ids) {
          for (let i = 0; i < ids.length; i++) ids[i] = this.tracker.swimOrdinal(ids[i]) ?? ids[i];
        }
        patch.swims = swims;
      }
      if (message.agreed) this.agreedPatch = patch;
      return { patch, foodRevision: this.world.foodRevision - foodRevision, geometry };
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const simulation = new WorkerSimulation();
  globalThis.onmessage = async ({ data }) => {
    try {
      const result = await simulation.receive(data), patch = result?.patch;
      const bonds = patch?.life?.bonds;
      const buffers = [patch?.tables.fishes?.motion?.buffer, patch?.tables.travel?.distances?.buffer, bonds?.counters?.buffer,
        bonds?.intervals?.kept.buffer, bonds?.intervals?.added.buffer].filter(Boolean);
      // The renderer owns the posted copy. Keep the worker's bytes intact until
      // it hashes the committed step, independently of edits on the page.
      postMessage({ result }, data.agreed ? [] : buffers);
    }
    catch (error) { postMessage({ error: error.message }); }
  };
}
