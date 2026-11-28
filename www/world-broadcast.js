import { breedingForBroadcast, stopBreedingBroadcast } from './breeding.js';
import { replicaRowEquality } from './replica-stream.js';
import { committedStepFields, DailyDistance, FishPoseFrame, replicaFishIds, travelRow } from './replica-row-delta.js';
import { BondFrame } from './bond-interval.js';
import { applyStoryChanges } from './simulation-delta.js';
import { CONFIG, detachReplicaRows } from './engine.js';
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
  return { rows: Object.fromEntries(rowFields.map(field => [field, new Map(Object.entries(world[field] || {}))])),
    fishes: world.fishes, life: world.life, bondFrame: committedStepFields.get(world)?.bondFrame,
    roots: world.roots, terrain: world.terrain, fullAt: at, tick: world.tick };
}

function changedRows(data, base, pending) {
  const rows = {};
  const sameRow = replicaRowEquality(data.tick);
  for (const field of rowFields) {
    const table = data[field] || {}, last = base.rows[field];
    const changed = rows[field] = {};
    const check = id => {
      if (!Object.hasOwn(table, id)) { last.delete(id); return; }
      const sent = travelRow(last.get(id));
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

function captureDelta(delta) {
  const { fishes, life } = delta;
  const snapshot = structuredClone({ ...delta, fishes: null, life: life?.bonds ? { ...life, bonds: null } : life });
  snapshot.fishes = detachReplicaRows(fishes);
  if (life?.bonds) snapshot.life.bonds = detachReplicaRows(life.bonds);
  return snapshot;
}

// The simulation already identified the exact fields it replaced. Reuse the
// previous detached records as the static part of a contiguous publication.
function captureStep(data, base, patch, breeding, pending) {
  const worker = patch.workerChanges, rows = pending.size ? changedRows(data, base, pending) : fullRows({});
  if (pending.has('chars')) rows.chars = structuredClone(rows.chars);
  const source = { previousFishes: base.fishes, trips: rows.travel };
  const poses = patch.tables.fishes && FishPoseFrame.capture(worker.tables.fishes, patch.tables.fishes, base.poseFrame, base.fishes, data.tick);
  if (poses) source.poses = poses;
  else reconcileFishRows(base);
  const changed = replicaRowEquality(data.tick);
  for (const field of rowFields) {
    if (poses && field === 'fishes') continue;
    const edits = patch.tables[field];
    if (!edits) continue;
    const last = base.rows[field], otherEdits = pending.get(field);
    for (const id of edits.remove) last.delete(id);
    const frame = edits.frame, length = frame ? frame.length : edits.set.length;
    for (let i = 0; i < length; i++) {
      const id = frame ? frame.idAt(i) : edits.set[i][0];
      if (otherEdits?.has(id)) continue;
      const prior = last.get(id);
      const edit = worker.tables[field]?.set[i];
      const daily = field === 'travel' && (typeof edit === 'number' || edit?.length === 3 && typeof edit[1] === 'string');
      if (prior && daily) {
        const day = typeof edit === 'number' ? worker.tables.travel.day : edit[1];
        const distance = typeof edit === 'number' ? worker.tables.travel.distances[i] : edit[2];
        const before = prior instanceof DailyDistance && day === prior.day ? prior.distance : travelRow(prior).days[day];
        if (before !== distance) rows.travel[id] = new DailyDistance(prior, day, distance);
        continue;
      }
      const value = frame ? frame.recordAt(i) : edits.set[i][1];
      if (prior !== undefined && changed(field, travelRow(prior), value)) continue;
      if (prior && field === 'fishes' && edit !== undefined && !Array.isArray(edit)) {
        rows.fishes[id] = { ...prior, x: value.x, y: value.y, facing: value.facing,
          cx: value.cx, cy: value.cy, posAt: value.posAt };
      } else if (prior && field === 'chars' && edit?.length === 3) {
        const copy = { ...prior, ...edit[1] };
        for (const key in edit[1]) {
          const updated = copy[key];
          if (updated !== null && typeof updated === 'object') copy[key] = structuredClone(updated);
        }
        for (const key of edit[2] || []) delete copy[key];
        rows.chars[id] = copy;
      } else {
        rows[field][id] = field === 'fishes' || field === 'travel' || field === 'chars' ? structuredClone(value) : value;
      }
    }
  }
  const detached = structuredClone({ ...packet(data, rows, breeding), roots: null, terrain: null, life: null, fishes: null, chars: null, travel: null });
  for (const field of ['roots', 'terrain']) detached[field] = Object.hasOwn(worker.values, field) || worker.tables[field]
    ? structuredClone(data[field]) : base[field];
  for (const field of ['fishes', 'chars', 'travel']) {
    if (poses && field === 'fishes') {
      Object.defineProperty(detached, field, { enumerable: true, configurable: true, get: () => poses.table() });
      continue;
    }
    if (field === 'travel') {
      let table;
      Object.defineProperty(detached, field, { enumerable: true, configurable: true, get: () => {
        if (!table) {
          table = {};
          for (const id of Object.keys(rows.travel)) table[id] = travelRow(rows.travel[id]);
        }
        return table;
      } });
      continue;
    }
    detached[field] = rows[field];
  }
  if (!base.life || Object.hasOwn(worker.values, 'life')) detached.life = structuredClone(data.life);
  else if (!worker.life) { detached.life = base.life; source.bondFrame = base.bondFrame; }
  else {
    const { properties: [properties, remove], stories, bonds } = worker.life;
    const life = Object.defineProperties({}, Object.getOwnPropertyDescriptors(base.life));
    Object.defineProperties(life, Object.getOwnPropertyDescriptors(structuredClone(properties)));
    for (const key of remove || []) delete life[key];
    if (stories) life.stories = applyStoryChanges(base.life.stories, stories, true);
    if (bonds?.intervals) {
      const prior = base.bondFrame ?? base.life.bonds;
      const frame = source.bondFrame = new BondFrame(prior, bonds);
      source.bonds = { prior, changes: bonds };
      Object.defineProperty(life, 'bonds', { enumerable: true, configurable: true, get: () => frame.table() });
    } else if (bonds) {
      const keys = bonds.keys;
      const table = keys || bonds.ordered ? {} : { ...base.life.bonds };
      for (const key of bonds.remove || []) delete table[key];
      if (keys) {
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i], value = data.life.bonds[key];
          table[key] = Number.isNaN(bonds.counters[i * 2]) ? structuredClone(value) : { ...value };
        }
      } else for (const [key] of bonds.set) table[key] = structuredClone(data.life.bonds[key]);
      Object.defineProperty(life, 'bonds', { value: table, writable: true, enumerable: true, configurable: true });
    } else if (!Object.hasOwn(properties, 'bonds') && !remove?.includes('bonds')) {
      source.bondFrame = base.bondFrame;
    }
    detached.life = life;
  }
  committedStepFields.set(detached, source);
  return detached;
}

function reconcileFishRows(base) {
  if (!base.poseFrame) return;
  const table = base.poseFrame.table();
  for (const id in table) base.rows.fishes.set(id, table[id]);
  base.poseFrame = null;
}

function encodeSwims(indices, directions) {
  if (!directions?.length) return;
  const moves = new Uint8Array(indices.size), result = [];
  for (let direction = 0; direction < 9; direction++) {
    if (direction === 4 || !directions[direction]) continue;
    for (const id of directions[direction]) {
      const index = indices.get(id);
      if (index !== undefined) moves[index] = direction + 1;
    }
  }
  for (let i = 0; i < moves.length; i++) if (moves[i]) (result[moves[i] - 1] ||= []).push(i);
  if (result.length) return result;
}

function sameReplicaWorld(left, right) {
  const roots = Object.keys(left.roots);
  return left.terrain?.seed === right.terrain?.seed && left.terrain?.createdAt === right.terrain?.createdAt &&
    roots.length === Object.keys(right.roots).length && roots.every(root => Object.hasOwn(right.roots, root) && left.roots[root] === right.roots[root]);
}

function incomingBodyChanges(data, incoming) {
  const changedBodies = new Set();
  for (const [id, cell] of Object.entries(incoming.chars || {})) {
    const before = data.chars[id];
    if (before?.kind === 'fish') changedBodies.add(before.entity);
    if (cell.kind === 'fish') changedBodies.add(cell.entity);
  }
  return changedBodies;
}

function decodeSwims(data, incoming, encoded) {
  if (!Array.isArray(encoded) || encoded.length > 9 || encoded[4] != null) return;
  const ids = replicaFishIds(incoming), seen = new Uint8Array(ids.length), dirs = [], captured = capturedFishIds(data, data.tick);
  const changedBodies = incomingBodyChanges(data, incoming);
  for (let direction = 0; direction < encoded.length; direction++) {
    const indices = encoded[direction];
    if (indices == null) continue;
    if (!Array.isArray(indices) || indices.length > ids.length) return;
    const dx = direction % 3 - 1, dy = Math.floor(direction / 3) - 1;
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= ids.length || seen[index]) return;
      seen[index] = 1;
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
    const sameSource = sameWorld && body.delta === true && previous?.data === data && previous.from === from &&
      previous.actor === actor && previous.tick === tick;
    const keepStep = sameSource && incoming.tick <= tick, contiguous = sameSource && incoming.tick === tick + CONFIG.step;
    const presentedTick = keepStep ? tick : incoming.tick;
    const changedBodies = keepStep && previous.directions ? incomingBodyChanges(data, incoming) : null;
    let directions = keepStep ? previous.directions : contiguous ? decodeSwims(data, incoming, body.swims) : undefined;
    const poses = keepStep ? previous.poses : incoming.fishes;
    apply();
    const mergedWorld = sameReplicaWorld(data, incoming);
    if (!sameWorld || !mergedWorld) this.reset();
    if (data.tick !== presentedTick || !mergedWorld || (incoming.tick < tick && !directions)) return;
    if (directions?.length) {
      const captured = capturedFishIds(data, data.tick);
      directions = directions.map(ids => ids?.filter(id => {
        const pose = data.fishes[id], sent = poses[id];
        return pose?.posAt === presentedTick && pose.x === sent.x && pose.y === sent.y && pose.facing === sent.facing &&
          pose.actor === sent.actor && pose.created === sent.created && !captured.has(id) && !changedBodies?.has(id);
      }));
    }
    if (!directions?.some(ids => ids?.length)) directions = undefined;
    // An archive or late packet can merge into the current step. Retain only
    // trajectories whose endpoints still match, on the original playback clock.
    return this.latest = { data, from, actor, tick: presentedTick, directions, poses: directions && poses,
      startedAt: keepStep ? previous.startedAt : performance.now() };
  }
}

const inventoryFields = { roots: 'rootCount', ops: 'opCount', chats: 'chatCount', chatSources: 'chatSourceCount' };

function knownCount(rows, keys, archived) {
  if (!archived?.size) return keys.length;
  let count = keys.length + archived.size;
  if (keys.length < archived.size) {
    for (const id of keys) if (archived.has(id)) count--;
  } else {
    for (const id of archived.keys()) if (Object.hasOwn(rows, id)) count--;
  }
  return count;
}

// Heartbeats repair missing history. A row can move from the live table into
// an archive at different times on each peer. It is still the same record.
export class ReplicaInventory {
  previousCounts = new WeakMap();

  heartbeat(data, store) {
    const counts = {}, body = { settledRecords: {} };
    const previous = this.previousCounts.get(data);
    for (const [field, name] of Object.entries(inventoryFields)) {
      const rows = data[field], keys = Object.keys(rows);
      body[name] = keys.length;
      counts[field] = knownCount(rows, keys, store.ids[field]);
      // A newly created row may still be travelling on the ordinary stream.
      // Advertise the count that survived a full heartbeat before requesting repair.
      body.settledRecords[field] = previous ? Math.min(previous[field], counts[field]) : 0;
    }
    this.previousCounts.set(data, counts);
    return body;
  }

  missing(body, data, store) {
    if (!body.settledRecords) {
      return Object.entries(inventoryFields).some(([field, name]) => body[name] > 0 && body[name] > Object.keys(data[field]).length);
    }
    return Object.keys(inventoryFields).some(field => {
      const count = body.settledRecords[field];
      if (!(count > 0)) return false;
      const rows = data[field], keys = Object.keys(rows);
      return count > keys.length && count > knownCount(rows, keys, store.ids[field]);
    });
  }
}

export class ReplicaRecovery {
  missed = new Map();

  clear() { this.missed.clear(); }

  gap(message, currentTick) {
    const { delta, fromTick, world } = message.body;
    if (delta !== true || fromTick === undefined) return false;
    if (!Number.isFinite(fromTick) || !Number.isFinite(world?.tick) || fromTick > world.tick) throw new Error('世界增量起止时刻无效');
    if (fromTick <= currentTick) return false;
    this.ignore(message);
    return true;
  }

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

  covered({ from, actor, body }, response, ordered = false) {
    const missed = this.missed.get(from), tick = body?.world?.tick;
    if (!missed || missed.actor !== actor || !Number.isFinite(tick) || tick < missed.tick) return;
    if (response ? missed.request?.id === response && (ordered || missed.request.revision === missed.revision) : tick > missed.tick) {
      this.missed.delete(from);
    }
  }
}

export class WorldBroadcast {
  constructor(subscribe) {
    this.observesChanges = !!subscribe;
    subscribe?.((world, patch) => {
      if (world.data !== this.source || !this.pending) return;
      if (!patch) { this.pending = null; this.step = null; return; }
      if (!this.step && !patch.workerChanges && Object.keys(patch.values || {}).length === 0 &&
          Object.keys(patch.tables || {}).every(field => field !== 'fishes' && field !== 'travel' && rowFields.includes(field))) {
        this.track(patch);
        return;
      }
      if (this.step) { this.track(this.step); this.step = null; }
      const onlyPatch = this.firstChange;
      this.firstChange = false;
      if (onlyPatch && patch.workerChanges && !rowFields.some(field => Object.hasOwn(patch.values, field))) this.step = patch;
      else if (this.pending) this.track(patch);
    });
  }

  track(patch) {
    for (const field of rowFields) {
      if (Object.hasOwn(patch.values || {}, field)) { this.pending = null; return; }
      const changes = patch.tables?.[field];
      if (!changes) continue;
      let ids = this.pending.get(field);
      if (!ids) this.pending.set(field, ids = new Set());
      if (changes.frame) { for (const id of changes.frame.ids) ids.add(id); }
      else for (const [id] of changes.set) ids.add(id);
      for (const id of changes.remove) ids.add(id);
    }
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
    this.step = null;
    this.generation = (this.generation || 0) + 1;
  }

  takeChanges(data) {
    const pending = this.pending;
    this.source = data;
    this.trackedBreeding = data.breeding;
    this.pending = this.observesChanges ? new Map() : null;
    this.firstChange = true;
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
      const step = this.step;
      this.step = null;
      const contiguous = step && previous && data.tick === previous.tick + CONFIG.step && step.values.tick === data.tick;
      if (step && !contiguous && this.pending) this.track(step);
      const pending = this.takeChanges(data);
      const generation = this.generation, breeding = breedingForBroadcast(data.breeding, !previous);
      let world, swims;
      const fromTick = previous?.tick;
      if (previous) {
        if (!contiguous) reconcileFishRows(previous);
        world = contiguous ? captureStep(data, previous, step, breeding, pending) : captureDelta(packet(data, changedRows(data, previous, pending), breeding));
        const poses = committedStepFields.get(world)?.poses;
        if (directions?.length && world.tick === previous.tick + CONFIG.step) {
          const indices = poses?.indices ?? new Map(Object.keys(world.fishes).map((id, i) => [id, i]));
          swims = encodeSwims(indices, directions);
        }
        previous.tick = world.tick;
        previous.life = world.life;
        previous.bondFrame = committedStepFields.get(world)?.bondFrame;
        previous.poseFrame = poses;
        previous.fishes = poses ? poses.token : world.fishes;
        previous.roots = world.roots;
        previous.terrain = world.terrain;
        // Retain only the latest detached value for each live row. Ongoing
        // joins keep their own immutable snapshot of the world.
        for (const field of rowFields) {
          if (poses && field === 'fishes') continue;
          const rows = field === 'travel' ? committedStepFields.get(world)?.trips ?? world.travel : world[field], last = previous.rows[field];
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
      const body = { delta: !!previous, ...(previous && { fromTick }), ...(swims ? { swims } : {}), world };
      network.stageWorld?.(body, peers);
      return await network.broadcast('world', body, { capturedWorld: true });
    } catch (error) {
      this.reset();
      throw error;
    } finally { this.busy = false; }
  }
}
