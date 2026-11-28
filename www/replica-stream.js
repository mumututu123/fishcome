import { worldTables } from './simulation-changes.js';
import { CONFIG } from './engine.js';
import { DAY, shanghaiDay } from './fish-status.js';
import { decodeReplicaRowDelta, encodeReplicaRowDelta, replicaRowBase } from './replica-row-delta.js';

// One record per line lets the receiver assemble tables without retaining the wire text.
// A record may span several signed pages, including in the middle of a surrogate pair.
export const PAGE_UNITS = 64 * 1024;
export const LIVE_FRAME_UNITS = 1024 * 1024;
export const MAX_RECORD_UNITS = 32 * 1024 * 1024;
export const MAX_STREAM_UNITS = 256 * 1024 * 1024;
const REPLICA_KINDS = new Set(['hello', 'catchup', 'merge', 'world', 'live']);
const line = row => JSON.stringify(row) + '\n';
const safeKey = key => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key);
const frameArrays = new Set(['fishes', 'chars', 'travel', 'contacts']);

function* batches(rows) {
  const prefix = '["batch",[';
  let parts = [], length = prefix.length + 3;
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (parts.length && (parts.length === 128 || length + text.length + 1 > MAX_RECORD_UNITS)) {
      yield prefix + parts.join(',') + ']]\n';
      parts = []; length = prefix.length + 3;
    }
    parts.push(text);
    length += text.length + 1;
  }
  if (parts.length) yield prefix + parts.join(',') + ']]\n';
}

function* lines(body, frame) {
  const { world, ...header } = body;
  yield line(['header', header]);
  for (const [field, value] of Object.entries(world)) {
    if (frame && Array.isArray(value) && frameArrays.has(field)) {
      yield line(['array', field]);
      yield* batches(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      yield line(['table', field]);
      // Do not materialize a second array containing every record or entry.
      for (const id in value) if (Object.hasOwn(value, id) && value[id] !== undefined) yield line(['row', id, value[id]]);
    } else if (value !== undefined) yield line(['value', field, value]);
  }
}

export function* replicaPages(body, frame = false) {
  const size = frame ? LIVE_FRAME_UNITS : PAGE_UNITS;
  let page = '', total = 0;
  for (const row of lines(body, frame)) {
    total += row.length;
    if (row.length > MAX_RECORD_UNITS || total > MAX_STREAM_UNITS) throw new Error('世界分块超过接收容量');
    let offset = 0;
    while (offset < row.length) {
      const end = Math.min(row.length, offset + size - page.length);
      page += row.slice(offset, end);
      offset = end;
      if (page.length === size) { yield { text: page, last: false }; page = ''; }
    }
  }
  yield { text: page, last: true };
}

export class ReplicaReader {
  constructor(frame = false) { this.frame = frame; }
  tail = '';
  units = 0;
  table = null;
  body = null;
  append(text, last) {
    this.units += text.length;
    if (text.length > (this.frame ? LIVE_FRAME_UNITS : PAGE_UNITS) || this.units > MAX_STREAM_UNITS) throw new Error('世界分块超过接收容量');
    const rows = text.split('\n');
    rows[0] = this.tail + rows[0];
    this.tail = rows.pop();
    if (this.tail.length > MAX_RECORD_UNITS) throw new Error('世界记录超过接收容量');
    for (const row of rows) {
      if (row.length > MAX_RECORD_UNITS) throw new Error('世界记录超过接收容量');
      const [op, key, value] = JSON.parse(row);
      if (op === 'header' && !this.body && key && typeof key === 'object' && !Array.isArray(key) && !Object.hasOwn(key, 'world')) {
        this.body = { ...key, world: {} };
      } else if (this.frame && op === 'array' && this.body && frameArrays.has(key) && !Object.hasOwn(this.body.world, key)) {
        this.body.world[key] = this.table = [];
      } else if (this.frame && op === 'batch' && Array.isArray(this.table) && Array.isArray(key) && key.length <= 128) {
        this.table.push(...key);
      } else if (this.body && safeKey(key) && (op === 'value' || op === 'table') && !Object.hasOwn(this.body.world, key)) {
        this.table = op === 'table' ? {} : null;
        this.body.world[key] = op === 'table' ? this.table : value;
      } else if (op === 'row' && this.table && !Array.isArray(this.table) && safeKey(key) && !Object.hasOwn(this.table, key)) {
        this.table[key] = value;
      } else throw new Error('世界分块格式无效');
    }
    if (last && (!this.body || this.tail)) throw new Error('世界分块未完成');
    return last ? this.body : null;
  }
}

const RESUME_MS = 120000;
const ACK_MS = 30000;
const delay = () => new Promise(resolve => setTimeout(resolve, 0));

export function replicaRowEquality(tick) {
  const day = Number.isFinite(tick) && Math.abs(tick) < 8.64e15 - DAY ? shanghaiDay(tick) : undefined;
  return (field, before, after) => {
    if (before === after) return true;
    let left, right;
    if (field === 'fishes') {
      left = before?.posAt;
      right = after?.posAt;
    } else if (field === 'travel' && day !== undefined) {
      left = before?.days?.[day];
      right = after?.days?.[day];
    }
    // A changed clock or distance proves these JSON records differ. In
    // particular, equal clocks do not imply equal positions or other fields.
    if (left !== right && Number.isFinite(left) && Number.isFinite(right)) return false;
    return JSON.stringify(before) === JSON.stringify(after);
  };
}

// Both inputs are immutable, committed checkpoints. Keep roots and world-level
// clocks for merge/validation. Existing record conflict rules handle the rows.
export async function changesSince(baseline, current) {
  const delta = { ...current };
  const sameRow = replicaRowEquality(current.tick);
  let rows = 0, slice = performance.now();
  for (const field of worldTables) {
    // mergeBreeding replaces the complete contact map when contactAt advances.
    if (field === 'roots' || field === 'contacts' || !current[field]) continue;
    const changed = {}, old = baseline[field] || {};
    for (const id in current[field]) if (Object.hasOwn(current[field], id)) {
      const value = current[field][id], before = old[id];
      if (!Object.hasOwn(old, id) || !sameRow(field, before, value)) changed[id] = value;
      if (++rows % 128 === 0 && performance.now() - slice >= 5) { await delay(); slice = performance.now(); }
    }
    delta[field] = changed;
  }
  return delta;
}

// Older browsers sign a single envelope. Count the JSON bytes by record before
// handing them a world, so an incompatible peer cannot force a huge signature.
export async function fitsLegacyEnvelope(body, budget) {
  const bytes = new TextEncoder();
  const size = value => bytes.encode(JSON.stringify(value)).length;
  const { world, ...header } = body;
  // Replace the closing brace with a comma (when needed), "world":{} and }.
  let total = size(header) + 10 + (Object.keys(header).some(k => header[k] !== undefined) ? 1 : 0), slice = 0, fields = 0;
  for (const [field, value] of Object.entries(world)) {
    if (value === undefined) continue;
    total += size(field) + 1 + (fields++ ? 1 : 0);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      let rows = 0;
      total += 2;
      for (const id in value) if (Object.hasOwn(value, id)) {
        if (value[id] === undefined) continue;
        const added = size(id) + size(value[id]) + 1 + (rows++ ? 1 : 0);
        total += added; slice += added;
        if (total > budget) return false;
        if (slice >= PAGE_UNITS) { slice = 0; await delay(); }
      }
    } else total += size(value);
  }
  return total <= budget;
}

export function coalesceWorld(pending, next) {
  if (!pending || !next.delta) return next;
  const { swims, ...header } = next;
  const world = { ...next.world };
  for (const field of worldTables) {
    if (field === 'roots' || field === 'bubbles' || field === 'contacts' || !pending.world[field]) continue;
    world[field] = { ...pending.world[field], ...world[field] };
  }
  return { ...header, ...(Number.isFinite(pending.fromTick) && { fromTick: pending.fromTick }), delta: pending.delta, world };
}

export class ReplicaTransfers {
  constructor(network) {
    this.network = network;
    this.outgoing = new Map();
    this.incoming = new Map();
    this.completed = new Map();
    this.live = new Map();
    this.rowsSent = new WeakMap();
    this.rowsReceived = new WeakMap();
    this.unpublished = new WeakMap();
  }
  // A tick can have multiple publications. Each connected peer owns its
  // unpublished changes until its reliable stream accepts them.
  stageLive(body, peers) {
    for (const peer of peers) this.unpublished.set(peer, coalesceWorld(this.unpublished.get(peer), body));
  }
  liveLane(peer) {
    let lane = this.live.get(peer);
    if (!lane) this.live.set(peer, lane = { pending: [], receipt: null, running: false });
    return lane;
  }
  publishLive(body, peers) {
    for (const peer of peers) {
      const packet = this.unpublished.get(peer) ?? body;
      this.unpublished.delete(peer);
      const lane = this.liveLane(peer);
      const queue = lane.pending;
      if (!packet.delta) queue.length = 0;
      const last = queue.at(-1), elapsed = packet.world.tick - packet.fromTick;
      const nextCut = last?.delta && last.world.tick === packet.fromTick &&
        (elapsed === CONFIG.step || elapsed === 0 && last.fromTick < last.world.tick);
      if (!last || nextCut && lane.running && !peer.replicaCatchingUp && !lane.snapshot &&
          packet.world.tick - queue[0].world.tick <= ACK_MS) queue.push(packet);
      else queue[queue.length - 1] = coalesceWorld(last, packet);
      this.resumeLive(peer);
    }
  }
  resumeLive(peer) {
    const lane = this.live.get(peer);
    if (!lane || lane.running || peer.replicaCatchingUp || !peer.confirmedReplica) return;
    lane.running = true;
    this.sendLive(peer, lane).catch(error => this.network.close(peer, error));
  }
  repairLive(peer, capture) {
    const lane = this.liveLane(peer);
    if (lane.snapshot) return;
    lane.snapshot = capture;
    this.resumeLive(peer);
  }
  async sendLive(peer, lane) {
    let waitForPublication = false;
    try {
      while (lane.pending.length || lane.snapshot) {
        // Take the full snapshot on the same ordered stream as subsequent
        // changes. Accumulate live publications while capturing and sending it.
        const snapshot = lane.snapshot;
        if (snapshot) lane.pending.length = 0;
        const body = snapshot ? await snapshot() : lane.pending.shift();
        if (this.live.get(peer) !== lane) return;
        if (snapshot && lane.snapshot !== snapshot) continue;
        lane.sending = body;
        let prior = this.rowsSent.get(peer);
        const encoded = peer.replicaRows ? encodeReplicaRowDelta(body, prior, peer.replicaFrames, peer.replicaPoseBytes, peer.replicaTransitions) : body;
        let receipt = await this.sendLivePacket(peer, lane, encoded);
        if (!receipt && encoded !== body) { prior = null; receipt = await this.sendLivePacket(peer, lane, body); }
        if (!receipt) throw new Error('伙伴拒绝世界增量');
        if (peer.replicaRows) this.rowsSent.set(peer, replicaRowBase(receipt.id, body.world, peer.replicaFrames, encoded.frameRows && prior));
        if (snapshot && lane.snapshot === snapshot) lane.snapshot = null;
        if (!receipt.committed && lane.sending === body) {
          if (lane.pending.length) lane.pending[0] = coalesceWorld(body, lane.pending[0]);
          else if (!lane.snapshot) { lane.pending.push(body); waitForPublication = true; return; }
        }
      }
    } finally {
      lane.sending = null;
      lane.running = false;
      if (!waitForPublication && this.live.get(peer) === lane) this.live.delete(peer);
    }
  }
  async sendLivePacket(peer, lane, body) {
    const id = crypto.randomUUID();
    let index = 0;
    const frame = peer.replicaFrames && body.frameRows === true;
    for (const page of replicaPages(body, frame)) {
      const packet = { id, kind: 'live', index: index++, ...page, ...(frame && { frame: true }) };
      if (!page.last) { await this.network.directControl(peer, 'replicaPage', packet); continue; }
      const applied = new Promise((resolve, reject) => { lane.receipt = { id, index: packet.index, resolve, reject }; });
      const timeout = setTimeout(() => lane.receipt?.reject(new Error('伙伴应用世界增量超时')), body.delta ? ACK_MS : RESUME_MS);
      try {
        const [, next] = await Promise.all([this.network.directControl(peer, 'replicaPage', packet), applied]);
        if (next === -2 && body.rowBase) return null;
        if (next !== index) throw new Error('伙伴拒绝世界增量');
        return { id, committed: lane.receipt.committed !== false };
      } finally { clearTimeout(timeout); lane.receipt = null; }
    }
  }
  discardPendingLive() {
    this.unpublished = new WeakMap();
    for (const [peer, lane] of this.live) {
      if (lane.running) { lane.pending.length = 0; lane.snapshot = null; lane.sending = null; }
      else this.live.delete(peer);
    }
  }
  async broadcast(kind, body, peers) {
    const id = crypto.randomUUID();
    let index = 0;
    let recipients = peers;
    for (const page of replicaPages(body)) {
      const envelope = await this.network.makeEnvelope('replicaPage', { id, kind, index: index++, ...page });
      this.network.seen.set(envelope.id, Date.now());
      const bytes = await this.network.encode(envelope);
      const outcomes = await Promise.allSettled(recipients.map(peer => this.network.send(peer, envelope.id, bytes, true)));
      recipients = recipients.filter((_, n) => outcomes[n].status === 'fulfilled');
      if (!recipients.length) throw new Error('伙伴连接已关闭');
    }
  }
  newHello(body) {
    return { id: crypto.randomUUID(), body, pages: replicaPages(body), index: 0, page: null };
  }
  async hello(peer, body, kind = 'hello') {
    const slot = peer.node + ':' + kind;
    let state = (kind === 'hello' && this.outgoing.get(slot)) || this.newHello(body);
    if (state.connection === peer) return state.running;
    clearTimeout(state.expiration);
    state.connection = peer;
    this.outgoing.set(slot, state);
    const send = async () => {
      while (peer.dc?.readyState === 'open') {
        state.page ||= state.pages.next().value;
        const packet = { id: state.id, kind, index: state.index, ...state.page };
        const receipt = new Promise((resolve, reject) => {
          peer.replicaAck = { id: state.id, index: state.index, resolve, reject };
        });
        const timer = setTimeout(() => peer.replicaAck?.reject(new Error('伙伴确认世界分块超时')), state.page.last ? RESUME_MS : ACK_MS);
        let next;
        try {
          [, next] = await Promise.all([this.network.directControl(peer, 'replicaPage', packet), receipt]);
        } finally { clearTimeout(timer); peer.replicaAck = null; }
        if (next === 0 && state.index > 0) {
          Object.assign(state, this.newHello(state.body));
          continue;
        }
        if (next !== state.index + 1) throw new Error('伙伴拒绝世界分块');
        if (state.page.last) { this.outgoing.delete(slot); return { version: state.id, world: state.body.world }; }
        state.index++; state.page = null;
      }
      throw new Error('世界分块连接已关闭');
    };
    state.running = send().finally(() => {
      if (this.outgoing.get(slot) !== state || state.connection !== peer) return;
      if (kind !== 'hello') { this.outgoing.delete(slot); return; }
      state.connection = null;
      state.expiration = setTimeout(() => this.outgoing.delete(slot), RESUME_MS);
    });
    return state.running;
  }
  expire(key, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this.incoming.delete(key), RESUME_MS);
  }
  async receive(message, peer) {
    const { kind, id, index, text, last } = message.body;
    if (message.kind === 'replicaReceipt') {
      const live = this.live.get(peer)?.receipt;
      const ack = live?.id === id ? live : peer.replicaAck;
      if (ack?.id === id && ack.index === index && message.from === peer.node) {
        if (ack === live) ack.committed = message.body.committed;
        ack.resolve(message.body.next);
      }
      return false;
    }
    const direct = kind === 'hello' || kind === 'catchup', live = kind === 'live';
    const frame = message.body.frame === true;
    const size = frame ? LIVE_FRAME_UNITS : PAGE_UNITS;
    if (!REPLICA_KINDS.has(kind) || typeof id !== 'string' || id.length !== 36 ||
        !Number.isSafeInteger(index) || index < 0 || index > Math.floor(MAX_STREAM_UNITS / size) ||
        typeof last !== 'boolean' || typeof text !== 'string' || text.length > size || frame && (!live || !peer.replicaFrames) ||
        (!last && text.length !== size) || ((direct || live) && message.from !== peer.node) ||
        (live && !peer.replicaLive)) throw new Error('无效的世界分块');
    const key = message.from + ':' + id;
    const acknowledge = next => direct && this.network.directControl(peer, 'replicaReceipt', { id, index, next });
    const done = this.completed.get(key);
    if (done) { if (kind === 'hello') { peer.confirmedReplica = id; this.resumeLive(peer); } await acknowledge(done.next); return false; }
    let state = this.incoming.get(key);
    if (!state) {
      if (direct && index > 0) { await acknowledge(0); return false; }
      if (this.incoming.size >= 16 || !live && index > 16) throw new Error('世界分块接收队列已满');
      state = { kind, actor: message.actor, next: 0, pending: new Map(), reader: new ReplicaReader(frame) };
      this.incoming.set(key, state);
    }
    // A live edge has one update in flight, but decompressing and verifying
    // its pages can finish out of order. The shared byte budget below still applies.
    if (state.kind !== kind || state.actor !== message.actor || state.reader.frame !== frame || !live && index > state.next + 16 ||
        state.endIndex !== undefined && (index > state.endIndex || last && index !== state.endIndex)) throw new Error('世界分块版本不一致');
    if (last) state.endIndex = index;
    if (index < state.next || state.pending.has(index)) {
      await state.applying;
      await acknowledge(state.next);
      return false;
    }
    const inFlight = [...this.incoming.values()].reduce((sum, s) => sum + s.reader.units + s.pending.size * (s.reader.frame ? LIVE_FRAME_UNITS : PAGE_UNITS), 0);
    if (inFlight + text.length > MAX_STREAM_UNITS) throw new Error('世界分块接收容量已满');
    this.expire(key, state);
    state.pending.set(index, { text, last });
    try {
      while (state.pending.has(state.next)) {
        const page = state.pending.get(state.next);
        state.pending.delete(state.next++);
        let body = state.reader.append(page.text, page.last);
        if (!body) continue;
        if (state.pending.size) throw new Error('世界分块结束位置无效');
        if (kind === 'catchup' && body.base !== peer.confirmedReplica) throw new Error('分块变更引用了未确认的世界版本');
        const prior = body.frameRows && this.rowsReceived.get(peer);
        if (frame !== (body.frameRows === true) || frame && !Object.hasOwn(body, 'rowBase')) throw new Error('实时帧格式不一致');
        if (Object.hasOwn(body, 'rowBase')) {
          if (!live || !peer.replicaRows) throw new Error('伙伴未确认实时变更格式');
          body = decodeReplicaRowDelta(body, this.rowsReceived.get(peer), frame, peer.replicaPoseBytes, peer.replicaTransitions);
        }
        let committed;
        if (body) {
          state.applying = this.network.onMessage({ id, kind: kind === 'catchup' ? 'merge' : live ? 'world' : kind, actor: message.actor, from: message.from, key: message.key, body }, peer);
          committed = await state.applying;
          if (live && peer.replicaRows) this.rowsReceived.set(peer, replicaRowBase(id, body.world, peer.replicaFrames, prior));
        }
        if (kind === 'hello') { peer.confirmedReplica = id; this.resumeLive(peer); }
        clearTimeout(state.timer); this.incoming.delete(key);
        const timer = setTimeout(() => this.completed.delete(key), RESUME_MS);
        this.completed.set(key, { next: state.next, timer });
        if (live) await this.network.directControl(peer, 'replicaReceipt', { id, index: state.endIndex, next: body ? state.next : -2,
          ...(body && committed !== true && { committed: false }) });
        break;
      }
      await acknowledge(state.next);
    } catch (error) {
      clearTimeout(state.timer); this.incoming.delete(key);
      if (live && state.endIndex !== undefined) {
        await this.network.directControl(peer, 'replicaReceipt', { id, index: state.endIndex, next: -1 }).catch(() => {});
      } else await acknowledge(-1);
      throw error;
    }
    return !direct && !live;
  }
  close(peer, error) {
    this.unpublished.delete(peer);
    peer.replicaAck?.reject(error);
    const lane = this.live.get(peer);
    if (lane) { lane.pending.length = 0; lane.receipt?.reject(error); this.live.delete(peer); }
  }
  stop() {
    this.unpublished = new WeakMap();
    for (const s of this.incoming.values()) clearTimeout(s.timer);
    for (const s of this.completed.values()) clearTimeout(s.timer);
    for (const s of this.outgoing.values()) clearTimeout(s.expiration);
    for (const peer of this.live.keys()) this.close(peer, new Error('世界分块连接已关闭'));
    this.incoming.clear(); this.completed.clear(); this.outgoing.clear();
  }
}
