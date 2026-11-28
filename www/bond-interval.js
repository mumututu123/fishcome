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

export function applyBondIntervals(previous, { at, intervals, keys }) {
  const { before, length, added, kept } = intervals, oldKeys = Object.keys(previous);
  if (!Number.isFinite(at) || !Number.isInteger(length) || length < 0 || length > bondLimit ||
      oldKeys.length !== before || oldKeys.length > bondLimit || !Array.isArray(keys) || keys.length > length ||
      !validBits(added, length) || !validBits(kept, oldKeys.length)) throw new Error('无效的伙伴变更范围');
  const table = {};
  let next = 0, old = 0;
  for (let i = 0; i < length; i++) {
    if (bit(added, i)) {
      const key = keys[next++];
      if (typeof key !== 'string' || !/^[a-z0-9:-]+\|[a-z0-9:-]+$/.test(key) ||
          Object.hasOwn(table, key) || Object.hasOwn(previous, key)) throw new Error('无效的新伙伴');
      const split = key.indexOf('|'), a = key.slice(0, split), b = key.slice(split + 1);
      if (a >= b) throw new Error('无效的伙伴顺序');
      table[key] = { a, b, seconds: 1, at, lastNear: at, run: 0 };
    } else {
      while (old < oldKeys.length && !bit(kept, old)) old++;
      if (old >= oldKeys.length) throw new Error('伙伴基准缺少记录');
      const key = oldKeys[old++], row = previous[key];
      if (row?.at !== at - 1000 || row.lastNear !== row.at || !Number.isFinite(row.seconds) || !Number.isFinite(row.run)) {
        throw new Error('伙伴基准时间不连续');
      }
      table[key] = advanceBond(row, at);
    }
  }
  while (old < oldKeys.length && !bit(kept, old)) old++;
  if (next !== keys.length || old !== oldKeys.length) throw new Error('伙伴变更数量不一致');
  return table;
}
