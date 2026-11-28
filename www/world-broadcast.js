import { breedingForBroadcast, stopBreedingBroadcast } from './breeding.js';
import { replicaRowEquality } from './replica-stream.js';
import { CONFIG } from './engine.js';
import { deltaX } from './geography.js';
import { capturedFishIds } from './legends.js';

// These dictionaries merge by record ID. Contacts are different: a newer
// contactAt replaces the entire contact table, including its unchanged rows.
const rowFields = ['chars', 'fishes', 'scenes', 'participants', 'ops', 'chats', 'chatSources', 'travel', 'rocks'];
const integerPosition = fish => Number.isInteger(fish.x) && fish.x >= 0 && fish.x < CONFIG.width && Number.isSafeInteger(fish.y);

function packet(data, rows, breeding) {
  return {
    protocol: 1, roots: data.roots, terrain: data.terrain, tick: data.tick,
    seaweedHour: data.seaweedHour, bubbleMinute: data.bubbleMinute, bubbles: data.bubbles,
    ...rows, breeding, contacts: data.contacts, contactAt: data.contactAt, notices: [],
    life: data.life, legends: data.legends, ecology: data.ecology, population: data.population, archives: data.archives
  };
}

function fullRows(data) { return Object.fromEntries(rowFields.map(field => [field, data[field] || {}])); }

function baseline(world, at) {
  return { rows: Object.fromEntries(rowFields.map(field => [field, new Map(Object.entries(world[field] || {}))])), fullAt: at, tick: world.tick };
}

function changedRows(data, base, pending) {
  const rows = {};
  const sameRow = replicaRowEquality(data.tick);
  for (const field of rowFields) {
    const table = data[field] || {}, last = base.rows[field];
    const changed = rows[field] = {};
    const check = id => {
      if (!Object.hasOwn(table, id)) { last.delete(id); return; }
      const sent = last.get(id);
      const value = table[id];
      if (sent === undefined ? value !== undefined : !sameRow(field, sent, value)) changed[id] = value;
    };
    if (pending) {
      for (const id of pending.get(field) || []) check(id);
    } else {
      // Foreground edits and merges can modify records in place. Reconcile with
      // the last sent values once, then return to tracking known worker writes.
      for (const id in table) if (Object.hasOwn(table, id)) check(id);
      for (const id of last.keys()) if (!Object.hasOwn(table, id)) last.delete(id);
    }
  }
  return rows;
}

function encodeSwims(fishes, directions) {
  if (!directions?.length) return;
  // Ordinals refer to the fish rows already present in the signed world.
  const byFish = new Map(), result = [];
  for (let direction = 0; direction < 9; direction++) {
    if (direction === 4 || !directions[direction]) continue;
    for (const id of directions[direction]) byFish.set(id, direction);
  }
  let index = 0;
  for (const id in fishes) if (Object.hasOwn(fishes, id)) {
    const direction = byFish.get(id);
    if (direction !== undefined) (result[direction] ||= []).push(index);
    index++;
  }
  if (result.length) return result;
}

function sameReplicaWorld(left, right) {
  const roots = Object.keys(left.roots);
  return left.terrain?.seed === right.terrain?.seed && left.terrain?.createdAt === right.terrain?.createdAt &&
    roots.length === Object.keys(right.roots).length && roots.every(root => Object.hasOwn(right.roots, root) && left.roots[root] === right.roots[root]);
}

function decodeSwims(data, incoming, encoded) {
  if (!Array.isArray(encoded) || encoded.length > 9 || encoded[4] != null) return;
  const ids = Object.keys(incoming.fishes), seen = new Set(), dirs = [], captured = capturedFishIds(data, data.tick);
  const changedBodies = new Set();
  for (const [id, cell] of Object.entries(incoming.chars || {})) {
    const before = data.chars[id];
    if (before?.kind === 'fish') changedBodies.add(before.entity);
    if (cell.kind === 'fish') changedBodies.add(cell.entity);
  }
  for (let direction = 0; direction < encoded.length; direction++) {
    const indices = encoded[direction];
    if (indices == null) continue;
    if (!Array.isArray(indices) || indices.length > ids.length) return;
    const dx = direction % 3 - 1, dy = Math.floor(direction / 3) - 1;
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= ids.length || seen.has(index)) return;
      seen.add(index);
      const id = ids[index], before = data.fishes[id], after = incoming.fishes[id];
      if (before && before.posAt === data.tick && after.posAt === incoming.tick && !captured.has(id) && !changedBodies.has(id) &&
          before.actor === after.actor && before.created === after.created && before.facing === after.facing &&
          integerPosition(before) && integerPosition(after) &&
          (after.facing === -1 || after.facing === 1) && deltaX(after.x, before.x) === dx && after.y - before.y === dy) {
        (dirs[direction] ||= []).push(id);
      }
    }
  }
  return dirs;
}

export class ReplicaSwims {
  reset() { this.latest = null; }

  // The caller has authenticated and verified the packet. Capture origins at
  // the actual merge boundary and publish only positions that won the merge.
  merge(data, { from, actor, body }, apply) {
    const incoming = body.world, tick = data.tick, previous = this.latest;
    const sameWorld = sameReplicaWorld(data, incoming);
    const contiguous = sameWorld && body.delta === true && previous?.data === data && previous.from === from && previous.actor === actor &&
      previous.tick === tick && incoming.tick === tick + CONFIG.step;
    const directions = contiguous ? decodeSwims(data, incoming, body.swims) : undefined;
    apply();
    const mergedWorld = sameReplicaWorld(data, incoming);
    if (!sameWorld || !mergedWorld) this.reset();
    if (data.tick !== incoming.tick || !mergedWorld) return;
    if (directions?.length) {
      const captured = capturedFishIds(data, data.tick);
      for (let direction = 0; direction < directions.length; direction++) if (directions[direction]) {
        directions[direction] = directions[direction].filter(id => {
          const pose = data.fishes[id], sent = incoming.fishes[id];
          return pose?.posAt === incoming.tick && pose.x === sent.x && pose.y === sent.y && pose.facing === sent.facing && !captured.has(id);
        });
      }
    }
    return this.latest = { data, from, actor, tick: incoming.tick, directions: directions?.some(ids => ids.length) ? directions : undefined };
  }
}

export class ReplicaRecovery {
  missed = new Map();

  clear() { this.missed.clear(); }

  ignore({ from, actor, body }) {
    const tick = body?.world?.tick;
    if (!Number.isFinite(tick)) return;
    const previous = this.missed.get(from);
    if (previous?.actor === actor) {
      previous.tick = Math.max(previous.tick, tick);
      previous.revision++;
    } else this.missed.set(from, { actor, tick, revision: 1 });
  }

  request({ from, actor }, now = Date.now()) {
    const missed = this.missed.get(from);
    if (!missed || missed.actor !== actor || missed.request && now - missed.request.at < 5000) return;
    const request = missed.request = { id: crypto.randomUUID(), at: now, revision: missed.revision };
    return { to: from, request: request.id };
  }

  covered({ from, actor, body }, response) {
    const missed = this.missed.get(from), tick = body?.world?.tick;
    if (!missed || missed.actor !== actor || !Number.isFinite(tick) || tick < missed.tick) return;
    if (response ? missed.request?.id === response && missed.request.revision === missed.revision : tick > missed.tick) {
      this.missed.delete(from);
    }
  }
}

export class WorldBroadcast {
  constructor(subscribe) {
    this.observesChanges = !!subscribe;
    subscribe?.((world, patch) => {
      if (world.data !== this.source || !this.pending) return;
      if (!patch) { this.pending = null; return; }
      for (const field of rowFields) {
        if (Object.hasOwn(patch.values || {}, field)) { this.pending = null; return; }
        const changes = patch.tables?.[field];
        if (!changes) continue;
        let ids = this.pending.get(field);
        if (!ids) this.pending.set(field, ids = new Set());
        for (const [id] of changes.set) ids.add(id);
        for (const id of changes.remove) ids.add(id);
      }
    });
  }

  reset() {
    if (this.source) {
      stopBreedingBroadcast(this.trackedBreeding);
      this.needsFull = true;
    }
    this.network?.clearPendingWorld?.();
    this.network = null;
    this.source = null;
    this.previous = null;
    this.pending = null;
    this.generation = (this.generation || 0) + 1;
  }

  takeChanges(data) {
    const pending = this.pending;
    this.source = data;
    this.trackedBreeding = data.breeding;
    this.pending = this.observesChanges ? new Map() : null;
    return pending;
  }

  async captureJoined(data, capture) {
    if (this.previous || this.busy || this.needsFull) return capture();
    const generation = this.generation;
    this.takeChanges(data);
    breedingForBroadcast(data.breeding, true);
    this.busy = true;
    try {
      const snapshot = await capture();
      if (generation === this.generation) this.previous = baseline(snapshot, Date.now());
      return snapshot;
    } finally { this.busy = false; }
  }

  async send(network, data, now = Date.now(), captureFull, directions) {
    if (!network.live().length) { if (this.source) this.reset(); return; }
    const peers = network.worldReplicaPeers?.() ?? network.replicaPeers?.();
    if (peers?.length === 0 || this.busy) return;
    this.busy = true;
    try {
      if (this.source && (this.source !== data || this.trackedBreeding !== data.breeding)) this.reset();
      this.network = network;
      const previous = this.previous && (now - this.previous.fullAt <= 30000 || network.periodicWorldRequired?.() === false) ? this.previous : null;
      const pending = this.takeChanges(data);
      const generation = this.generation, breeding = breedingForBroadcast(data.breeding, !previous);
      let world, swims;
      if (previous) {
        world = structuredClone(packet(data, changedRows(data, previous, pending), breeding));
        if (world.tick === previous.tick + CONFIG.step) swims = encodeSwims(world.fishes, directions);
        previous.tick = world.tick;
        // Retain only the latest detached value for each live row. Ongoing
        // joins keep their own immutable snapshot of the world.
        for (const field of rowFields) {
          const rows = world[field], last = previous.rows[field];
          for (const id in rows) if (Object.hasOwn(rows, id)) last.set(id, rows[id]);
        }
      } else {
        const source = captureFull ? await captureFull() : data;
        if (generation !== this.generation) return;
        const full = packet(source, fullRows(source), source.breeding);
        world = captureFull ? full : structuredClone(full);
        this.previous = baseline(world, now);
        this.needsFull = false;
      }
      return await network.broadcast('world', { delta: !!previous, ...(swims ? { swims } : {}), world }, { capturedWorld: true });
    } catch (error) {
      this.reset();
      throw error;
    } finally { this.busy = false; }
  }
}
