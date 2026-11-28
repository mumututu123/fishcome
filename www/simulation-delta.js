import { applyBondIntervals, BondFrame } from './bond-interval.js';
import { SimulationRows } from './simulation-rows.js';

const bondProjection = Symbol();

// A standalone swimmer publishes one fixed-width row. Ordinary edits and
// lifecycle changes retain their sparse record format.
export const motionFields = ['x', 'y', 'facing', 'cx', 'cy', 'posAt'];

// A complete row is [id, record]. An edit has two more slots for removed
// properties and changes to travel.days, so even an empty edit is distinct.
export function encodeFields(record, keys, materialize) {
  const set = {};
  let remove;
  for (const key of keys) {
    if (Object.hasOwn(record, key)) set[key] = materialize(record[key]);
    else (remove ||= []).push(key);
  }
  return [set, remove];
}

function applyFields(record, [set, remove]) {
  const result = { ...record, ...set };
  for (const key of remove || []) delete result[key];
  return result;
}

function applyLifeFields(life, [set, remove], bonds) {
  if (!bonds) return applyFields(life, [set, remove]);
  const fields = Reflect.ownKeys(life).filter(key => Object.prototype.propertyIsEnumerable.call(life, key));
  const record = Object.fromEntries(fields.map(key => [key, key === 'bonds' ? undefined : life[key]]));
  const next = applyFields(record, [set, remove]);
  if (Object.hasOwn(next, 'bonds') && !(set && Object.hasOwn(set, 'bonds'))) assignBonds(next, bonds);
  return next;
}

const bondProperty = {
  enumerable: true, configurable: true,
  get() { return this[bondProjection].table(); },
  set(value) {
    delete this[bondProjection];
    Object.defineProperty(this, 'bonds', { value, enumerable: true, configurable: true, writable: true });
  }
};

function assignBonds(life, frame) {
  Object.defineProperty(life, bondProjection, { value: frame, configurable: true });
  Object.defineProperty(life, 'bonds', bondProperty);
}

function expandedRecord(table, row) {
  if (row.length === 3 && typeof row[1] === 'string') {
    const [id, day, distance] = row, previous = table[id];
    return { ...previous, days: { ...previous.days, [day]: distance } };
  }
  const [id, fields, removed, days] = row;
  if (row.length < 3) return row.length === 2 ? fields : table[id];
  const previous = table[id], record = applyFields(previous, [fields, removed]);
  if (days) record.days = applyFields(previous.days, days);
  return record;
}
function expandRow(table, row) {
  return row.length === 2 ? row : [row[0], expandedRecord(table, row)];
}
function poseRecord(previous, motion, offset, tick) {
  const record = { ...previous };
  record.x = motion[offset]; record.y = motion[offset + 1]; record.facing = motion[offset + 2];
  record.cx = motion[offset + 3]; record.cy = motion[offset + 4]; record.posAt = tick;
  return record;
}

function copyBase(record, travel) {
  const copy = { ...record };
  if (travel) copy.days = { ...record.days };
  return copy;
}

export function rowId(row, knownFish) {
  if (Array.isArray(row)) return row[0];
  return typeof row === 'number' ? knownFish[row] : row;
}

// A network snapshot owns its new records, and borrows retained rows from
// the preceding detached snapshot.
export function applyStoryChanges(previous, changes, detach = false) {
  const before = Object.entries(previous);
  return Object.fromEntries(changes.map(row => typeof row === 'number' ? before[row] :
    detach ? [row[0], structuredClone(row[1])] : row));
}

// Retain the worker's numbers and the unchanged fields of each record.
class CommittedRows {
  constructor(table, change, knownFish, tick, commitRows) {
    const { set, motion, distances } = change;
    const slots = commitRows && SimulationRows.for(table, knownFish);
    this.set = set;
    this.knownFish = knownFish;
    this.tick = tick;
    this.motion = motion;
    this.distances = distances;
    this.day = change.day;
    this.length = set.length;
    this.offsets = motion && new Int32Array(set.length);
    this.bases = new Array(set.length);
    this.records = new Array(set.length);
    this.pendingSlots = slots && new Array(set.length);
    this.added = [];
    for (let i = 0, offset = 0; i < set.length; i++) {
      const row = set[i], id = this.idAt(i), slot = slots && slots.at(id, this.ordinalAt(i));
      if (slots) this.pendingSlots[i] = slot;
      const prior = slot?.frame, index = slot?.index;
      if (!slot && !Object.hasOwn(table, id)) this.added.push(id);
      if (motion && !Array.isArray(row)) {
        this.offsets[i] = offset + 1;
        this.bases[i] = prior ? prior.baseAt(index, false) : copyBase(slot ? slot.value : table[id], false);
        offset += 5;
      } else if (distances && i < distances.length) {
        this.bases[i] = prior ? prior.baseAt(index, true, this.day) : copyBase(slot ? slot.value : table[id], true);
      } else this.records[i] = expandedRecord(table, row);
    }
  }
  get ids() { return this.keys ??= this.set.map(row => rowId(row, this.knownFish)); }
  idAt(i) { return rowId(this.set[i], this.knownFish); }
  ordinalAt(i) { return typeof this.set[i] === 'number' ? this.set[i] : undefined; }
  baseAt(i, travel, day) {
    const record = this.records[i];
    if (record) return copyBase(record, travel);
    return travel && this.day !== day ? this.readForCheckpoint(i) : this.bases[i];
  }
  recordAt(i) {
    return this.records[i] ??= this.readForCheckpoint(i);
  }
  readForCheckpoint(i) {
    if (this.records[i]) return this.records[i];
    const before = this.bases[i];
    return this.offsets?.[i] ? poseRecord(before, this.motion, this.offsets[i] - 1, this.tick)
      : { ...before, days: { ...before.days, [this.day]: this.distances[i] } };
  }
  forEachPose(visit) {
    for (let i = 0; i < this.length; i++) {
      const offset = this.offsets?.[i];
      if (offset) visit(this.idAt(i), this.motion[offset - 1], this.motion[offset], this.motion[offset + 1]);
      else {
        const { x, y, facing } = this.recordAt(i);
        visit(this.idAt(i), x, y, facing);
      }
    }
  }
  commit(table) {
    const slots = SimulationRows.for(table, this.knownFish);
    for (let i = 0; i < this.length; i++) {
      const slot = this.pendingSlots[i] ?? slots.add(table, this.idAt(i), undefined, this.ordinalAt(i));
      slot.frame = this;
      slot.index = i;
      slot.value = undefined;
    }
    this.pendingSlots = null;
  }
  entries() {
    return this.pairs ??= this.ids.map((id, i) => [id, this.recordAt(i)]);
  }
}

export function expandSimulationPatch(data, patch, knownFish, commitRows = false) {
  const tables = { ...patch.tables }, values = { ...patch.values };
  if (patch.population) {
    const { properties, illnesses } = patch.population;
    values.population = applyFields(data.population, properties);
    if (illnesses) values.population.illnesses = applyFields(data.population.illnesses, illnesses);
  }
  for (const field of ['fishes', 'travel', 'chars']) {
    const change = tables[field];
    if (!change) continue;
    const table = data[field];
    if (field !== 'chars' && (commitRows || change.motion || change.distances)) {
      const frame = new CommittedRows(table, change, knownFish, patch.values.tick, commitRows);
      tables[field] = commitRows ? { frame, remove: change.remove, get set() { return frame.entries(); } }
        : { set: frame.entries(), remove: change.remove };
    } else if (change.set.some(row => row.length > 2)) {
      tables[field] = { ...change, set: change.set.map(row => expandRow(table, row)) };
    }
  }
  if (patch.life) {
    const { properties, stories, bonds } = patch.life;
    const descriptor = commitRows && Object.getOwnPropertyDescriptor(data.life, 'bonds');
    const projection = descriptor?.get === bondProperty.get ? data.life[bondProjection] : undefined;
    values.life = applyLifeFields(data.life, properties, projection);
    if (stories) values.life.stories = applyStoryChanges(data.life.stories, stories);
    if (bonds) {
      if (bonds.intervals && commitRows) {
        assignBonds(values.life, new BondFrame(projection?.materialized ?? projection ?? data.life.bonds, bonds, true));
      }
      else if (bonds.intervals) values.life.bonds = applyBondIntervals(data.life.bonds, bonds);
      else if (bonds.counters) {
        const table = {}, { keys, counters, at } = bonds;
        let exception = 0;
        for (let i = 0; i < counters.length / 2; i++) {
          const key = keys[i];
          const seconds = counters[i * 2];
          if (Number.isNaN(seconds)) {
            const row = bonds.set[exception++];
            const value = row.length === 2 ? row[1] : expandedRecord(data.life.bonds, row);
            Object.defineProperty(table, key, { value, writable: true, enumerable: true, configurable: true });
            continue;
          }
          const split = key.indexOf('|');
          table[key] = { a: key.slice(0, split), b: key.slice(split + 1), seconds, at, lastNear: at, run: counters[i * 2 + 1] };
        }
        values.life.bonds = table;
      } else {
        const changed = Object.fromEntries(bonds.set.map(row => row.length === 2 ? row : expandRow(data.life.bonds, row)));
        values.life.bonds = bonds.ordered ? changed : applyFields(data.life.bonds, [changed, bonds.remove]);
      }
    }
  }
  if (!patch.swims) return { values, tables };
  const swims = patch.swims.map(ids => ids.map(ref => rowId(ref, knownFish)));
  return { values, tables, swims };
}
