import { CONFIG } from './engine.js';
import { advanceJourney, shanghaiDay } from './fish-status.js';
import { applyBondIntervals, BondFrame } from './bond-interval.js';

const fields = [['fishes'], ['chars'], ['travel'], ['life', 'bonds'], ['life', 'stories'], ['life', 'events']];
const poseFields = ['x', 'y', 'facing', 'cx', 'cy'];
const travelFields = ['since', 'days'];
const contactFields = ['male', 'female', 'since', 'lastAt'];
export const committedStepFields = new WeakMap();
const confirmedRosters = new WeakMap(), idsByRoster = new WeakMap();
function orderedFishIds(indices) {
  let ids = idsByRoster.get(indices);
  if (!ids) idsByRoster.set(indices, ids = [...indices.keys()]);
  return ids;
}
export function replicaFishIds(world) {
  const indices = confirmedRosters.get(world);
  return indices ? orderedFishIds(indices) : Object.keys(world.fishes);
}
const maxColumns = 30;
const rowTable = value => value && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && !['__proto__', 'prototype', 'constructor'].includes(id);
export const supportsPoseBytes = typeof Uint8Array.prototype.toBase64 === 'function' && typeof Uint8Array.fromBase64 === 'function';
// A daily movement overwrites one number. Independent immutable steps may
// share older days without building two new dictionaries for every swimmer.
export class DailyDistance {
  constructor(prior, day, distance) {
    this.history = prior instanceof DailyDistance ? prior.day === day ? prior.history : prior.row() : prior;
    this.day = day;
    this.distance = distance;
  }
  follows(prior) {
    return this.history === prior || prior instanceof DailyDistance && this.day === prior.day && this.history === prior.history;
  }
  row() {
    return this.materialized ??= { ...this.history, days: { ...this.history.days, [this.day]: this.distance } };
  }
}
export const travelRow = row => row instanceof DailyDistance ? row.row() : row;

// Ordinals are immutable for this confirmed roster. Copying a dense reference
// array preserves old baselines while sparse travel updates touch only movers.
class ConfirmedTravel {
  constructor(indices, updates, previous) {
    this.indices = indices;
    if (previous?.indices === indices) {
      this.values = previous.values.slice();
      this.size = previous.size;
    } else {
      this.values = new Array(indices.size);
      this.size = 0;
      if (previous) for (const [id, index] of indices) {
        const row = previous.get(id);
        if (row) { this.values[index] = row; this.size++; }
      }
    }
    for (const id of Object.keys(updates || {})) {
      const i = indices.get(id);
      if (i === undefined || !updates[id]) continue;
      if (!this.values[i]) this.size++;
      this.values[i] = updates[id];
    }
  }
  get(id) { return this.values[this.indices.get(id)]; }
}
function exactFields(row, expected) {
  const keys = Object.keys(row);
  return keys.length === expected.length && keys.every((key, i) => key === expected[i]);
}

const motionKeys = new Set([...poseFields, 'posAt']);
function poseEdit(edit, row, prior, tick) {
  return edit.length === 3 && !edit[2]?.length && row.posAt === tick && Object.hasOwn(prior, 'posAt') &&
    Object.keys(edit[1]).every(key => motionKeys.has(key)) &&
    poseFields.every(key => Object.hasOwn(prior, key) && Number.isFinite(row[key]));
}

// The receiver indexes rows by its last confirmed packet. Simulation order is
// independent of that order, particularly when parents move as a single body.
export class FishPoseFrame {
  static capture(raw, edits, previous, table, tick) {
    const frame = edits.frame, length = frame ? frame.length : edits.set.length;
    if (!raw?.motion || raw.remove?.length || !length) return;
    const roster = previous?.roster ?? Object.entries(table);
    if (roster.length !== length) return;
    const indices = previous?.indices ?? new Map(roster.map(([id], i) => [id, i]));
    const idAt = i => frame ? frame.idAt(i) : edits.set[i][0];
    if (raw.motion.length === length * 5 && raw.set.every((row, i) => !Array.isArray(row) && idAt(i) === roster[i][0])) {
      return new FishPoseFrame(previous, roster, indices, { motion: raw.motion }, tick);
    }
    const offsets = new Int32Array(length);
    let updated, loose, exceptions, offset = 0;
    for (let i = 0; i < length; i++) {
      const id = idAt(i), ref = indices.get(id), edit = raw.set[i];
      if (ref === undefined || offsets[ref]) return;
      if (!Array.isArray(edit)) {
        offsets[ref] = offset + 1;
        offset += 5;
      } else {
        offsets[ref] = -1;
        const row = frame ? frame.recordAt(i) : edits.set[i][1];
        if (poseEdit(edit, row, roster[ref][1], tick)) {
          (loose ??= [])[ref] = { x: row.x, y: row.y, facing: row.facing, cx: row.cx, cy: row.cy };
        } else {
          const snapshot = structuredClone(row);
          (loose ??= [])[ref] = snapshot;
          (exceptions ??= [])[ref] = snapshot;
          (updated ??= roster.slice())[ref] = [id, snapshot];
        }
      }
    }
    if (offset !== raw.motion.length) return;
    return new FishPoseFrame(previous, updated ?? roster, indices, { motion: raw.motion, offsets, loose }, tick, exceptions);
  }
  constructor(previous, roster, indices, columns, tick, exceptions) {
    this.roster = roster;
    this.indices = indices;
    this.prior = previous?.columns;
    this.exceptions = exceptions;
    this.columns = columns;
    this.tick = tick;
    this.token = {};
  }
  table() {
    if (this.materialized) return this.materialized;
    const table = {}, { motion, offsets, loose } = this.columns;
    for (let i = 0; i < this.roster.length; i++) {
      const [id, cold] = this.roster[i];
      const j = offsets ? offsets[i] - 1 : i * 5;
      table[id] = this.exceptions?.[i] ?? (j < 0 ? { ...cold, ...loose[i], posAt: this.tick } : {
        ...cold, x: motion[j], y: motion[j + 1], facing: motion[j + 2], cx: motion[j + 3], cy: motion[j + 4], posAt: this.tick
      });
    }
    return this.materialized = table;
  }
  encode() {
    const rows = new Array(this.roster.length);
    const { motion, offsets, loose } = this.columns, prior = this.prior;
    for (let i = 0; i < rows.length; i++) {
      const exception = this.exceptions?.[i];
      if (exception) { rows[i] = [this.roster[i][0], exception]; continue; }
      const row = rows[i] = [i, -1], current = loose?.[i], before = prior ? prior.loose?.[i] : this.roster[i][1];
      const nextAt = offsets ? offsets[i] - 1 : i * 5, beforeAt = prior?.offsets ? prior.offsets[i] - 1 : i * 5;
      for (let k = 0; k < 5; k++) {
        const value = current ? current[poseFields[k]] : motion[nextAt + k];
        if (value === (before ? before[poseFields[k]] : prior.motion[beforeAt + k])) continue;
        row[1] -= 1 << k;
        row.push(value);
      }
    }
    return rows;
  }
  // One mask per confirmed fish, followed by the changed doubles in field
  // order. Bit 5 selects the next exceptional complete row. No IDs or decimal
  // conversions are necessary on a stable roster.
  packed() {
    if (this.packedRows) return this.packedRows;
    const bytes = new Uint8Array(this.roster.length * 41), view = new DataView(bytes.buffer);
    const full = [], { motion, offsets, loose } = this.columns, prior = this.prior;
    let offset = 0;
    for (let i = 0; i < this.roster.length; i++) {
      const maskAt = offset++, exception = this.exceptions?.[i];
      if (exception) { bytes[maskAt] = 32; full.push(exception); continue; }
      const current = loose?.[i], before = prior ? prior.loose?.[i] : this.roster[i][1];
      const nextAt = offsets ? offsets[i] - 1 : i * 5, beforeAt = prior?.offsets ? prior.offsets[i] - 1 : i * 5;
      let mask = 0;
      for (let k = 0; k < 5; k++) {
        const value = current ? current[poseFields[k]] : motion[nextAt + k];
        if (value === (before ? before[poseFields[k]] : prior.motion[beforeAt + k])) continue;
        mask |= 1 << k;
        view.setFloat64(offset, value, true);
        offset += 8;
      }
      bytes[maskAt] = mask;
    }
    return this.packedRows = { poses: bytes.subarray(0, offset).toBase64(), ...(full.length && { full }) };
  }
}

export function replicaRowBase(id, world, frames = false, previous) {
  const source = frames && committedStepFields.get(world), poses = source?.poses, trips = source?.trips, bonds = source?.bondFrame;
  const tables = fields.map(([field, table], i) => {
    if (i === 0 && poses) return poses.token;
    if (i === 2 && trips) return trips;
    if (i === 3 && bonds) return bonds;
    return table ? world[field]?.[table] : world[field];
  });
  if (!frames) return { id, tick: world.tick, rows: tables.map(table => Object.entries(table || {})) };
  const rows = [];
  for (let i = 0; i < tables.length; i++) {
    let entries;
    Object.defineProperty(rows, i, { get: () => entries ??= Object.entries((!i && poses ? poses.table() :
      i === 2 && trips ? world.travel : i === 3 && bonds ? bonds.table() : tables[i]) || {}) });
  }
  // Travel is sparse: a fish need not move on successive steps. Both peers
  // retain its last confirmed journey only while it occurs in the fish roster.
  const indices = poses?.indices ?? confirmedRosters.get(world) ?? new Map(rows[0].map(([fish], i) => [fish, i]));
  const travel = new ConfirmedTravel(indices, trips || world.travel, previous?.travel);
  return { id, tick: world.tick, rows, tables, travel, roots: world.roots, terrain: world.terrain,
    get fishIds() { return orderedFishIds(indices); },
    get fishTable() { return poses ? poses.table() : tables[0]; } };
}

function mapTables(world, transform, fishRows, trips, bondRows) {
  const result = {};
  for (const field in world) if (Object.hasOwn(world, field)) result[field] = field === 'fishes' && fishRows ? fishRows : field === 'travel' && trips ? trips : world[field];
  for (const [index, [field, table]] of fields.entries()) {
    if (index === 0 && fishRows) continue;
    const source = index === 3 && bondRows ? bondRows : table ? world[field]?.[table] : result[field];
    if (source === undefined) continue;
    const rows = index === 3 && bondRows ? bondRows : transform(source, index);
    if (!rows) return;
    if (table) {
      if (result[field] === world[field]) {
        result[field] = Object.fromEntries(Object.keys(world[field]).map(key => [key, key === table ? rows : world[field][key]]));
      } else result[field][table] = rows;
    } else result[field] = rows;
  }
  return result;
}

function encodeRow(id, row, index, previous) {
  if (!rowTable(row) || !rowTable(previous)) return [id, row];
  const columns = Object.keys(previous), keys = Object.keys(row);
  if (columns.length > maxColumns || columns.length !== keys.length) return [id, row];
  let changed = 0;
  const values = [];
  for (let column = 0; column < columns.length; column++) {
    const key = columns[column], before = previous[key], after = row[key];
    if (key !== keys[column] || before === undefined || after === undefined) return [id, row];
    if (before === after || before && after && typeof before === 'object' && typeof after === 'object' && JSON.stringify(before) === JSON.stringify(after)) continue;
    changed |= 1 << column;
    values.push(after);
  }
  return [index, changed, ...values];
}

function todayOnly(old, next, day) {
  if (!old || !next || old.since !== next.since || !Number.isFinite(next.days?.[day]) ||
      !rowTable(old.days) || !rowTable(next.days) ||
      !exactFields(old, travelFields) || !exactFields(next, travelFields)) return false;
  const before = Object.keys(old.days), after = Object.keys(next.days);
  if (after.length !== before.length + Number(!Object.hasOwn(old.days, day))) return false;
  return before.every((key, index) => key === after[index] && (key === day || old.days[key] === next.days[key]));
}

export function encodeReplicaRowDelta(body, base, frames = false, poseBytes = false, journeys = false) {
  if (!base || body.delta !== true || body.world.tick !== base.tick + CONFIG.step) return body;
  const compact = frames && !!base.travel;
  const day = compact ? shanghaiDay(body.world.tick) : null;
  const source = compact && committedStepFields.get(body.world);
  const step = source && source.previousFishes === base.tables[0] ? source : null;
  const poses = step?.poses;
  let bondRows;
  if (source?.bondFrame && source.bondFrame === base.tables[3]) bondRows = true;
  else if (step?.bonds && step.bonds.prior === base.tables[3]) {
    const { keys, intervals: { before, length, kept, added } } = step.bonds.changes;
    bondRows = { before, length, kept: Array.from(kept), added: Array.from(added), keys };
  }
  let fishIndices = poses?.indices;
  const world = mapTables(body.world, (table, index) => {
    if (!rowTable(table)) return;
    let known;
    if (compact && index === 0) fishIndices = known = base.travel.indices;
    if (compact && table === base.tables[index]) return true;
    const rows = compact ? [] : {};
    let next = 0;
    for (const id of Object.keys(table)) {
      const candidate = table[id];
      const oldTravel = compact && index === 2 && base.travel.get(id);
      if (oldTravel && fishIndices?.has(id) && (candidate instanceof DailyDistance
          ? candidate.day === day && candidate.follows(oldTravel) : todayOnly(travelRow(oldTravel), candidate, day))) {
        const ordinal = fishIndices.get(id);
        const distance = candidate instanceof DailyDistance ? candidate.distance : candidate.days[day];
        if (journeys) {
          const before = oldTravel instanceof DailyDistance && oldTravel.day === day ? oldTravel.distance : travelRow(oldTravel).days[day] || 0;
          if (before + 1 === distance || before + Math.SQRT2 === distance) {
            rows[next++] = ordinal * 2 + Number(before + 1 !== distance);
            continue;
          }
        }
        rows[next++] = [ordinal, -1, distance];
        continue;
      }
      known ??= new Map(base.rows[index].map(([id], row) => [id, row]));
      const reference = known.get(id), row = travelRow(candidate);
      rows[next++] = encodeRow(id, row, reference, base.rows[index][reference]?.[1]);
    }
    return rows;
  }, poses && (poseBytes && supportsPoseBytes ? poses.packed() : poses.encode()), step?.trips, bondRows);
  if (world && compact) {
    for (const field of ['roots', 'terrain']) if (world[field] && world[field] === base[field]) world[field] = true;
    if (rowTable(world.contacts)) world.contacts = Object.entries(world.contacts).map(([id, row]) => {
      if (row && row.lastAt === world.contactAt && Number.isFinite(row.since) && id === row.male + '|' + row.female &&
          fishIndices?.has(row.male) && fishIndices.has(row.female) && exactFields(row, contactFields)) {
        return [fishIndices.get(row.male), fishIndices.get(row.female), row.since];
      }
      return [id, row];
    });
  }
  return world ? { ...body, rowBase: base.id, ...(compact && { frameRows: true }), world } : body;
}

function decodeRow(encoded, known) {
  if (!Array.isArray(encoded)) return;
  const [reference, changes, ...values] = encoded;
  if (safeId(reference) && encoded.length === 2 && rowTable(changes)) return [reference, changes];
  if (!Number.isSafeInteger(reference) || reference < 0 || reference >= known.length || !Number.isSafeInteger(changes) || changes < 0) return;
  const [id, previous] = known[reference];
  if (!rowTable(previous)) return;
  const columns = Object.keys(previous);
  if (columns.length > maxColumns || changes >= 2 ** columns.length) return;
  let index = 0;
  const row = { ...previous };
  for (let column = 0; column < columns.length; column++) if (changes & 1 << column) row[columns[column]] = values[index++];
  if (index !== values.length) return;
  return [id, row];
}

function unpackPoses(encoded, base, tick) {
  const ids = base.fishIds, previous = base.fishTable;
  const { poses, full = [] } = encoded, n = ids.length;
  if (typeof poses !== 'string' || poses.length > 4 * Math.ceil(41 * n / 3) || !Array.isArray(full) || full.length > n) throw new Error('无效的实时鱼位置长度');
  const bytes = Uint8Array.fromBase64(poses, { lastChunkHandling: 'strict' }), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = {};
  let offset = 0, copied = 0;
  for (const id of ids) {
    const before = previous[id];
    if (!safeId(id)) throw new Error('无效的实时鱼标识');
    const mask = bytes[offset++];
    if (mask === 32 && rowTable(full[copied])) { rows[id] = full[copied++]; continue; }
    if (mask === undefined || mask > 31 || !rowTable(before)) throw new Error('无效的实时鱼位置');
    const fish = { ...before };
    for (let k = 0; k < 5; k++) if (mask & 1 << k) {
      const value = view.getFloat64(offset, true);
      if (!Number.isFinite(value)) throw new Error('实时鱼坐标须为有限数值');
      offset += 8; fish[poseFields[k]] = value || 0;
    }
    fish.posAt = tick;
    rows[id] = fish;
  }
  if (offset !== bytes.length || copied !== full.length) throw new Error('实时鱼位置数量不符');
  return rows;
}

export function decodeReplicaRowDelta(body, base, frames = false, poseBytes = false, journeys = false) {
  if (typeof body.rowBase !== 'string' || body.rowBase.length !== 36 || body.delta !== true) throw new Error('无效的实时变更版本');
  if (base?.id !== body.rowBase) return null;
  if (body.world.tick !== base.tick + CONFIG.step) throw new Error('实时变更不连续');
  const { rowBase, frameRows, ...message } = body;
  if (frameRows !== undefined && (frameRows !== true || !frames || !base.travel)) throw new Error('伙伴未确认实时帧格式');
  const day = frameRows ? shanghaiDay(message.world.tick) : null;
  const world = mapTables(message.world, (encoded, rowsIndex) => {
    if (frameRows && encoded === true && base.tables[rowsIndex]) {
      const table = base.tables[rowsIndex];
      return table instanceof BondFrame ? table.table() : table;
    }
    if (frameRows && rowsIndex === 0 && poseBytes && rowTable(encoded)) return unpackPoses(encoded, base, message.world.tick);
    if (frameRows && rowsIndex === 3 && rowTable(encoded)) {
      const { before, length, kept, added, keys } = encoded;
      return applyBondIntervals(base.tables[rowsIndex], { at: message.world.life.at, keys, intervals: { before, length, kept, added } });
    }
    if (frameRows ? !Array.isArray(encoded) : !rowTable(encoded)) throw new Error('无效的实时变更列表');
    const table = {};
    if (!frameRows && !Object.keys(encoded).every((key, i) => key === String(i))) throw new Error('实时变更列表顺序无效');
    for (const entry of frameRows ? encoded : Object.values(encoded)) {
      let row;
      if (frameRows && rowsIndex === 0 && Array.isArray(entry) && Number.isSafeInteger(entry[1]) && entry[1] < 0) {
        const [index, bits, ...values] = entry, before = Number.isSafeInteger(index) && base.rows[0][index];
        const mask = -1 - bits;
        if (!before || mask >= 2 ** poseFields.length) throw new Error('无效的实时鱼位置');
        const fish = { ...before[1] };
        let offset = 0;
        for (let i = 0; i < poseFields.length; i++) if (mask & (1 << i)) fish[poseFields[i]] = values[offset++];
        if (offset !== values.length || !values.every(Number.isFinite)) throw new Error('无效的实时鱼位置');
        fish.posAt = message.world.tick;
        row = [before[0], fish];
      } else if (frameRows && journeys && rowsIndex === 2 && typeof entry === 'number') {
        const ordinal = Math.floor(entry / 2);
        const id = Number.isSafeInteger(entry) && entry >= 0 && base.fishIds[ordinal];
        const old = id && travelRow(base.travel.get(id));
        if (!old) throw new Error('缺少游动行程基准');
        row = [id, advanceJourney(old, day, (old.days[day] || 0) + (entry % 2 ? Math.SQRT2 : 1))];
      } else if (frameRows && rowsIndex === 2 && Array.isArray(entry) && entry[1] === -1) {
        const [index, , distance] = entry;
        const id = Number.isSafeInteger(index) && base.fishIds[index], old = travelRow(base.travel.get(id));
        if (!old || entry.length !== 3 || !Number.isFinite(distance)) throw new Error('无效的实时行程记录');
        row = [id, advanceJourney(old, day, distance)];
      } else row = decodeRow(entry, base.rows[rowsIndex]);
      if (!row || !safeId(row[0]) || Object.hasOwn(table, row[0])) throw new Error('无效或重复的实时变更记录');
      table[row[0]] = row[1];
    }
    return table;
  });
  if (frameRows) {
    if (poseBytes && rowTable(message.world.fishes) && Object.hasOwn(message.world.fishes, 'poses')) confirmedRosters.set(world, base.travel.indices);
    for (const field of ['roots', 'terrain']) if (world[field] === true) {
      if (!base[field]) throw new Error('缺少实时世界来源');
      world[field] = base[field];
    }
    if (Array.isArray(world.contacts)) {
      const table = {};
      for (const entry of world.contacts) {
        if (!Array.isArray(entry)) throw new Error('无效的实时接触记录');
        let [id, value] = entry;
        if (entry.length === 3 && Number.isSafeInteger(id) && Number.isSafeInteger(value)) {
          const male = base.fishIds[id], female = base.fishIds[value], since = entry[2];
          if (!male || !female || !Number.isFinite(since)) throw new Error('无效的实时接触记录');
          id = male + '|' + female; value = { male, female, since, lastAt: world.contactAt };
        } else if (entry.length !== 2 || !rowTable(value)) throw new Error('无效的实时接触记录');
        if (!safeId(id) || Object.hasOwn(table, id)) throw new Error('重复或无效的实时接触标识');
        table[id] = value;
      }
      world.contacts = table;
    }
  }
  return { ...message, world };
}
