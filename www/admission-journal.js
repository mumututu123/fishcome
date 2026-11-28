import { CONFIG } from './engine.js';
import { jsonDigest, stepDigest } from './step-digest.js';

const compareIds = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;

function rowsOf(table) {
  return new Map(Object.entries(table).map(([id, row]) => [id, JSON.stringify([id, row])]));
}
function retainedTable(data, field, captured) {
  const rows = captured?.encodedRows?.() || rowsOf(captured ? captured.materialize() : data[field]);
  return { rows, keys: captured?.keys || Object.keys(data[field]) };
}

function changedRows(table, previous, touched, scan) {
  const keys = Object.keys(table);
  const orderChanged = keys.length !== previous.keys.length || keys.some((key, index) => key !== previous.keys[index]);
  const edits = [];
  const ids = scan ? new Set([...previous.rows.keys(), ...keys]) : touched;
  if (!scan && orderChanged) {
    // Order and row contents are independent parts of the signed result.
    // A newly added food cell can move every subsequent row to another page.
    for (const id of keys) if (!previous.rows.has(id)) ids.add(id);
    for (const id of previous.keys) if (!Object.hasOwn(table, id)) ids.add(id);
  }
  for (const id of ids) {
    const value = Object.hasOwn(table, id) ? JSON.stringify([id, table[id]]) : undefined;
    if (value === previous.rows.get(id)) continue;
    edits.push([id, value ?? null]);
    if (value === undefined) previous.rows.delete(id); else previous.rows.set(id, value);
  }
  previous.keys = keys;
  return [orderChanged ? keys : null, edits.sort(compareIds)];
}

// The signed world frame is an input to World.merge. Its bytes do not prove
// what survived local conflict resolution. Commit the actual merged result.
export class AdmissionJournal {
  constructor(data, characterRows, operationRows) {
    this.tick = data.tick;
    this.previous = Promise.resolve(null);
    this.version = 0;
    this.chars = retainedTable(data, 'chars', characterRows);
    this.ops = retainedTable(data, 'ops', operationRows);
    this.touched = { chars: new Set(), ops: new Set() };
  }
  changed(patch, origin, merge) {
    this.version++;
    if (!patch) {
      if (origin === 'replica' && merge && !this.pendingMerge) this.pendingMerge = merge;
      else this.scan = true;
      return;
    }
    for (const field of ['chars', 'ops']) {
      if (Object.hasOwn(patch.values || {}, field)) this.scan = true;
      const edit = patch.tables?.[field];
      for (const [id] of edit?.set || []) this.touched[field].add(id);
      for (const id of edit?.remove || []) this.touched[field].add(id);
    }
  }
  merged(changes, incoming, archived) {
    if (!changes?.chars || this.pendingMerge !== changes) this.scan = true;
    else {
      for (const id of changes.chars) this.touched.chars.add(id);
      for (const id of changes.ops ?? Object.keys(incoming.ops || {})) this.touched.ops.add(id);
      for (const id of Object.keys(archived?.ops || {})) this.touched.ops.add(id);
    }
    this.pendingMerge = undefined;
  }
  capture(world) {
    const data = world.data;
    if (data.tick === this.tick) return;
    if (this.broken || data.tick !== this.tick + CONFIG.step) { this.broken = true; return; }
    const scan = this.scan || !!this.pendingMerge;
    const chars = changedRows(data.chars, this.chars, this.touched.chars, scan);
    const ops = changedRows(data.ops, this.ops, this.touched.ops, scan);
    this.touched.chars.clear(); this.touched.ops.clear();
    this.pendingMerge = undefined;
    this.scan = false;
    this.tick = data.tick;
    // All remaining fields, including unknown saved tables, are taken from
    // the committed world in this turn. Native JSON retains real key order.
    const current = jsonDigest([chars, ops]);
    const tick = this.tick;
    this.previous = Promise.all([this.previous, current]).then(([prior, result]) =>
      jsonDigest(['verified-world-step-1', tick, prior, result]));
    this.capturedVersion = this.version;
  }
  async proof(world, store, anchor) {
    const { tick, version, previous } = this;
    if (this.broken || world.data.tick !== tick || this.capturedVersion !== version) return;
    if (this.tip?.version === version && this.tip.anchor === anchor && this.tip.revision === store.revision) return this.tip.proof;
    const state = jsonDigest([world.ambient, { ...world.data, chars: null, ops: null }]);
    if (!this.archives || this.archives.revision !== store.revision) {
      this.archives = { revision: store.revision, proof: stepDigest([world.ambient, Object.keys(store.manifests).sort(), store.summary, store.overrides]) };
    }
    const tip = this.tip = { version, anchor, revision: store.revision };
    tip.proof = Promise.all([previous, state, this.archives.proof]).then(parts => {
      tip.parts = parts;
      return jsonDigest(['admission-state-1', anchor, tick, ...parts]);
    });
    return tip.proof;
  }
}
