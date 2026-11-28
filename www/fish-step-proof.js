import { motionFields } from './simulation-delta.js';
import { digestBytes, jsonDigest } from './step-digest.js';

const motion = new Set(motionFields);
const pageSize = 128;
const observedValue = value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value;

// The page covers names, provenance, field order and every additional field.
// Positions come from the same authoritative rows, independently of transfer
// buffers. Reuse a page only after comparing the actual contents of each row.
function metadata(previous, id, row, numeric) {
  if (!row) return { value: [id, row] };
  const keys = Object.keys(row);
  if (previous?.id === id && previous.numeric === numeric && keys.length === previous.keys.length) {
    let same = true;
    for (let k = 0; k < keys.length && same; k++) same = keys[k] === previous.keys[k];
    for (let j = 0; j < previous.fields.length && same; j++) {
      const value = row[previous.fields[j]];
      same = typeof value === previous.types[j] && observedValue(value) === previous.values[j];
    }
    if (same) return previous;
  }
  const fields = numeric ? keys.filter(key => !motion.has(key)) : keys;
  const types = [], values = [];
  for (const key of fields) {
    const value = row[key];
    types.push(typeof value);
    values.push(observedValue(value));
  }
  // Freeze the exact bytes before any later world edit can reach a nested row.
  return { id, keys, fields, numeric, types, values, value: JSON.stringify([id, keys, numeric, types, values]) };
}

export class FishStepProof {
  pages = [];

  async records(refs, idOf, read) {
    const buffer = new ArrayBuffer(refs.length * motionFields.length * 8), poses = new DataView(buffer);
    const next = [], hashes = [];
    let offset = 0;
    for (let start = 0; start < refs.length; start += pageSize) {
      const previous = this.pages[next.length], length = Math.min(pageSize, refs.length - start);
      const rows = new Array(length);
      let same = previous?.rows.length === length;
      for (let i = 0; i < length; i++) {
        const id = idOf(refs[start + i]), row = read(id);
        const numeric = !!row && Number.isFinite(row.x) && Number.isFinite(row.y) && Number.isFinite(row.facing) &&
          Number.isFinite(row.cx) && Number.isFinite(row.cy) && Number.isFinite(row.posAt);
        for (const field of motionFields) {
          if (numeric) poses.setFloat64(offset, row[field] || 0, true);
          offset += 8;
        }
        const old = previous?.rows[i];
        rows[i] = metadata(old, id, row, numeric);
        if (rows[i] !== old) same = false;
      }
      const page = same ? previous : { rows, hash: jsonDigest(rows.map(item => item.value)) };
      next.push(page);
      hashes.push(page.hash);
    }
    this.pages = next;
    const [pages, positions] = await Promise.all([Promise.all(hashes), digestBytes(buffer)]);
    return { pages, positions, count: refs.length };
  }
}
