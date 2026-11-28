import { characterRevision, subscribeSimulationChanges } from './simulation-changes.js';
import { digestJsonText } from './step-digest.js';

const caches = new WeakMap();
const size = 128;

function finishMerge(cache) {
  const merge = cache.merge;
  if (!merge) return true;
  cache.merge = undefined;
  if (!(merge.chars instanceof Set)) return false;
  for (const id of merge.chars) cache.dirty.add(id);
  return true;
}

subscribeSimulationChanges((world, patch, origin, merge) => {
  const cache = caches.get(world);
  if (!cache) return;
  if (!finishMerge(cache) || patch?.values?.chars || !patch && (origin !== 'replica' || !merge)) {
    caches.delete(world);
    return;
  }
  if (merge) cache.merge = merge;
  const edit = patch?.tables?.chars;
  if (edit) {
    for (const id of edit.remove || []) cache.dirty.add(id);
    for (const [id] of edit.set || []) cache.dirty.add(id);
  }
});

function hashPage(cache, keys, start) {
  const rows = keys.slice(start, start + size).map(id => cache.rows.get(id));
  cache.pages[start / size] = rows;
  return digestJsonText('[' + rows.join(',') + ']');
}

// Keep detached bytes only for rows that have already been read. Natural
// updates and completed merges record every changed ID while the first pass
// yields. Unknown edits discard the pass.
export async function prepareCharacterProof(world) {
  const current = caches.get(world);
  if (current?.table === world.data.chars) return current.preparing;
  const table = world.data.chars, keys = Object.keys(table);
  const cache = { table, keys, rows: new Map(), hashes: [], pages: [], dirty: new Set() };
  caches.set(world, cache);
  cache.preparing = (async () => {
    let slice = performance.now();
    for (let start = 0; start < keys.length; start += size) {
      if (caches.get(world) !== cache) return;
      for (const id of keys.slice(start, start + size)) cache.rows.set(id, JSON.stringify([id, table[id]]));
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
export function capturedCharacterProof(world) {
  const cache = caches.get(world);
  if (!cache?.prepared || cache.table !== world.data.chars) return;
  if (!finishMerge(cache)) { caches.delete(world); return; }
  const table = cache.table, keys = Object.keys(table), dirty = cache.dirty;
  for (const id of dirty) {
    if (Object.hasOwn(table, id)) cache.rows.set(id, JSON.stringify([id, table[id]]));
    else cache.rows.delete(id);
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
  cache.keys = keys;
  dirty.clear();
  return { revision: characterRevision(world), hashes: Promise.all(cache.hashes), keys,
    materialize: () => Object.fromEntries(pages.flatMap(page => page.map(row => JSON.parse(row)))) };
}
