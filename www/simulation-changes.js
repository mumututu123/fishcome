import { SimulationRows } from './simulation-rows.js';

const revisions = new WeakMap();
const characterRevisions = new WeakMap();
const listeners = new Set();
const beforePatch = new Set();

export function subscribeBeforeSimulationPatch(listener) {
  beforePatch.add(listener);
  return () => beforePatch.delete(listener);
}

export function simulationWillApply(world, patch) {
  for (const listener of beforePatch) listener(world, patch);
}

export function subscribeSimulationChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function worldRevision(world) { return revisions.get(world) || 0; }
export function characterRevision(world) { return characterRevisions.get(world) || 0; }
function charactersChanged(world) { characterRevisions.set(world, characterRevision(world) + 1); }

export function worldEdited(world, origin, merge) {
  charactersChanged(world);
  SimulationRows.invalidate(world.data.fishes);
  SimulationRows.invalidate(world.data.travel);
  revisions.set(world, worldRevision(world) + 1);
  for (const listener of listeners) listener(world, null, origin, merge);
}

// A verified history replacement has no geometry or table-membership edits.
// Prepared steps must still observe the new revision before they can run.
export function replaceLifeHistory(world, life) {
  const patch = { values: { life }, tables: {} };
  simulationWillApply(world, patch);
  revisions.set(world, worldRevision(world) + 1);
  world.data.life = life;
  simulationApplied(world, patch);
}

export function simulationApplied(world, patch) {
  if (patch.tables.chars || patch.values?.chars) charactersChanged(world);
  if (!patch.workerChanges) {
    for (const field of ['fishes', 'travel']) {
      const remove = patch.tables[field]?.remove;
      if (remove?.length) SimulationRows.removed(world.data[field], remove);
    }
  }
  for (const listener of listeners) listener(world, patch);
}

// Foreground additions replace whole records, so checkpointing, drawing and
// the worker can consume the same changes without rescanning a world.
export function applyInputRows(world, entries) {
  const patch = { values: {}, tables: {} };
  const groups = new Map();
  for (const [field, id, value] of entries) {
    if (!groups.has(field)) groups.set(field, new Map());
    groups.get(field).set(id, value);
  }
  for (const [field, group] of groups) {
    let addedCount = 0;
    for (const id of group.keys()) if (!Object.hasOwn(world.data[field], id)) addedCount++;
    patch.tables[field] = { set: [...group], remove: [], addedCount, removedCount: 0 };
  }
  simulationWillApply(world, patch);
  if (patch.tables.chars) charactersChanged(world);
  for (const [field, group] of groups) for (const [id, value] of group) world.data[field][id] = value;
  world.dirty = true;
  for (const listener of listeners) listener(world, patch, 'input');
}

export function setParticipantName(world, actor, nick) {
  if (typeof nick !== 'string' || world.data.participants[actor] === nick) return false;
  applyInputRows(world, [['participants', actor, nick]]);
  return true;
}

// These dictionaries are keyed by stable world IDs. Smaller world-level fields
// (e.g. the current ecology hour) are replaced as a value.
export const worldTables = new Set(['roots', 'participants', 'fishes', 'chars', 'scenes',
  'ops', 'breeding', 'contacts', 'travel', 'chats', 'chatSources', 'bubbles', 'rocks']);

export const characterPositionFields = ['x', 'y', 'moveAt', 'fall'];
