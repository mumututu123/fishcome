import { characterRevision, subscribeSimulationChanges } from './simulation-changes.js';
import { digestJsonText } from './step-digest.js';

const tables = { chars: new WeakMap(), ops: new WeakMap() };
const size = 128;

function finishMerge(cache) {
  const merge = cache.merge;
  if (!merge) return true;
  cache.merge = undefined;
  const changed = merge[cache.field];
  if (!(changed instanceof Set)) return false;
  for (const id of changed) cache.dirty.add(id);
  return true;
}

subscribeSimulationChanges((world, patch, origin, merge) => {
  for (const field of ['chars', 'ops']) {
    const caches = tables[field], cache = caches.get(world);
    if (!cache) continue;
    if (!finishMerge(cache) || Object.hasOwn(patch?.values ?? {}, field) || !patch && (origin !== 'replica' || !merge)) {
      caches.delete(world);
      continue;
    }
    if (merge) cache.merge = merge;
    const edit = patch?.tables?.[field];
    if (edit) {
      for (const id of edit.remove || []) cache.dirty.add(id);
      for (const [id] of edit.set || []) cache.dirty.add(id);
    }
  }
});

function remember(cache, id) {
  const row = cache.table[id];
  cache.rows.set(id, JSON.stringify([id, row]));
  // Installation of reordered operations must retain all own data, including
  // optional fields a locally created operation might omit from its JSON.
  if (cache.records) cache.records.set(id, structuredClone(row));
}

function hashPage(cache, keys, start) {
  const ids = keys.slice(start, start + size), rows = ids.map(id => cache.rows.get(id));
  cache.pages[start / size] = rows;
  if (cache.records) cache.recordPages[start / size] = ids.map(id => cache.records.get(id));
  return digestJsonText('[' + rows.join(',') + ']');
}

// Keep detached bytes only for rows that have already been read. Natural
// updates and completed merges record every changed ID while the first pass
// yields. Unknown edits discard the pass.
export async function prepareCharacterProof(world, field = 'chars') {
  const caches = tables[field];
  const current = caches.get(world);
  const table = world.data[field];
  if (!table || current?.table === table) return current?.preparing;
  const keys = Object.keys(table);
  const cache = { field, table, keys, rows: new Map(), hashes: [], pages: [], dirty: new Set() };
  if (field === 'ops') { cache.records = new Map(); cache.recordPages = []; }
  caches.set(world, cache);
  cache.preparing = (async () => {
    let slice = performance.now();
    for (let start = 0; start < keys.length; start += size) {
      if (caches.get(world) !== cache) return;
      for (const id of keys.slice(start, start + size)) remember(cache, id);
      cache.hashes.push(hashPage(cache, keys, start));
      if (performance.now() - slice < 2) continue;
      if (globalThis.scheduler?.yield) await scheduler.yield();
      else await new Promise(resolve => (globalThis.setImmediate || setTimeout)(resolve));
      slice = performance.now();
    }
    await Promise.all(cache.hashes);
    cache.prepared = true;
  })();
  return cache.preparing;
}

// Capture actual order and all pending rows within one JavaScript turn. Later
// changes replace page promises. Callers keep an immutable proof of this cut.
export function capturedCharacterProof(world, field = 'chars') {
  const caches = tables[field];
  const cache = caches.get(world);
  if (!cache?.prepared || cache.table !== world.data[field]) return;
  if (!finishMerge(cache)) { caches.delete(world); return; }
  const table = cache.table, keys = Object.keys(table), dirty = cache.dirty;
  for (const id of dirty) {
    if (Object.hasOwn(table, id)) remember(cache, id);
    else { cache.rows.delete(id); cache.records?.delete(id); }
  }
  for (let start = 0; start < keys.length; start += size) {
    const end = Math.min(start + size, keys.length);
    let changed = end > cache.keys.length || end === keys.length && keys.length < cache.keys.length;
    for (let n = start; !changed && n < end; n++) changed = keys[n] !== cache.keys[n] || dirty.has(keys[n]);
    if (changed) cache.hashes[start / size] = hashPage(cache, keys, start);
  }
  cache.hashes.length = Math.ceil(keys.length / size);
  cache.pages.length = cache.hashes.length;
  const pages = cache.pages.slice();
  const records = cache.recordPages?.slice(0, pages.length);
  if (cache.recordPages) cache.recordPages.length = pages.length;
  cache.keys = keys;
  dirty.clear();
  return { revision: characterRevision(world), hashes: Promise.all(cache.hashes), keys,
    encodedRows: () => new Map(keys.map((id, i) => [id, pages[Math.floor(i / size)][i % size]])),
    materialize: () => records ? structuredClone(Object.fromEntries(keys.map((id, i) => [id, records[Math.floor(i / size)][i % size]])))
      : Object.fromEntries(pages.flatMap(page => page.map(row => JSON.parse(row)))) };
}
