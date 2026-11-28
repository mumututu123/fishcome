import { CONFIG } from './engine.js';
import { OrderedSteps, stepDigest } from './ordered-steps.js';

const orderedTables = ['participants', 'roots', 'contacts', 'breeding', 'life.events', 'life.bonds', 'life.stories',
  'life.places', 'life.haunts', 'life.bloomThrough', 'life.eventThrough'];
const tableAt = (data, name) => name.startsWith('life.') ? data.life?.[name.slice(5)] : data[name];

export function checkpointOrder(data) {
  return Object.fromEntries(orderedTables.filter(name => tableAt(data, name)).map(name => [name, Object.keys(tableAt(data, name))]));
}

// Merging can preserve every record but reorder a dictionary. The leader's
// order matters to subsequent simulation and conflict ties. Only rearrange
// local rows, and only install them after the complete checkpoint hash agrees.
export async function orderedCheckpoint(world, store, orders) {
  const changes = {}, data = { ...world.data };
  if (orders) {
    for (const [name, keys] of Object.entries(orders)) {
      if (!orderedTables.includes(name)) throw new Error('共同检查点包含未知表');
      const table = tableAt(data, name), local = Object.keys(table || {});
      if (!table || !Array.isArray(keys) || keys.length !== local.length) throw new Error('共同检查点的数据不齐');
      if (keys.every((key, i) => key === local[i])) continue;
      const aligned = {};
      for (const key of keys) {
        if (typeof key !== 'string' || !Object.hasOwn(table, key) || Object.hasOwn(aligned, key) || key === '__proto__') throw new Error('共同检查点的记录不同');
        aligned[key] = table[key];
      }
      if (name.startsWith('life.')) {
        if (!changes.life) data.life = changes.life = { ...data.life };
        data.life[name.slice(5)] = aligned;
      } else data[name] = changes[name] = aligned;
    }
  }
  const proof = await stepDigest([data, world.ambient, Object.keys(store.manifests).sort(), store.summary, store.overrides]);
  return { proof, changes };
}

export class OrderedSession {
  constructor(io) { this.io = io; }

  valid(s) {
    return this.current === s && this.io.peer() === s.peer && this.io.world() === s.world &&
      this.io.leader() === s.leader && this.io.store() === s.store && s.store.revision === s.revision &&
      s.world.data.archives?.at === s.archiveAt;
  }
  send(s, message) {
    if (!this.valid(s)) return;
    return this.io.send(s.peer, { ...message, epoch: s.epoch });
  }
  stop(reason, inform = true) {
    const s = this.current;
    if (!s) return;
    this.current = null;
    s.steps?.close();
    s.archive?.plan?.close();
    s.archive?.done?.(false);
    if (inform) this.io.send(s.peer, { action: 'stop', epoch: s.epoch }).catch(() => {});
    this.io.stopped(s, reason);
  }
  changed(world, patch) {
    const s = this.current;
    if (!s || world !== s.world || s.applying) return;
    if (s.running && patch?.workerChanges && patch.values?.tick === s.steps.next?.tick) return;
    if (s.waiting && !s.checking) return;
    this.stop('世界在共同基准之外有新变更');
  }
  begin(peer, epoch, base) {
    const world = this.io.world(), store = this.io.store();
    return this.current = { peer, epoch, base, world, store, revision: store.revision, archiveAt: world.data.archives?.at,
      leader: this.io.leader(), owner: this.io.isLeader(), began: performance.now(), receipts: new Map() };
  }
  async probe() {
    const peer = this.io.peer(), now = performance.now();
    if (this.current || !peer || !this.io.isLeader() || now < (this.retryAt || 0) ||
        Date.now() - this.io.world().data.tick > CONFIG.step) return;
    this.retryAt = now + 3000;
    const world = this.io.world(), s = this.begin(peer, crypto.randomUUID(), world.data.tick);
    const order = checkpointOrder(world.data);
    const { proof } = await orderedCheckpoint(world, s.store);
    if (!this.valid(s) || world.data.tick !== s.base) return;
    s.proof = proof;
    await this.send(s, { action: 'open', base: s.base, proof, order });
  }
  async afterReplica() {
    const s = this.current;
    if (!s?.waiting || s.checking || s.world.data.tick < s.base) return;
    if (!this.valid(s) || s.world.data.tick !== s.base) { this.stop('已错过共同检查点'); return; }
    s.checking = true;
    const { proof, changes } = await orderedCheckpoint(s.world, s.store, s.order);
    if (!this.valid(s)) return;
    if (proof !== s.proof) {
      await this.send(s, { action: 'history', base: s.base, bonds: s.world.data.life.bonds });
      if (this.current === s) this.stop('两端已验证的世界内容不同', false);
      return;
    }
    if (Object.keys(changes).length) {
      await this.io.install(s.world, changes, () => this.valid(s), action => {
        s.applying = true;
        try { action(); } finally { s.applying = false; }
      });
    }
    if (!this.valid(s)) return;
    s.waiting = false;
    this.start(s);
    await this.send(s, { action: 'joined', base: s.base, proof });
  }
  start(s) {
    this.io.beginExecution?.(s.world);
    s.steps = new OrderedSteps({ epoch: s.epoch, tick: s.base, proof: s.proof, leader: s.owner,
      send: body => this.send(s, body), validOp: async op => {
        if (!await this.io.validOp(s.world, op)) return false;
        s.receipts.set(op.body.id, await s.store.get('ops', op.body.id));
        return this.valid(s);
      } });
  }
  async proposeArchive(boundary) {
    const s = this.current;
    if (!s?.owner || !s.steps || s.archive || !this.valid(s)) return false;
    const ticket = s.archive = { boundary };
    const completion = new Promise(resolve => { ticket.done = resolve; });
    try {
      ticket.id = await stepDigest(boundary);
      if (!this.valid(s)) return false;
      await Promise.all([this.prepareArchive(s, ticket), this.send(s, { action: 'archive', boundary, id: ticket.id })]);
      if (!this.valid(s)) return false;
      return completion;
    } catch (error) { if (this.current === s) this.stop(error.message); throw error; }
  }
  async prepareArchive(s, ticket) {
    const plan = await this.io.prepareArchive(s, ticket.boundary);
    if (!this.valid(s) || s.archive !== ticket) { plan.close(); return; }
    ticket.plan = plan;
  }
  async offer(s) {
    const archive = s.archive;
    await s.steps.offer(this.io.inputs(), archive?.plan && archive.remote ? archive.id : undefined);
  }
  ready(s) {
    if (!s.remoteReady || !s.localReady) return;
    if (s.localReady !== s.remoteReady) { this.stop('本步操作或归档结果不同'); return; }
    if (s.steps.next?.archive && s.archive?.committed) {
      s.archive.done?.(true);
      s.archive = undefined;
      this.io.archiveConfirmed();
    }
  }
  async receive(peer, b) {
    if (!b || typeof b !== 'object' || this.io.peer() !== peer) return;
    let s = this.current;
    if (b.action === 'open') {
      if (this.io.isLeader() || s || typeof b.epoch !== 'string' || b.epoch.length !== 36 || !Number.isSafeInteger(b.base) ||
          b.base < this.io.world().data.tick || b.base > this.io.world().data.tick + CONFIG.step * 2 ||
          !/^[0-9a-f]{64}$/.test(b.proof) || !b.order || typeof b.order !== 'object') return;
      s = this.begin(peer, b.epoch, b.base);
      Object.assign(s, { waiting: true, proof: b.proof, order: b.order });
      return this.afterReplica();
    }
    if (!s || s.peer !== peer || b.epoch !== s.epoch) return;
    if (b.action === 'stop') { this.stop('伙伴已切回世界同步', false); return; }
    if (!this.valid(s)) { this.stop('共同结算的连接或归档已更换'); return; }
    if (b.action === 'stop') { this.stop('伙伴已结束本次共同结算', false); return; }
    if (b.action === 'history' && s.owner && !s.steps && b.base === s.base) {
      const history = await this.io.bondHistory?.(s, b.bonds);
      if (!this.valid(s)) return;
      this.stop('双方重新合并已验证的伙伴历史', false);
      if (history) await this.io.install(s.world, { life: { ...s.world.data.life, bonds: history } },
        () => this.io.world() === s.world && s.world.data.tick === s.base && s.store.revision === s.revision && this.io.isLeader(), f => f());
      return;
    }
    if (b.action === 'joined' && s.owner && !s.steps && b.base === s.base && b.proof === s.proof) {
      this.start(s);
      return this.offer(s);
    }
    if (!s.steps) return;
    if (b.action === 'archive' && !s.owner && !s.archive) {
      if (!b.boundary || !/^[0-9a-f]{64}$/.test(b.id) || await stepDigest(b.boundary) !== b.id || !this.valid(s)) return;
      const ticket = s.archive = { boundary: b.boundary, id: b.id };
      await this.prepareArchive(s, ticket);
      if (ticket.plan) await this.send(s, { action: 'archiveReady', id: ticket.id });
      return;
    }
    if (b.action === 'archiveReady' && s.owner && s.archive?.id === b.id) {
      s.archive.remote = true;
      return;
    }
    if (b.action === 'offer' && b.archive !== undefined && (!s.archive?.plan || b.archive !== s.archive.id)) {
      this.stop('共同归档尚未校验'); return;
    }
    if (b.action === 'finished') {
      if (!s.owner || !Number.isSafeInteger(b.base) || !/^[0-9a-f]{64}$/.test(b.proof) ||
          (b.base !== s.steps.tick && b.base !== s.steps.next?.tick)) return;
      s.finished = { base: b.base, proof: b.proof };
      return this.nextOffer(s);
    }
    if (b.action === 'prepared') {
      if (s.steps.next?.digest === b.digest && b.base === s.steps.tick && typeof b.outcomes === 'string') {
        s.remoteReady = b.outcomes;
        this.ready(s);
      }
      return;
    }
    await s.steps.receive(b);
    const slot = s.steps.next;
    if (!this.valid(s) || !slot?.sealed || slot.preparing) return;
    slot.preparing = true;
    if (slot.archive) {
      const ticket = s.archive;
      if (!ticket?.plan || ticket.id !== slot.archive) throw new Error('本步归档尚未准备完成');
      await this.io.archiveBoundary(s.world, () => {
        if (!this.valid(s)) return;
        s.applying = true;
        try {
          slot.archiveChange = ticket.plan.commit();
          ticket.committed = true;
          s.revision = s.store.revision;
          s.archiveAt = s.world.data.archives.at;
          return slot.archiveChange;
        } finally { ticket.plan.close(); s.applying = false; }
      });
      if (!this.valid(s) || !ticket.committed) return;
    }
    s.applying = true;
    try {
      slot.outcomes = slot.inputs.map(op => this.io.apply(s.world, op, s.receipts.get(op.body.id), s.owner));
    } finally { s.applying = false; }
    s.receipts.clear();
    if (slot.inputs.length) {
      this.io.inputsCommitted(slot.inputs, slot.outcomes, s.owner).catch(error => {
        if (this.current === s) this.stop(error.message);
      });
    }
    const handle = await this.io.prepare(s.world, () => this.valid(s));
    if (!this.valid(s) || !handle) return;
    const outcomes = await stepDigest([slot.outcomes, slot.archiveChange ?? null]);
    if (!this.valid(s)) return;
    s.handle = handle;
    s.localReady = outcomes;
    this.ready(s);
    if (!this.valid(s)) return;
    await this.send(s, { action: 'prepared', base: s.steps.tick, digest: slot.digest, outcomes });
  }
  async nextOffer(s) {
    if (!s.owner || !this.valid(s) || !s.finished || s.finished.base !== s.steps.tick || s.steps.next) return;
    if (s.finished.proof !== s.steps.proof) { this.stop('上一步的实际结果不同'); return; }
    s.finished = null;
    await this.offer(s);
  }
  run(now) {
    const s = this.current;
    if (!s) return false;
    if (!this.valid(s)) { this.stop('成员、权威或归档已更换'); return false; }
    if (s.running) return true;
    if (now < s.base + CONFIG.step) return false;
    if (s.waiting && s.world.data.tick < s.base) return false;
    if (!s.localReady || s.localReady !== s.remoteReady) {
      if (!s.executed && performance.now() - s.began < 2000) return true;
      this.stop('本步输入尚未得到双方确认'); return false;
    }
    const slot = s.steps.take(s.world.data.tick);
    if (!slot) { this.stop('共同基准已变更'); return false; }
    s.running = s.executed = true;
    const handle = s.handle;
    s.handle = s.localReady = s.remoteReady = null;
    this.io.advance(s.world, slot.tick, () => this.valid(s), handle).then(async result => {
      if (!this.valid(s)) return;
      if (!result || result.tick !== slot.tick) { this.stop('共同结算未提交'); return; }
      s.base = result.tick;
      const proof = await s.steps.complete(slot, { ...result, outcomes: slot.outcomes });
      if (!this.valid(s) || !proof) return;
      s.running = false;
      if (s.owner) await this.nextOffer(s);
      else await this.send(s, { action: 'finished', base: s.base, proof });
    }).catch(error => { if (this.current === s) this.stop(error.message); });
    return true;
  }
}
