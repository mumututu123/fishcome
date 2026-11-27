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

function expandRow(table, row) {
  if (row.length === 3 && typeof row[1] === 'string') {
    const [id, day, distance] = row, previous = table[id];
    return [id, { ...previous, days: { ...previous.days, [day]: distance } }];
  }
  const [id, fields, removed, days] = row;
  if (row.length < 3) return row.length === 2 ? row : [id, table[id]];
  const previous = table[id], record = applyFields(previous, [fields, removed]);
  if (days) record.days = applyFields(previous.days, days);
  return [id, record];
}

export function rowId(row, knownFish) {
  if (Array.isArray(row)) return row[0];
  return typeof row === 'number' ? knownFish[row] : row;
}

export function expandSimulationPatch(data, patch, knownFish) {
  const tables = { ...patch.tables }, values = { ...patch.values };
  for (const field of ['fishes', 'travel']) {
    const change = tables[field];
    if (!change) continue;
    const table = data[field], motion = change.motion;
    if (motion) {
      let offset = 0;
      const set = change.set.map(row => {
        if (Array.isArray(row)) return expandRow(table, row);
        const id = rowId(row, knownFish), previous = table[id];
        return [id, { ...previous, x: motion[offset++], y: motion[offset++], facing: motion[offset++],
          cx: motion[offset++], cy: motion[offset++], posAt: patch.values.tick }];
      });
      tables[field] = { set, remove: change.remove };
    } else if (change.set.some(row => row.length > 2)) {
      tables[field] = { ...change, set: change.set.map(row => expandRow(table, row)) };
    }
  }
  if (patch.life) {
    const { properties, bonds } = patch.life;
    values.life = applyFields(data.life, properties);
    if (bonds) {
      const previous = data.life.bonds;
      if (bonds.counters) {
        const table = {}, { keys, counters, at } = bonds;
        let exception = 0;
        for (const [i, key] of keys.entries()) {
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
