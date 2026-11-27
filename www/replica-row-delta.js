import { CONFIG } from './engine.js';

const fields = [['fishes'], ['chars'], ['travel'], ['life', 'bonds'], ['life', 'stories'], ['life', 'events']];
const maxColumns = 30;
const rowTable = value => value && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && !['__proto__', 'prototype', 'constructor'].includes(id);

export function replicaRowBase(id, world) {
  return { id, tick: world.tick, rows: fields.map(([field, table]) => Object.entries((table ? world[field]?.[table] : world[field]) || {})) };
}

function mapTables(world, transform) {
  const result = { ...world };
  for (const [index, [field, table]] of fields.entries()) {
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

export function encodeReplicaRowDelta(body, base) {
  if (!base || body.delta !== true || body.world.tick !== base.tick + CONFIG.step) return body;
  const world = mapTables(body.world, (table, index) => {
    if (!rowTable(table)) return;
    const known = new Map(base.rows[index].map(([id], row) => [id, row]));
    const rows = {};
    let next = 0;
    for (const [id, row] of Object.entries(table)) {
      const reference = known.get(id);
      rows[next++] = encodeRow(id, row, reference, base.rows[index][reference]?.[1]);
    }
    return rows;
  });
  return world ? { ...body, rowBase: base.id, world } : body;
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

export function decodeReplicaRowDelta(body, base) {
  if (typeof body.rowBase !== 'string' || body.rowBase.length !== 36 || body.delta !== true) throw new Error('无效的实时变更版本');
  if (base?.id !== body.rowBase) return null;
  if (body.world.tick !== base.tick + CONFIG.step) throw new Error('实时变更不连续');
  const { rowBase, ...message } = body;
  const world = mapTables(message.world, (encoded, rowsIndex) => {
    if (!rowTable(encoded)) throw new Error('无效的实时变更列表');
    const table = {};
    let index = 0;
    for (const [key, entry] of Object.entries(encoded)) {
      if (key !== String(index++)) throw new Error('实时变更列表顺序无效');
      const row = decodeRow(entry, base.rows[rowsIndex]);
      if (!row || !safeId(row[0]) || Object.hasOwn(table, row[0])) throw new Error('无效或重复的实时变更记录');
      table[row[0]] = row[1];
    }
    return table;
  });
  return { ...message, world };
}
