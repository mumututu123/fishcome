import { worldTables } from './simulation-changes.js';
import { PAGE_HEAD, compatibilityMark, mirrorOldVersion, preserveOldBranch } from './legacy-checkpoint.js';

const FORMAT = 'tide-checkpoint-pages-1';
const PREFIX = 'checkpoint-page';
const PAGE_SIZE = 256;
const pageRange = () => IDBKeyRange.bound([PREFIX], [PREFIX, []]);
const pending = new WeakMap();
const captures = new WeakMap();
const ABSENT = Symbol('absent');
export const checkpointChanged = Symbol('checkpoint changed');
let committed;
let observedRevision;
export const pagedRevision = head => head?.format === FORMAT ? head.revision : undefined;
const revisionOf = head => pagedRevision(head) ?? (head ? compatibilityMark(head).stamp : 'empty');

export function beforeCheckpointPatch(data, patch) {
  const capture = captures.get(data);
  if (!capture) return;
  // Worker patches replace records. Preserve their earlier references until
  // this transaction finishes reading the version at which it started.
  for (const [field, changes] of Object.entries(patch.tables || {})) {
    const source = capture.sources.get(field);
    if (!source) continue;
    let old = capture.before.get(field);
    if (!old) capture.before.set(field, old = new Map());
    const keep = id => { if (!old.has(id)) old.set(id, Object.hasOwn(source, id) ? source[id] : ABSENT); };
    if (!capture.keys.has(field) && (changes.remove.length || changes.set.some(([id]) => !Object.hasOwn(source, id)))) {
      capture.keys.set(field, Object.keys(source));
    }
    for (const id of changes.remove) keep(id);
    for (const [id] of changes.set) keep(id);
  }
}

export function noteCheckpointChanges(data, patch) {
  let dirty = pending.get(data);
  if (!dirty) pending.set(data, dirty = { scan: false, tables: new Map() });
  if (!patch) {
    dirty.scan = true;
    dirty.tables.clear();
    // Foreground edits may mutate arbitrary records in place. A partial copy
    // must never become durable. Retry from a fresh boundary after this edit.
    captures.get(data)?.abort(checkpointChanged);
    return;
  }
  if (dirty.scan) return;
  for (const [field, updates] of Object.entries(patch.tables || {})) {
    let ids = dirty.tables.get(field);
    if (!ids) dirty.tables.set(field, ids = new Map());
    for (const id of updates.remove) ids.set(id, 'removed');
    for (const [id] of updates.set) {
      if (ids.get(id) === 'removed') { dirty.scan = true; dirty.tables.clear(); return; }
      ids.set(id, 'changed');
    }
  }
}

function lookup(capture, field, source, id) {
  const old = capture.before.get(field);
  return old?.has(id) ? old.get(id) : Object.hasOwn(source, id) ? source[id] : ABSENT;
}

function sameRecord(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (!Array.isArray(a) && (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype)) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  return keys.length === other.length && keys.every((key, n) => key === other[n] && sameRecord(a[key], b[key]));
}

function append(table, id) {
  let n = table.pages.length - 1;
  if (n < 0 || table.pages[n].length >= PAGE_SIZE) { n++; table.pages.push([]); }
  table.pages[n].push(id);
  table.byId.set(id, n);
  return n;
}

function* scanLayout(capture, field, source, prior) {
  const ids = capture.keys.get(field) ?? Object.keys(source);
  capture.keys.set(field, ids);
  const compact = prior && prior.pages.length > 1 && (prior.pages.length - 1) * PAGE_SIZE > 2 * ids.length;
  const table = { pages: [], byId: new Map(), source: new WeakRef(source) };
  let pos = 0;
  if (prior && !compact) {
    // Keep existing page boundaries across deletions so removing an early row
    // does not shift every subsequent page. Preserve actual JS iteration order.
    for (const page of prior.pages) {
      const live = [];
      for (const id of page) {
        if (lookup(capture, field, source, id) === ABSENT) continue;
        if (ids[pos++] !== id) { pos = -1; break; }
        table.byId.set(id, table.pages.length);
        live.push(id);
      }
      if (pos === -1) break;
      table.pages.push(live);
      yield;
    }
    if (pos === -1) { pos = 0; table.byId.clear(); table.pages.length = 0; }
  }
  for (; pos < ids.length; pos++) {
    append(table, ids[pos]);
    if (pos % PAGE_SIZE === PAGE_SIZE - 1) yield;
  }
  return table;
}

function* updateLayout(capture, field, source, table, dirty) {
  const touched = new Set();
  let count = 0;
  for (const id of dirty?.keys() || []) {
    let n = table.byId.get(id);
    if (lookup(capture, field, source, id) !== ABSENT) {
      if (n === undefined) n = append(table, id);
    } else if (n !== undefined) {
      table.byId.delete(id);
      table.pages[n] = table.pages[n].filter(key => key !== id);
    }
    if (n !== undefined) touched.add(n);
    if (++count % PAGE_SIZE === 0) yield;
  }
  return touched;
}

function* writePages(store, head, capture, dirty, reuse, incremental) {
  const tables = new Map();
  if (!reuse) store.delete(pageRange());
  for (const field of worldTables) {
    const source = capture.sources.get(field), prior = reuse ? committed.tables.get(field) : null;
    if (!source) {
      if (prior?.pages.length) store.delete(IDBKeyRange.bound([PREFIX, field, 0], [PREFIX, field, prior.pages.length - 1]));
      continue;
    }
    let table = prior, touched;
    if (incremental && prior?.source.deref() === source) {
      touched = yield* updateLayout(capture, field, source, table, dirty?.tables.get(field));
      if (table.pages.length > 1 && table.byId.size < (table.pages.length - 1) * PAGE_SIZE / 2) touched = null;
    }
    if (!touched) table = yield* scanLayout(capture, field, source, prior);
    for (const number of touched || table.pages.keys()) {
      const rows = table.pages[number].map(id => [id, lookup(capture, field, source, id)]);
      const key = [PREFIX, field, number];
      if (!touched && prior && number < prior.pages.length) {
        // Compare against the durable page only when the foreground edit had
        // no row-level journal. No copy of serialized save data lives in RAM.
        const previous = yield store.get(key);
        if (sameRecord(rows, previous)) continue;
      }
      store.put(rows, key);
      yield;
    }
    if (prior && prior.pages.length > table.pages.length) store.delete(IDBKeyRange.bound([PREFIX, field, table.pages.length], [PREFIX, field, prior.pages.length - 1]));
    tables.set(field, table);
    head.lengths[field] = table.pages.length;
  }
  store.put(head, PAGE_HEAD);
  return tables;
}

function* detachedCheckpoint(head, capture) {
  for (const [field, source] of capture.sources) {
    const ids = capture.keys.get(field) ?? Object.keys(source);
    capture.keys.set(field, ids);
    const target = head.checkpoint.world[field];
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      const rows = ids.slice(offset, offset + PAGE_SIZE).map(id => [id, lookup(capture, field, source, id)]);
      for (const [id, value] of structuredClone(rows)) Object.defineProperty(target, id, {
        value, enumerable: true, writable: true, configurable: true
      });
      yield;
    }
  }
}

export function beginCheckpoint(store, prior, checkpoint, options, done, fail) {
  const expected = options.reconciledRevision ?? observedRevision;
  const stale = (options.simulationChanges || options.requireObservedRevision) && expected !== undefined && revisionOf(prior) !== expected;
  if (stale && !options.captureCheckpoint) {
    const error = new Error('另一个页面已保存更新。请刷新本页载入最新存档。');
    error.name = 'CheckpointConflictError';
    throw error;
  }
  if (!checkpoint?.world || typeof checkpoint.world !== 'object') {
    store.delete(pageRange()); store.delete(PAGE_HEAD); store.put(checkpoint, 'checkpoint'); done({ revision: revisionOf(checkpoint) }, checkpoint); return;
  }
  const data = checkpoint.world, world = { ...data }, sources = new Map();
  for (const field of worldTables) {
    if (world[field] && typeof world[field] === 'object' && !Array.isArray(world[field])) {
      sources.set(field, world[field]); world[field] = {};
    }
  }
  const head = { format: FORMAT, revision: crypto.randomUUID(), legacy: prior?.legacy, lengths: {}, checkpoint: structuredClone({ ...checkpoint, world }) };
  let mirror = false;
  if (options.legacyBundle) {
    const old = options.legacyBundle.checkpoint;
    preserveOldBranch(store, prior, options.legacyBundle);
    if (old?.world && !prior?.legacy && !options.mirrorLegacy) {
      // Existing v1 installations keep the original full save for downgrade.
      head.legacy = compatibilityMark(old, crypto.randomUUID());
      store.put({ ...old, pagedBase: head.legacy.token }, 'checkpoint');
    } else {
      mirror = true;
      head.legacy = compatibilityMark(checkpoint, crypto.randomUUID());
    }
  }
  const reuse = prior?.format === FORMAT && committed?.revision === prior.revision;
  const dirty = pending.get(data);
  if (!stale) pending.delete(data);
  const incremental = reuse && options.simulationChanges && committed.data.deref() === data && !dirty?.scan;
  const capture = { sources, keys: new Map(), before: new Map(), abort(error) { captures.delete(data); fail(error); } };
  if (options.simulationChanges) captures.set(data, capture);
  // A stale tab may still send its own signed replica. It cannot replace the
  // version that another tab saved, including identity/metadata in this batch.
  const plan = stale ? detachedCheckpoint(head, capture) : writePages(store, head, capture, dirty, reuse, incremental);
  const advance = previous => {
    try {
      const start = performance.now();
      let calls = 0;
      for (;;) {
        const next = plan.next(previous);
        previous = undefined;
        if (next.done) {
          captures.delete(data);
          if (stale) { done(null, head.checkpoint, true); return; }
          const cache = { revision: head.revision, data: new WeakRef(data), tables: next.value };
          if (options.captureCheckpoint || mirror) readCheckpoint(store, head, snapshot => {
            if (mirror) mirrorOldVersion(store, head, snapshot);
            done(cache, options.captureCheckpoint ? snapshot : undefined);
          }, fail, false);
          else done(cache);
          return;
        }
        if (next.value) { next.value.onsuccess = () => advance(next.value.result); return; }
        if (++calls >= 16 || performance.now() - start >= 4) {
          // An IndexedDB request keeps this single transaction alive across a
          // browser task boundary, allowing input and rendering between batches.
          const barrier = store.get('checkpoint-yield');
          barrier.onsuccess = () => advance();
          return;
        }
      }
    } catch (error) { capture.abort(error); }
  };
  store.transaction.addEventListener('abort', () => captures.delete(data), { once: true });
  advance();
}

export function checkpointCommitted(cache) {
  committed = cache;
  if (cache) observedRevision = cache.revision;
}

export function readCheckpoint(store, head, resolve, reject, remember = true) {
  const finish = value => {
    if (remember && observedRevision === undefined) observedRevision = revisionOf(head);
    resolve(value);
  };
  if (head?.format !== FORMAT) { finish(head); return; }
  const checkpoint = head.checkpoint;
  const invalid = () => reject(new Error('本地存档的记录页不完整'));
  if (!checkpoint?.world || !head.lengths || typeof head.lengths !== 'object' || Array.isArray(head.lengths)) { invalid(); return; }
  const counts = {};
  for (const [field, length] of Object.entries(head.lengths)) {
    const table = checkpoint.world[field];
    if (!worldTables.has(field) || !table || typeof table !== 'object' || Array.isArray(table) ||
        !Number.isSafeInteger(length) || length < 0) { invalid(); return; }
    counts[field] = 0;
  }
  const tables = remember && committed?.revision !== head.revision ? new Map(
    Object.keys(counts).map(field => [field, { pages: [], byId: new Map(), source: new WeakRef(checkpoint.world[field]) }])
  ) : null;
  const request = store.openCursor(pageRange());
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      const [, field, number] = cursor.key;
      const rows = cursor.value;
      if (!Object.hasOwn(counts, field) || number !== counts[field]++ || !Array.isArray(rows)) { invalid(); return; }
      const table = tables?.get(field), page = table && [];
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' ||
            Object.hasOwn(checkpoint.world[field], row[0])) { invalid(); return; }
        const [id, value] = row;
        Object.defineProperty(checkpoint.world[field], id, { value, enumerable: true, writable: true, configurable: true });
        if (table) { page.push(id); table.byId.set(id, number); }
      }
      if (table) table.pages.push(page);
      cursor.continue();
    } else if (Object.entries(counts).some(([field, count]) => count !== head.lengths[field])) reject(new Error('本地存档缺少记录页'));
    else {
      if (tables) committed = { revision: head.revision, data: new WeakRef(checkpoint.world), tables };
      finish(checkpoint);
    }
  };
}
