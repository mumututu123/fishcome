const tables = ['fishes', 'chars', 'scenes', 'rocks', 'bubbles'];
const fields = [...tables, 'tick', 'roots', 'terrain', 'life', 'legends', 'population', 'ecology'];
const glyphFields = ['id', 'kind', 'entity', 'x', 'y', 'ch', 'color', 'chat', 'born', 'created', 'swayAt', 'swayFromX', 'ecoGraceAt'];

function pick(source, keys) {
  const selected = {};
  for (const key of keys) if (Object.hasOwn(source, key)) selected[key] = source[key];
  return selected;
}

export function renderBase(data) {
  const result = pick(data, fields);
  result.chars = {};
  for (const id in data.chars) result.chars[id] = pick(data.chars[id], glyphFields);
  return result;
}

export function renderEdits(patch) {
  const raw = patch.workerChanges ?? patch;
  const changes = { values: pick(raw.values, fields), tables: pick(raw.tables, tables) };
  for (const key of ['life', 'population', 'swims']) if (Object.hasOwn(raw, key)) changes[key] = raw[key];
  return changes;
}

export function renderMerge(data, change) {
  const values = pick(data, fields.filter(key => !tables.includes(key)));
  values.rocks = data.rocks;
  values.bubbles = data.bubbles;
  const edits = { values, tables: {} };
  for (const field of ['fishes', 'chars', 'scenes']) {
    const set = [], remove = [];
    for (const id of change[field]) {
      const value = data[field][id];
      if (value) set.push([id, field === 'chars' ? pick(value, glyphFields) : value]);
      else remove.push(id);
    }
    if (set.length || remove.length) edits.tables[field] = { set, remove };
  }
  return edits;
}
