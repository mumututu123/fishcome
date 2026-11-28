import { CONFIG } from './engine.js';
import { fishOrigin, writeBreedingRecord } from './breeding.js';
import { replaceLifeHistory, simulationWillApply, simulationApplied, subscribeSimulationChanges, worldRevision, worldTables } from './simulation-changes.js';
import { expandSimulationPatch, rowId } from './simulation-delta.js';
import { SimulationRows } from './simulation-rows.js';
export { subscribeSimulationChanges } from './simulation-changes.js';

// The stored sea supplies the phase of the simulation clock. An independent
// half-second interval can fire just before a step is due, then skip a whole turn.
export function startSimulationClock(readTick, update) {
  function schedule(now) {
    const phase = (now - readTick()) % CONFIG.step;
    const delay = phase < 0 ? -phase : CONFIG.step - phase;
    const due = now + delay;
    function wake() {
      const at = Date.now(), remaining = due - at;
      if (remaining > 0 && remaining <= CONFIG.step) {
        setTimeout(wake, remaining);
        return;
      }
      schedule(at);
      update();
    }
    setTimeout(wake, delay);
  }
  schedule(Date.now());
}

function* initialRows(world) {
  let scanned = 0;
  for (const field of worldTables) {
    const table = world.data[field];
    if (field === 'chats') continue;
    for (const id in table) {
      if (++scanned % 1024 === 0) yield null;
      const row = table[id];
      // The worker advances the ecology. Signed creation/edit history stays
      // with the UI replica, which verifies, stores and forwards it.
      if (field === 'ops') {
        if (row.kind === 'scene') yield [field, id, { kind: 'scene' }];
        else if (row.kind === 'sceneEdit') yield [field, id, { kind: 'sceneEdit', cell: row.cell }];
      } else if (field === 'fishes') {
        const origin = fishOrigin(world.data, id);
        if (origin?.actor === row.actor && origin?.gender === row.gender && origin) yield [field, id, row];
        else yield [field, id, row, origin ? { actor: origin.actor, gender: origin.gender } : null];
      } else if (field === 'breeding') {
        if (row.status === 'active') yield [field, id, row];
      } else if (field === 'chatSources') {
        yield [field, id, { id: row.id, actor: row.actor, kind: row.kind, body: row.body }];
      } else yield [field, id, row];
    }
  }
  const summary = world.archives?.summary;
  if (!summary) return;
  for (const [id, at] of summary.lastMeals) yield ['@lastMeals', id, at];
  for (const id of summary.grassMeals) yield ['@grassMeals', id, true];
}

function applyResult(world, { patch: delta, foodRevision }, knownFish) {
  const patch = expandSimulationPatch(world.data, delta, knownFish, true);
  patch.workerChanges = delta;
  simulationWillApply(world, patch);
  for (const [field, changes] of Object.entries(patch.tables)) {
    const table = world.data[field] ||= {};
    const slots = changes.frame && SimulationRows.for(table, knownFish);
    changes.addedCount = 0;
    changes.removedCount = 0;
    for (const id of changes.remove) if (Object.hasOwn(table, id)) {
      changes.removedCount++;
      delete table[id];
      slots?.remove(id);
    }
    if (changes.frame) {
      changes.addedCount = changes.frame.added.length;
      changes.frame.commit(table);
      continue;
    }
    for (const [id, record] of changes.set) {
      if (!Object.hasOwn(table, id)) changes.addedCount++;
      if (field === 'breeding') writeBreedingRecord(table, id, record);
      else table[id] = record;
    }
  }
  Object.assign(world.data, patch.values);
  world.foodRevision += foodRevision;
  world.dirty = true;
  simulationApplied(world, patch);
}

// The UI owns the last committed step. A foreground operation or coordinator
// change supersedes speculative worker output, even if it changes no tick.
export class SimulationClient {
  constructor(makeWorker = () => new Worker(new URL('./simulation-worker.js', import.meta.url), { type: 'module' })) {
    this.makeWorker = makeWorker;
  }
  close() {
    this.stopInputs?.();
    this.stopInputs = null;
    this.worker?.terminate();
    this.worker = null;
    this.owner = null;
    this.knownFish = null;
    this.historyParts = null;
    this.failure = null;
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(null);
  }
  request(message) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(message);
    });
  }
  atStepBoundary(commit) {
    return new Promise((resolve, reject) => {
      const apply = () => {
        try { resolve(commit()); } catch (error) { reject(error); }
      };
      if (this.task) (this.boundaries ||= []).push(apply);
      else apply();
    });
  }
  archiveAtStepBoundary(world, commit) {
    return this.atStepBoundary(() => {
      const change = commit();
      if (change && this.owner === world) this.archiveChanges.push(change);
      return !!change;
    });
  }
  installLifeHistory(world, life) {
    const hot = this.owner === world && this.tick === world.data.tick && this.revision === worldRevision(world);
    if (hot) {
      const parts = this.historyParts ??= {};
      for (const [key, value] of Object.entries(life)) if (value !== world.data.life[key]) parts[key] = value;
    }
    replaceLifeHistory(world, life);
    if (hot) this.revision = worldRevision(world);
  }
  async syncHistory(valid) {
    const parts = this.historyParts;
    this.historyParts = null;
    await this.request({ kind: 'history', parts });
    return valid();
  }
  finishBoundary() {
    for (const apply of this.boundaries?.splice(0) || []) apply();
  }
  async open(world, valid) {
    this.close();
    const worker = this.worker = this.makeWorker();
    this.knownFish = Object.keys(world.data.fishes);
    SimulationRows.for(world.data.fishes, this.knownFish);
    SimulationRows.for(world.data.travel, this.knownFish);
    this.names = new Map();
    this.foods = new Map();
    this.archiveChanges = [];
    this.stopInputs = subscribeSimulationChanges((source, patch, origin) => {
      if (world !== source || origin !== 'input') return;
      for (const [id, nick] of patch.tables.participants?.set || []) this.names.set(id, nick);
      for (const [id, food] of patch.tables.chars?.set || []) this.foods.set(id, food);
    });
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker || !this.pending) return;
      const { resolve, reject } = this.pending;
      this.pending = null;
      if (data.error) reject(new Error(data.error)); else resolve(data.result);
    };
    const failed = event => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || '后台模拟线程意外停止');
      const pending = this.pending;
      this.pending = null;
      this.close();
      this.failure = { world, error, reported: false };
      pending?.reject(error);
    };
    worker.onerror = worker.onmessageerror = failed;
    const values = {}, tables = [];
    for (const field of Object.keys(world.data)) {
      if (worldTables.has(field)) tables.push(field); else values[field] = world.data[field];
    }
    await this.request({ kind: 'open', values, tables, ambient: world.ambient });
    if (!valid() || this.worker !== worker) return false;
    // Gather the next page while the worker installs the previous one. A single
    // outstanding acknowledgement preserves cancellation and message ordering.
    let rows = [], prior, slice = performance.now();
    for (const row of initialRows(world)) {
      if (row) rows.push(row);
      if (rows.length < 1024 && (row && rows.length % 64 || performance.now() - slice < 2)) continue;
      if (prior) await prior;
      if (!valid() || this.worker !== worker) return false;
      prior = this.request({ kind: 'rows', rows });
      rows = [];
      slice = performance.now();
    }
    if (prior) await prior;
    if (!valid() || this.worker !== worker) return false;
    if (rows.length) await this.request({ kind: 'rows', rows });
    if (!valid() || this.worker !== worker) return false;
    await this.request({ kind: 'ready' });
    if (!valid() || this.worker !== worker) return false;
    this.owner = world;
    this.revision = worldRevision(world);
    this.tick = world.data.tick;
    return true;
  }
  async compute(world, message, valid) {
    this.finishBoundary();
    if (!valid()) { this.close(); return null; }
    if (this.archiveChanges.length) message.archives = this.archiveChanges.splice(0);
    message.names = Array.from(this.names);
    message.foods = Array.from(this.foods);
    this.names.clear();
    this.foods.clear();
    const result = await this.request(message);
    if (!result || !valid()) { this.close(); return null; }
    if (!this.foods.size) {
      applyResult(world, result, this.knownFish);
      return result;
    }
    // A food arrived during this step. Restore the last committed records on
    // the worker before retrying. Table deletions can affect iteration order,
    // and breeding has a separate live index, so rebuild on those rare steps.
    const { tables, values } = result.patch;
    if (tables.breeding || Object.values(tables).some(changes => changes.remove.length)) {
      this.close();
      return null;
    }
    let rows = [];
    for (const [field, changes] of Object.entries(tables)) for (const row of changes.set) {
      const id = rowId(row, this.knownFish);
      rows.push([field, id, world.data[field][id]]);
      if (rows.length < 256) continue;
      await this.request({ kind: 'restore', rows });
      if (!valid() || !this.worker) { this.close(); return null; }
      rows = [];
    }
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, world.data[key]]));
    if (result.patch.life) previous.life = world.data.life;
    if (result.patch.population) previous.population = world.data.population;
    await this.request({ kind: 'restore', rows, previous, foodRevision: result.foodRevision });
    if (!valid() || !this.worker) this.close();
    return null;
  }
  startTask(world, run) {
    this.task = run().catch(error => {
      this.close();
      this.failure = { world, error, reported: true };
      throw error;
    }).finally(() => { this.task = null; this.finishBoundary(); });
    return this.task;
  }
  async prepareAgreed(world, stillValid) {
    if (this.task) await this.task;
    if (this.task || !stillValid()) return null;
    const base = world.data.tick, revision = worldRevision(world);
    const valid = () => stillValid() && world.data.tick === base && worldRevision(world) === revision;
    if (this.owner !== world || this.revision !== revision || this.tick !== base) {
      if (!await this.startTask(world, () => this.open(world, valid))) return null;
    }
    if (this.historyParts && !await this.startTask(world, () => this.syncHistory(valid))) return null;
    return valid() ? { world, base, revision, worker: this.worker } : null;
  }
  async advanceAgreed(world, nextTick, stillValid, prepared) {
    if (!prepared || prepared.world !== world || nextTick !== prepared.base + CONFIG.step || this.task) return null;
    const valid = () => stillValid() && this.worker === prepared.worker && this.owner === world &&
      world.data.tick === prepared.base && this.tick === prepared.base && worldRevision(world) === prepared.revision;
    if (!valid()) return null;
    return this.startTask(world, async () => {
      const result = await this.compute(world, { kind: 'step', base: prepared.base, agreed: true }, valid);
      if (!result) return null;
      this.tick = world.data.tick;
      const tick = this.tick, changesDigest = await this.request({ kind: 'step-proof', tick });
      return changesDigest && stillValid() ? { tick, changesDigest } : null;
    });
  }
  advance(world, now, ownsWorld = () => true, repair = {}) {
    if (this.task) return this.task;
    if (this.failure?.world === world) {
      if (this.failure.reported) return Promise.resolve();
      this.failure.reported = true;
      return Promise.reject(this.failure.error);
    }
    if (!ownsWorld() || world.data.tick + CONFIG.step > now && !repair.geometry && !repair.chat) return Promise.resolve();
    return this.startTask(world, () => this.run(world, now, ownsWorld, repair));
  }
  async run(world, now, ownsWorld, repair) {
    const revision = worldRevision(world);
    let base = world.data.tick;
    const valid = () => ownsWorld() && worldRevision(world) === revision && world.data.tick === base;
    if (this.owner !== world || this.revision !== revision || this.tick !== base) {
      if (!await this.open(world, valid)) { this.close(); return; }
    }
    if (this.historyParts && !await this.syncHistory(valid)) { this.close(); return; }
    if (repair.geometry || repair.chat) {
      const result = await this.compute(world, { kind: 'repair', base, now, geometry: repair.geometry }, valid);
      if (!result) return;
      if (repair.geometry) repair.done?.(result.geometry);
    }
    // Yield the UI event loop between every completed step, including catch-up.
    for (let steps = 0; steps < 20 && base + CONFIG.step <= now; steps++) {
      const result = await this.compute(world, { kind: 'step', base }, valid);
      if (!result) return;
      base = this.tick = world.data.tick;
    }
  }
}
