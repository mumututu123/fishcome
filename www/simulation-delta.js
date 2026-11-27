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
  const [id, fields, removed, days] = row;
  if (row.length < 3) return row.length === 2 ? row : [id, table[id]];
  const previous = table[id], record = applyFields(previous, [fields, removed]);
  if (days) record.days = applyFields(previous.days, days);
  return [id, record];
}

export function expandSimulationPatch(data, patch) {
  const tables = { ...patch.tables }, values = { ...patch.values };
  for (const field of ['fishes', 'travel']) {
    const change = tables[field];
    if (change?.set.some(row => row.length > 2)) {
      const table = data[field];
      tables[field] = { ...change, set: change.set.map(row => expandRow(table, row)) };
    }
  }
  if (patch.life) {
    const { properties, bonds } = patch.life;
    values.life = applyFields(data.life, properties);
    if (bonds) {
      const previous = data.life.bonds;
      const changed = Object.fromEntries(bonds.set.map(row => expandRow(previous, row)));
      values.life.bonds = bonds.ordered ? changed : applyFields(previous, [changed, bonds.remove]);
    }
  }
  return patch.swims ? { values, tables, swims: patch.swims } : { values, tables };
}
