import { CONFIG } from './engine.js';
import { shanghaiDay } from './fish-status.js';
import { applyBondIntervals } from './bond-interval.js';

const fields = [['fishes'], ['chars'], ['travel'], ['life', 'bonds'], ['life', 'stories'], ['life', 'events']];
const poseFields = ['x', 'y', 'facing', 'cx', 'cy'];
const travelFields = ['since', 'days'];
const contactFields = ['male', 'female', 'since', 'lastAt'];
export const committedStepFields = new WeakMap();
const maxColumns = 30;
const rowTable = value => value && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && !['__proto__', 'prototype', 'constructor'].includes(id);
function exactFields(row, expected) {
  const keys = Object.keys(row);
  return keys.length === expected.length && keys.every((key, i) => key === expected[i]);
}

// A uniform swimming step owns the numeric buffer transferred by the worker.
// Cold columns are shared with an already detached roster. The full dictionary
// is needed only for a legacy reader, a repair or a change of roster.
export class FishPoseFrame {
  static capture(raw, edits, previous, table, tick) {
    const frame = edits.frame, length = frame ? frame.length : edits.set.length;
    if (!raw?.motion || raw.remove?.length || raw.motion.length !== length * 5) return;
    const roster = previous?.roster ?? Object.entries(table);
    if (!roster.length || roster.length !== length) return;
    for (let i = 0; i < roster.length; i++) {
      if (Array.isArray(raw.set[i]) || roster[i][0] !== (frame ? frame.idAt(i) : edits.set[i][0])) return;
    }
    return new FishPoseFrame(previous, roster, raw.motion, tick);
  }
  constructor(previous, roster, motion, tick) {
    this.roster = roster;
    this.indices = previous?.indices ?? new Map(roster.map(([id], i) => [id, i]));
    this.priorMotion = previous?.motion;
    this.motion = motion;
    this.tick = tick;
    this.token = {};
  }
  table() {
    if (this.materialized) return this.materialized;
    const table = {};
    let j = 0;
    for (const [id, cold] of this.roster) table[id] = { ...cold,
      x: this.motion[j++], y: this.motion[j++], facing: this.motion[j++],
      cx: this.motion[j++], cy: this.motion[j++], posAt: this.tick };
    return this.materialized = table;
  }
  encode() {
    const rows = new Array(this.roster.length);
    for (let i = 0, j = 0; i < rows.length; i++) {
      const row = rows[i] = [i, -1], cold = this.roster[i][1];
      for (let k = 0; k < 5; k++, j++) {
        if (this.motion[j] === (this.priorMotion ? this.priorMotion[j] : cold[poseFields[k]])) continue;
        row[1] -= 1 << k;
        row.push(this.motion[j]);
      }
    }
    return rows;
  }
}

export function replicaRowBase(id, world, frames = false, previous) {
  const poses = frames && committedStepFields.get(world)?.poses;
  const tables = fields.map(([field, table], i) => !i && poses ? poses.token : table ? world[field]?.[table] : world[field]);
  if (!frames) return { id, tick: world.tick, rows: tables.map(table => Object.entries(table || {})) };
  const rows = [];
  for (let i = 0; i < tables.length; i++) {
    let entries;
    Object.defineProperty(rows, i, { get: () => entries ??= Object.entries((!i && poses ? poses.table() : tables[i]) || {}) });
  }
  // Travel is sparse: a fish need not move on successive steps. Both peers
  // retain its last confirmed journey only while it occurs in the fish roster.
  const travel = new Map();
  for (const [fish] of poses?.roster || rows[0]) {
    const row = world.travel?.[fish] ?? previous?.travel?.get(fish);
    if (row) travel.set(fish, row);
  }
  return { id, tick: world.tick, rows, tables, travel, roots: world.roots, terrain: world.terrain };
}

function mapTables(world, transform, fishRows) {
  const result = {};
  for (const field in world) if (Object.hasOwn(world, field)) result[field] = field === 'fishes' && fishRows ? fishRows : world[field];
  for (const [index, [field, table]] of fields.entries()) {
    if (index === 0 && fishRows) continue;
    const source = table ? world[field]?.[table] : world[field];
    if (source === undefined) continue;
    const rows = transform(source, index);
    if (!rows) return;
    if (table) {
      if (result[field] === world[field]) result[field] = { ...world[field] };
      result[field][table] = rows;
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

export function encodeReplicaRowDelta(body, base, frames = false) {
  if (!base || body.delta !== true || body.world.tick !== base.tick + CONFIG.step) return body;
  const compact = frames && !!base.travel;
  const day = compact ? shanghaiDay(body.world.tick) : null;
  const source = compact && committedStepFields.get(body.world);
  const step = source && source.previousFishes === base.tables[0] ? source : null;
  const poses = step?.poses;
  let fishIndices = poses?.indices;
  const world = mapTables(body.world, (table, index) => {
    if (!rowTable(table)) return;
    if (compact && table === base.tables[index]) return true;
    if (index === 3 && step?.bonds && step.bonds.prior === base.tables[index]) {
      const { keys, intervals: { before, length, kept, added } } = step.bonds.changes;
      return { before, length, kept: Array.from(kept), added: Array.from(added), keys };
    }
    const known = new Map(base.rows[index].map(([id], row) => [id, row]));
    if (compact && index === 0) fishIndices = known;
    const rows = compact ? [] : {};
    let next = 0;
    for (const [id, row] of Object.entries(table)) {
      const reference = known.get(id);
      const oldTravel = compact && index === 2 && base.travel.get(id);
      if (oldTravel && fishIndices?.has(id) &&
          (step?.travelDay === day && step.journeys.get(id) === oldTravel || todayOnly(oldTravel, row, day))) {
        rows[next++] = [fishIndices.get(id), -1, row.days[day]];
        continue;
      }
      rows[next++] = encodeRow(id, row, reference, base.rows[index][reference]?.[1]);
    }
    return rows;
  }, poses?.encode());
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

export function decodeReplicaRowDelta(body, base, frames = false) {
  if (typeof body.rowBase !== 'string' || body.rowBase.length !== 36 || body.delta !== true) throw new Error('无效的实时变更版本');
  if (base?.id !== body.rowBase) return null;
  if (body.world.tick !== base.tick + CONFIG.step) throw new Error('实时变更不连续');
  const { rowBase, frameRows, ...message } = body;
  if (frameRows !== undefined && (frameRows !== true || !frames || !base.travel)) throw new Error('伙伴未确认实时帧格式');
  const day = frameRows ? shanghaiDay(message.world.tick) : null;
  const world = mapTables(message.world, (encoded, rowsIndex) => {
    if (frameRows && encoded === true && base.tables[rowsIndex]) return base.tables[rowsIndex];
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
      } else if (frameRows && rowsIndex === 2 && Array.isArray(entry) && entry[1] === -1) {
        const [index, , distance] = entry;
        const id = Number.isSafeInteger(index) && base.rows[0][index]?.[0], old = base.travel.get(id);
        if (!old || entry.length !== 3 || !Number.isFinite(distance)) throw new Error('无效的实时行程记录');
        row = [id, { ...old, days: { ...old.days, [day]: distance } }];
      } else row = decodeRow(entry, base.rows[rowsIndex]);
      if (!row || !safeId(row[0]) || Object.hasOwn(table, row[0])) throw new Error('无效或重复的实时变更记录');
      table[row[0]] = row[1];
    }
    return table;
  });
  if (frameRows) {
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
          const male = base.rows[0][id]?.[0], female = base.rows[0][value]?.[0], since = entry[2];
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
