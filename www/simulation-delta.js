import { applyBondIntervals } from './bond-interval.js';

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

// The page and its observers share one committed set of complete, immutable
// records. Only readers of the older [id, record] interface allocate tuples.
class CommittedRows {
  constructor(field, table, change, knownFish, tick) {
    const { set, motion } = change;
    this.length = set.length;
    this.ids = new Array(set.length);
    this.records = new Array(set.length);
    this.added = [];
    if (field === 'fishes') this.moved = [];
    for (let i = 0, offset = 0; i < set.length; i++) {
      const row = set[i], id = this.ids[i] = rowId(row, knownFish), previous = table[id];
      let record;
      if (motion && !Array.isArray(row)) {
        record = poseRecord(previous, motion, offset, tick);
        offset += 5;
      } else record = expandedRecord(table, row);
      this.records[i] = record;
      if (!Object.hasOwn(table, id)) this.added.push(id);
      if (this.moved && (!previous || previous.x !== record.x || previous.y !== record.y || previous.facing !== record.facing)) this.moved.push(i);
    }
  }
  idAt(i) { return this.ids[i]; }
  commit(table) {
    for (let i = 0; i < this.length; i++) table[this.ids[i]] = this.records[i];
  }
  entries() {
    return this.pairs ??= this.ids.map((id, i) => [id, this.records[i]]);
  }
}

export function expandSimulationPatch(data, patch, knownFish, commitRows = false) {
  const tables = { ...patch.tables }, values = { ...patch.values };
  for (const field of ['fishes', 'travel', 'chars']) {
    const change = tables[field];
    if (!change) continue;
    const table = data[field], motion = change.motion;
    if (commitRows && field !== 'chars') {
      const frame = new CommittedRows(field, table, change, knownFish, patch.values.tick);
      tables[field] = { frame, remove: change.remove, get set() { return frame.entries(); } };
    } else if (motion) {
      let offset = 0;
      const set = change.set.map(row => {
        if (Array.isArray(row)) return expandRow(table, row);
        const id = rowId(row, knownFish), record = poseRecord(table[id], motion, offset, patch.values.tick);
        offset += 5;
        return [id, record];
      });
      tables[field] = { set, remove: change.remove };
    } else if (change.set.some(row => row.length > 2)) {
      tables[field] = { ...change, set: change.set.map(row => expandRow(table, row)) };
    }
  }
  if (patch.life) {
    const { properties, stories, bonds } = patch.life;
    values.life = applyFields(data.life, properties);
    if (stories) values.life.stories = applyStoryChanges(data.life.stories, stories);
    if (bonds) {
      const previous = data.life.bonds;
      if (bonds.intervals) values.life.bonds = applyBondIntervals(previous, bonds);
      else if (bonds.counters) {
        const table = {}, { keys, counters, at } = bonds;
        let exception = 0;
        for (let i = 0; i < counters.length / 2; i++) {
          const key = keys[i];
          const seconds = counters[i * 2];
          if (Number.isNaN(seconds)) {
            Object.defineProperty(table, key, { value: expandRow(previous, bonds.set[exception++])[1], writable: true, enumerable: true, configurable: true });
            continue;
          }
          const split = key.indexOf('|');
          table[key] = { a: key.slice(0, split), b: key.slice(split + 1), seconds, at, lastNear: at, run: counters[i * 2 + 1] };
        }
        values.life.bonds = table;
      } else {
        const changed = Object.fromEntries(bonds.set.map(row => expandRow(previous, row)));
        values.life.bonds = bonds.ordered ? changed : applyFields(previous, [changed, bonds.remove]);
      }
    }
  }
  return patch.swims ? { values, tables, swims: patch.swims } : { values, tables };
}
