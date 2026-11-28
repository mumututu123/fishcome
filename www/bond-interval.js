export const bondLimit = 4096;

// A row records the start of uninterrupted one-second observations. Only the
// canonical writer can extend it. Pauses, time jumps and edits close the span.
export function advanceBond(row, at) {
  if (row.at === at) return row;
  const seconds = (at - row.at) / 1000;
  return { a: row.a, b: row.b, seconds: Math.min(3600, row.seconds + seconds),
    at, lastNear: at, run: Math.min(120, row.run + seconds) };
}

const bit = (bits, i) => bits[i >>> 3] & 1 << (i & 7);
const mark = (bits, i) => { bits[i >>> 3] |= 1 << (i & 7); };

export function encodeBondIntervals(previous, table, keys, at) {
  const kept = new Uint8Array(Math.ceil(previous.keys.length / 8));
  const added = new Uint8Array(Math.ceil(keys.length / 8)), names = [];
  for (let i = 0; i < previous.keys.length; i++) if (table[previous.keys[i]]) mark(kept, i);
  for (let i = 0; i < keys.length; i++) if (!previous.table[keys[i]]) {
    mark(added, i);
    names.push(keys[i]);
  }
  return { at, intervals: { before: previous.keys.length, kept, added, length: keys.length }, keys: names };
}

function validBits(bits, size) {
  return bits?.length === Math.ceil(size / 8) &&
    (bits instanceof Uint8Array || Array.isArray(bits) && bits.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) &&
    (!(size & 7) || !(bits[bits.length - 1] >>> (size & 7)));
}

function sameBondKeys(kept, added, length) {
  const tail = length % 8;
  return added.every(byte => byte === 0) &&
    kept.every((byte, i) => byte === (tail && i === kept.length - 1 ? (1 << tail) - 1 : 255));
}

function readBondIntervals(previous, { at, intervals, keys }, frame) {
  const prior = previous instanceof BondFrame ? previous : null;
  const { before, length, added, kept } = intervals, oldKeys = prior?.names ?? Object.keys(previous);
  if (!Number.isFinite(at) || !Number.isInteger(length) || length < 0 || length > bondLimit ||
      oldKeys.length !== before || oldKeys.length > bondLimit || !Array.isArray(keys) || keys.length > length ||
      !validBits(added, length) || !validBits(kept, oldKeys.length)) throw new Error('无效的伙伴变更范围');
  const validated = frame?.writableTable && prior?.writableTable && !prior.materialized && !prior.fractionalRows && prior.at === at - 1000;
  if (validated && length === before && keys.length === 0 && sameBondKeys(kept, added, length)) {
    prior.sharedRows = true;
    frame.names = prior.names;
    frame.rows = prior.rows;
    frame.nameIndex = prior.nameIndex;
    prior.nameIndex = undefined;
    return;
  }
  const table = frame ? null : {};
  const oldNames = prior && keys.length ? (validated && prior.nameIndex) || new Set(oldKeys) : null;
  const nameIndex = validated && (prior.nameIndex || oldNames);
  const removedNames = nameIndex && [];
  const newNames = frame && keys.length ? new Set() : null;
  let next = 0, old = 0;
  for (let i = 0; i < length; i++) {
    let key, row;
    if (bit(added, i)) {
      key = keys[next++];
      if (typeof key !== 'string' || !/^[a-z0-9:-]+\|[a-z0-9:-]+$/.test(key) ||
          (table ? Object.hasOwn(table, key) : newNames?.has(key)) ||
          (prior ? oldNames?.has(key) : Object.hasOwn(previous, key))) throw new Error('无效的新伙伴');
      const split = key.indexOf('|'), a = key.slice(0, split), b = key.slice(split + 1);
      if (a >= b) throw new Error('无效的伙伴顺序');
      row = { a, b, seconds: 1, at, lastNear: at, run: 0 };
      newNames?.add(key);
    } else {
      while (old < oldKeys.length && !bit(kept, old)) {
        if (removedNames) removedNames.push(oldKeys[old]);
        old++;
      }
      if (old >= oldKeys.length) throw new Error('伙伴基准缺少记录');
      key = oldKeys[old];
      row = prior ? prior.rows[old] : previous[key];
      old++;
      // An unexposed writable frame has already checked the retained rows.
      if (!validated) {
        if ((prior?.at ?? row?.at) !== at - 1000 || row.lastNear !== row.at || !Number.isFinite(row.seconds) || !Number.isFinite(row.run)) {
          throw new Error('伙伴基准时间不连续');
        }
        const fractional = !Number.isInteger(row.seconds) || !Number.isInteger(row.run);
        if (!frame || fractional || frame.writableTable && !prior) row = advanceBond(row, at);
        else if (frame.writableTable) prior.sharedRows = true;
        if (frame?.writableTable && fractional) frame.fractionalRows = true;
      }
    }
    if (frame) { frame.names[i] = key; frame.rows[i] = row; }
    else table[key] = row;
  }
  while (old < oldKeys.length && !bit(kept, old)) {
    if (removedNames) removedNames.push(oldKeys[old]);
    old++;
  }
  if (next !== keys.length || old !== oldKeys.length) throw new Error('伙伴变更数量不一致');
  if (validated && length > keys.length) prior.sharedRows = true;
  if (nameIndex) {
    // Move the lookup to its next owner after validation. The old frame can
    // still rebuild its lookup from its unchanged ordered names.
    prior.nameIndex = undefined;
    for (const key of removedNames) nameIndex.delete(key);
    for (const key of keys) nameIndex.add(key);
    frame.nameIndex = nameIndex;
  }
  return table;
}

export function applyBondIntervals(previous, changes) {
  return readBondIntervals(previous, changes);
}

export class BondFrame {
  constructor(previous, changes, writableTable = false) {
    this.at = changes.at;
    this.writableTable = writableTable;
    this.names = [];
    this.rows = [];
    readBondIntervals(previous, changes, this);
  }
  table() {
    if (this.materialized) return this.materialized;
    const table = {};
    for (let i = 0; i < this.names.length; i++) {
      const row = this.rows[i], record = advanceBond(row, this.at);
      table[this.names[i]] = this.sharedRows && record === row ? { ...row } : record;
    }
    return this.materialized = table;
  }
}
