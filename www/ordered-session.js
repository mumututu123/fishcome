import { CONFIG } from './engine.js';
import { OrderedSteps, stepDigest } from './ordered-steps.js';
import { jsonDigest } from './step-digest.js';
import { characterRevision, worldTables } from './simulation-changes.js';
import { capturedCharacterProof, prepareCharacterProof } from './ordered-characters.js';
import { AdmissionJournal } from './admission-journal.js';

const orderedTables = [...worldTables, 'life.events', 'life.bonds', 'life.stories',
  'life.places', 'life.haunts', 'life.bloomThrough', 'life.eventThrough'];
const tableAt = (data, name) => name.startsWith('life.') ? data.life?.[name.slice(5)] : data[name];

const largeTables = new Set(['chars', 'fishes', 'ops', 'travel']);
const snapshotPages = new WeakMap();
const proofTables = new WeakMap();
export function capturedOrderedRows(data, name) {
  return snapshotPages.get(name === undefined ? data : proofTables.get(data)?.[name]);
}

function prepareCheckpointPages(world) {
  return Promise.all([prepareCharacterProof(world), prepareCharacterProof(world, 'ops')]);
}

export function captureOrderedWorld(world, store) {
  const source = { ...world.data }, prepared = [];
  for (const name of ['chars', 'ops']) {
    const pages = capturedCharacterProof(world, name);
    if (pages) { prepared.push([name, pages]); source[name] = null; }
  }
  const data = structuredClone(source);
  const proof = { ...data };
  for (const [name, pages] of prepared) {
    proof[name] = {};
    snapshotPages.set(proof[name], pages);
    Object.defineProperty(data, name, { configurable: true, enumerable: true, get() {
      const rows = pages.materialize();
      Object.defineProperty(data, name, { configurable: true, enumerable: true, writable: true, value: rows });
      return rows;
    } });
  }
  proofTables.set(data, proof);
  const archives = structuredClone({ manifests: store.manifests, summary: store.summary, overrides: store.overrides });
  return { world: { data, ambient: world.ambient }, store: archives };
}

export function checkpointOrder(data, requested) {
  data = proofTables.get(data) ?? data;
  const order = {};
  for (const name of requested || orderedTables) {
    if (!orderedTables.includes(name) || !requested && largeTables.has(name)) continue;
    const rows = tableAt(data, name);
    if (!rows) continue;
    const captured = capturedOrderedRows(rows);
    if (captured) { order[name] = captured.keys; continue; }
    const keys = [];
    for (const id in rows) {
      keys.push(id);
      if (!requested && keys.length > 128) break;
    }
    if (requested || keys.length <= 128) order[name] = keys;
  }
  return order;
}

// State that determines traversal order is part of the commitment. Hash small
// numbered pages in order so encoding a real sea can yield to the renderer.
async function checkpointProof(world, store, data, valid) {
  const revision = characterRevision(world);
  let yieldAt = performance.now() + 2;
  async function table(rows) {
    const keys = Object.keys(rows), pages = [];
    for (let at = 0; at < keys.length; at += 128) {
      if (!valid()) return;
      if (performance.now() >= yieldAt) {
        if (globalThis.scheduler?.yield) await scheduler.yield();
        else if (globalThis.setImmediate) await new Promise(resolve => setImmediate(resolve));
        else await new Promise(resolve => setTimeout(resolve, 0));
        yieldAt = performance.now() + 2;
      }
      const page = keys.slice(at, at + 128).map(id => [id, rows[id]]);
      // Checkpoint rows use the same JSON representation as the stored world.
      // Only the archive index below contains sets and maps.
      pages.push(jsonDigest(page));
    }
    return Promise.all(pages);
  }
  const fields = [], tableProofs = {};
  let bondOrder;
  async function proveTable(name, value) {
    const prepared = capturedOrderedRows(value) || !proofTables.has(world.data) && (name === 'chars' || name === 'ops') &&
      value === world.data[name] && capturedCharacterProof(world, name);
    const pages = await (prepared ? prepared.hashes : table(value));
    if (valid() && orderedTables.includes(name) && (largeTables.has(name) || pages.length > 1)) tableProofs[name] = await stepDigest(pages);
    if (name === 'life.bonds' && pages?.length > 1) bondOrder = await jsonDigest(Object.keys(value));
    return pages;
  }
  let characterPages;
  let bondEntry;
  for (const name of Object.keys(data)) {
    if (!valid()) return;
    const field = data[name];
    if (name === 'life' && field) {
      const parts = [];
      for (const [key, value] of Object.entries(field)) parts.push([key, value && typeof value === 'object' && !Array.isArray(value)
        ? ['pages', await proveTable('life.' + key, value)] : ['value', value]]);
      bondEntry = parts.find(part => part[0] === 'bonds');
      fields.push([name, 'life', parts]);
    } else if (field && typeof field === 'object' && !Array.isArray(field)) {
      const pages = await proveTable(name, field);
      fields.push([name, 'pages', pages]);
      if (name === 'chars') characterPages = { table: field, hashes: pages, revision };
    }
    else fields.push([name, 'value', field]);
  }
  if (!valid()) return {};
  const commonArchives = await stepDigest([world.ambient, Object.keys(store.manifests).sort(), store.summary, store.overrides]);
  const whole = () => stepDigest([fields, commonArchives]);
  const proof = await whole();
  if (!bondEntry) return { proof, exceptBonds: proof, tableProofs, characterPages };
  const before = bondEntry[1];
  bondEntry[1] = null;
  const exceptBonds = await whole();
  bondEntry[1] = before;
  async function withBonds(bonds) {
    bondEntry[1] = ['pages', await table(bonds)];
    return valid() ? whole() : undefined;
  }
  return { proof, exceptBonds, withBonds, tableProofs, characterPages, bondOrder };
}

// Merging can preserve every record but reorder a dictionary. The leader's
// order matters to subsequent simulation and conflict ties. Only rearrange
// local rows, and only install them after the complete checkpoint hash agrees.
export async function orderedCheckpoint(world, store, orders, valid = () => true) {
  const changes = {}, data = { ...(proofTables.get(world.data) ?? world.data) };
  if (orders) {
    for (const [name, keys] of Object.entries(orders)) {
      if (!orderedTables.includes(name)) throw new Error('共同检查点包含未知表');
      let table = tableAt(data, name);
      const captured = capturedOrderedRows(table), local = captured?.keys || Object.keys(table || {});
      // Separate legitimate histories can retain a different set of pairs.
      // Preserve our full local table until the ordinary history join verifies.
      if (name === 'life.bonds' && table && Array.isArray(keys) &&
          (keys.length !== local.length || keys.some(id => !Object.hasOwn(table, id)))) continue;
      if (!table || !Array.isArray(keys) || keys.length !== local.length) throw new Error('共同检查点的数据不齐');
      if (keys.every((key, i) => key === local[i])) continue;
      if (captured) table = captured.materialize();
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
  return { ...await checkpointProof(world, store, data, valid), changes };
}

export class OrderedSession {
  constructor(io) { this.io = io; }

  valid(s) {
    return this.current === s && this.io.peer() === s.peer && this.io.world() === s.world &&
      this.io.leader() === s.leader && this.io.store() === s.store && (s.snapshot && !s.steps ||
      s.store.revision === s.revision && s.world.data.archives?.at === s.archiveAt);
  }
  send(s, message) {
    if (!this.valid(s)) return;
    return this.io.send(s.peer, { ...message, epoch: s.epoch });
  }
  stop(reason, inform = true, retryAdmission = false) {
    const s = this.current;
    if (!s) return;
    // Both members accepted the checkpoint and sealed the first input. A late
    // ready can retry admission on the next ordinary publication.
    if (retryAdmission && !s.executed && s.steps?.next?.sealed && (s.localReady || s.remoteReady)) this.retryAt = 0;
    this.current = null;
    s.joined?.(false);
    s.steps?.close();
    s.archive?.plan?.close();
    s.archive?.done?.(false);
    if (inform) this.io.send(s.peer, { action: 'stop', epoch: s.epoch }).catch(() => {});
    this.io.stopped(s, reason);
  }
  changed(world, patch, origin, merge) {
    const s = this.current;
    if (!s || world !== s.world || s.applying) return;
    if (s.snapshot && !s.steps) {
      s.changedAfterCut = true;
      s.journal.changed(patch, origin, merge);
      if (s.owner && patch?.workerChanges && patch.values?.tick === world.data.tick) s.journal.capture(world);
      return;
    }
    if (s.running && patch?.workerChanges && patch.values?.tick === s.steps.next?.tick) {
      this.committed(s);
      return;
    }
    if (s.waiting && !s.checking) return;
    this.stop('世界在共同基准之外有新变更');
  }
  archiveChanging(reason) {
    const s = this.current;
    if (s?.snapshot && !s.steps) this.changed(s.world);
    else this.stop(reason);
  }
  committed(s) {
    if (s.executed) return;
    s.executed = true;
    s.snapshot = undefined;
    s.journal = undefined;
    this.io.firstCommit?.(s.world);
  }
  begin(peer, epoch, base) {
    const world = this.io.world(), store = this.io.store();
    return this.current = { peer, epoch, base, world, store, revision: store.revision, archiveAt: world.data.archives?.at,
      leader: this.io.leader(), owner: this.io.isLeader(), began: performance.now(), receipts: new Map() };
  }
  async probe() {
    const peer = this.io.peer(), now = performance.now();
    const prior = this.current;
    if (prior?.nextCut && prior.owner && this.valid(prior) && prior.world.data.tick > prior.base) {
      prior.joined?.(false);
      const s = this.begin(peer, crypto.randomUUID(), prior.world.data.tick);
      s.priorProof = prior.proof;
      s.orderFields = prior.orderFields;
      return this.openCheckpoint(s);
    }
    if (this.current || !peer || !this.io.isLeader() || now < (this.retryAt || 0) ||
        Date.now() - this.io.world().data.tick > CONFIG.step) return;
    const world = this.io.world(), leader = this.io.leader();
    const possible = this.candidate;
    if (!possible?.acknowledged || possible.peer !== peer || possible.world !== world || possible.leader !== leader || now - possible.askedAt > 1000) {
      if (possible?.peer === peer && !possible.acknowledged && now - possible.askedAt < CONFIG.step / 2) return;
      const id = crypto.randomUUID();
      this.candidate = { peer, world, leader, id, askedAt: now };
      prepareCheckpointPages(world).catch(() => {});
      // An unanswered enquiry never reserves an ecology tick. The existing
      // authority keeps publishing while the other tab finishes its hello.
      await this.io.send(peer, { action: 'available?', id, leader });
      return;
    }
    this.candidate = undefined;
    this.retryAt = now + 3000;
    const s = this.begin(peer, crypto.randomUUID(), world.data.tick);
    return this.openCheckpoint(s);
  }
  async openCheckpoint(s) {
    this.capture(s);
    const data = s.snapshot.world.data;
    const order = { ...checkpointOrder(data), ...(s.orderFields && checkpointOrder(data, s.orderFields)) };
    await this.send(s, { action: 'opening', base: s.base, order, previous: s.priorProof });
    s.cut = await orderedCheckpoint(s.snapshot.world, s.snapshot.store, undefined, () => this.valid(s));
    const { proof } = s.cut;
    if (!this.valid(s)) return;
    s.proof = proof;
    await this.send(s, { action: 'open', base: s.base, proof, exceptBonds: s.cut.exceptBonds, bondOrder: s.cut.bondOrder, previous: s.priorProof });
  }
  capture(s) {
    if (s.snapshot) return;
    s.snapshot = captureOrderedWorld(s.world, s.store);
    const data = s.snapshot.world.data;
    s.journal = new AdmissionJournal(data, capturedOrderedRows(data, 'chars'), capturedOrderedRows(data, 'ops'));
  }
  appliedReplica(world, changes, incoming, archived) {
    const s = this.current;
    if (!s || s.world !== world || s.owner || !s.journal || s.steps) return;
    s.journal.merged(changes, incoming, archived);
    s.journal.capture(world);
  }
  async afterReplica() {
    const s = this.current;
    if (s?.followAnchor && !s.owner && !s.steps) {
      if (s.journal.broken) return this.send(s, { action: 'pastJoined', base: s.base, proof: s.proof, follow: false });
      return this.offerTip(s);
    }
    if (!s?.waiting || !s.order || s.checking || s.world.data.tick < s.base) return;
    if (!this.valid(s) || !s.snapshot && s.world.data.tick !== s.base) { this.stop('已错过共同检查点'); return; }
    this.capture(s);
    s.checking = true;
    // Loading the independently verified local replica executes no ecological
    // step. The final preparation below rechecks inputs, revision and tick.
    if (!this.io.hasSavedCharacters?.(s.world)) this.preload(s);
    s.cut = await orderedCheckpoint(s.snapshot.world, s.snapshot.store, s.order, () => this.valid(s));
    if (!s.changedAfterCut && s.cut.characterPages?.table === proofTables.get(s.snapshot.world.data).chars) {
      s.cut.characterPages.table = s.world.data.chars;
      s.cut.characterPages.revision = characterRevision(s.world);
    }
    if (this.valid(s) && !Object.keys(s.cut.changes).length) this.preload(s, s.cut.characterPages);
    await this.finishCheckpoint(s);
  }
  preload(s, pages) {
    return s.preload ??= this.io.prepare(s.world, () => this.valid(s) && s.world.data.tick === s.base, pages)
      .catch(error => { if (this.current === s) this.stop(error.message); return null; });
  }
  async finishCheckpoint(s) {
    if (!this.valid(s) || !s.cut?.proof || !s.proof || s.joining) return;
    s.joining = true;
    const { proof, changes } = s.cut;
    if (!this.valid(s)) return;
    if (proof !== s.proof) {
      s.reconciling = true;
      const needsBonds = s.cut.exceptBonds === s.exceptBonds &&
        (s.expanded || !s.cut.bondOrder || !s.bondOrder || s.bondOrder === s.cut.bondOrder);
      await this.send(s, { action: 'history', base: s.base, exceptBonds: s.cut.exceptBonds, tableProofs: s.cut.tableProofs,
        ...(needsBonds && { bonds: s.snapshot.world.data.life.bonds }) });
      return;
    }
    s.checkedProof = proof;
    const atCut = () => this.valid(s) && !s.changedAfterCut && s.world.data.tick === s.base &&
      s.revision === s.store.revision && s.archiveAt === s.world.data.archives?.at && this.io.archiveStable?.() !== false;
    if (atCut() && Object.keys(changes).length) await this.installChecked(s, changes);
    if (!this.valid(s)) return;
    if (atCut()) await this.preload(s, s.cut.characterPages);
    const handle = atCut() && await this.io.prepare(s.world, atCut, s.cut.characterPages);
    if (!this.valid(s)) return;
    if (!handle || !atCut()) {
      if (s.pastBonds) await this.mergePastHistory(s);
      await this.alignPast(s);
      if (this.valid(s)) await this.send(s, { action: 'pastJoined', base: s.base, proof, follow: !changes.chars && !changes.ops && !s.journal.broken });
      return;
    }
    s.waiting = false;
    s.localJoined = true;
    await this.send(s, { action: 'joined', base: s.base, proof, follow: !changes.chars && !changes.ops });
  }
  async alignPast(s) {
    for (const name of Object.keys(s.order || {})) {
      if (!Object.hasOwn(s.cut.changes, name.split('.')[0])) continue;
      const current = s.world.data, rows = tableAt(current, name), order = s.order[name];
      const keys = Object.keys(rows || {});
      if (keys.length !== order.length || order.some(id => !Object.hasOwn(rows, id)) || keys.every((id, i) => id === order[i])) continue;
      const table = Object.fromEntries(order.map(id => [id, rows[id]]));
      const nested = name.startsWith('life.');
      const changes = nested ? { life: { ...current.life, [name.slice(5)]: table } } : { [name]: table };
      const version = s.journal.version;
      await this.io.install(s.world, changes, () => this.valid(s) && s.journal.version === version, fn => {
        s.applying = true;
        try { fn(); } finally { s.applying = false; }
      });
    }
  }
  async offerTip(s) {
    const { tick, version } = s.journal, revision = s.store.revision;
    const current = () => this.valid(s) && !s.steps && s.world.data.tick === tick && s.journal.version === version &&
      s.store.revision === revision && this.io.archiveStable?.() !== false;
    if (s.offeredTip?.version === version || !current()) return;
    const proof = await s.journal.proof(s.world, s.store, s.proof);
    if (!proof || !current()) return;
    const handle = await this.io.prepare(s.world, current);
    if (!handle || !current()) return;
    s.offeredTip = { tick, version, proof, revision };
    await this.send(s, { action: 'tipReady', base: tick, anchor: s.proof, proof, parts: s.journal.tip.parts });
  }
  startTip(s, tick, proof) {
    s.revision = s.store.revision;
    s.archiveAt = s.world.data.archives?.at;
    s.base = tick;
    s.proof = proof;
    s.preload = undefined;
    s.waiting = s.changedAfterCut = false;
    this.start(s);
  }
  async mergePastHistory(s) {
    const life = s.world.data.life, previous = life.bonds;
    const bonds = await this.io.bondHistory(s, s.pastBonds);
    if (bonds === previous || !this.valid(s)) return;
    await this.io.install(s.world, { life: { ...life, bonds } },
      () => this.valid(s) && s.world.data.life === life && life.bonds === previous, action => {
        s.applying = true;
        try { action(); } finally { s.applying = false; }
      });
  }
  installChecked(s, changes) {
    return this.io.install(s.world, changes, () => this.valid(s) && !s.changedAfterCut && s.world.data.tick === s.base &&
      s.revision === s.store.revision && s.archiveAt === s.world.data.archives?.at && this.io.archiveStable?.() !== false, action => {
      const pages = s.cut?.characterPages;
      const current = pages && characterRevision(s.world) === pages.revision;
      s.applying = true;
      try {
        action();
        if (current && pages.table === s.world.data.chars) pages.revision = characterRevision(s.world);
      } finally { s.applying = false; }
    });
  }
  whenJoined(s) {
    if (!this.valid(s)) return Promise.resolve(false);
    if (s.steps) return Promise.resolve(true);
    return s.onJoin ??= new Promise(resolve => { s.joined = resolve; });
  }
  start(s) {
    s.joined?.(true);
    if (!s.owner) this.preload(s, s.followAnchor ? undefined : s.cut?.characterPages);
    s.cut = undefined;
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
    const ticket = s.archive = { boundary, announced: performance.now() };
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
    if (b.action === 'available?') {
      if (!s && !this.io.isLeader() && b.leader === this.io.leader() && typeof b.id === 'string' && b.id.length === 36) {
        const world = this.io.world();
        await Promise.all([prepareCheckpointPages(world), this.io.checkRetained?.(world)]);
        if (!this.current && this.io.peer() === peer && !this.io.isLeader() && b.leader === this.io.leader()) {
          await this.io.send(peer, { action: 'available', id: b.id, leader: b.leader });
        }
      }
      return;
    }
    if (b.action === 'available') {
      const c = this.candidate;
      if (s || !c || !this.io.isLeader() || peer !== c.peer || b.id !== c.id || b.leader !== c.leader ||
          c.world !== this.io.world() || c.leader !== this.io.leader() || performance.now() - c.askedAt > CONFIG.step) return;
      // The next ordinary committed tick invokes probe at its publication
      // boundary. Signing a cut here would spend the first tick's remaining
      // budget on a reply that can arrive anywhere inside that tick.
      c.acknowledged = true;
      return;
    }
    if (b.action === 'open' || b.action === 'opening') {
      const observed = s?.peer === peer && s.epoch === b.epoch && s.base === b.base && s.snapshot;
      if (b.previous !== undefined && (!s || !this.valid(s) || b.previous !== (s.epoch === b.epoch ? s.priorProof : s.checkedProof))) return;
      if (this.io.isLeader() || typeof b.epoch !== 'string' || b.epoch.length !== 36 || !Number.isSafeInteger(b.base) ||
          !observed && b.base < this.io.world().data.tick || b.base > this.io.world().data.tick + CONFIG.step * 2 ||
          (b.action === 'open' ? !/^[0-9a-f]{64}$/.test(b.proof) || !/^[0-9a-f]{64}$/.test(b.exceptBonds)
            : !b.order || typeof b.order !== 'object' || Array.isArray(b.order))) return;
      if (s && s.peer === peer && s.epoch !== b.epoch && !s.executed && !s.steps?.next && s.checkedProof &&
          b.previous === s.checkedProof && b.base > s.base) {
        s.steps?.close();
        s.joined?.(false);
        s = undefined;
      }
      if (s && (s.peer !== peer || s.epoch !== b.epoch || s.base !== b.base || !s.waiting)) return;
      if (!s) {
        s = this.begin(peer, b.epoch, b.base);
        s.priorProof = b.previous;
        s.waiting = true;
      }
      if (b.action === 'open') { s.proof = b.proof; s.exceptBonds = b.exceptBonds; s.bondOrder = b.bondOrder; }
      else s.order = b.order;
      return s.cut ? this.finishCheckpoint(s) : this.afterReplica();
    }
    if (!s || s.peer !== peer || b.epoch !== s.epoch) return;
    if (b.action === 'stop') { this.stop('伙伴已切回世界同步', false, true); return; }
    if (!this.valid(s)) { this.stop('共同结算的连接或归档已更换'); return; }
    if (b.action === 'history' && s.owner && !s.steps && !s.reconciling && b.base === s.base) {
      if (!s.cut?.exceptBonds || b.exceptBonds !== s.cut.exceptBonds || !b.bonds) {
        const different = Object.keys(s.cut?.tableProofs || {}).filter(name => /^[0-9a-f]{64}$/.test(b.tableProofs?.[name]) && b.tableProofs[name] !== s.cut.tableProofs[name]);
        if (!s.expanded && different.length) {
          s.expanded = true;
          s.orderFields = [...new Set([...(s.orderFields || []), ...different])];
          await this.send(s, { action: 'tableOrder', base: s.base, order: checkpointOrder(s.snapshot.world.data, different) });
        } else this.stop('两端已验证的世界内容不同');
        return;
      }
      s.reconciling = true;
      const bonds = await this.io.bondHistory({ ...s, world: s.snapshot.world }, b.bonds);
      if (!this.valid(s)) return;
      const proof = await s.cut.withBonds(bonds);
      if (!proof || !this.valid(s)) return;
      if (bonds !== s.snapshot.world.data.life.bonds) {
        s.pastBonds = bonds;
        if (s.changedAfterCut || s.world.data.tick !== s.base) await this.mergePastHistory(s);
        else await this.installChecked(s, { life: { ...s.world.data.life, bonds } });
      }
      s.proof = proof;
      await this.send(s, { action: 'historyCut', base: s.base, proof, bonds });
      return;
    }
    if (b.action === 'tableOrder' && !s.owner && s.reconciling && !s.expanded && !s.steps && b.base === s.base) {
      if (!b.order || !Object.keys(b.order).every(name => orderedTables.includes(name))) return;
      s.expanded = true;
      s.order = { ...s.order, ...b.order };
      s.cut = undefined;
      s.joining = s.checking = s.reconciling = false;
      await this.afterReplica();
      return;
    }
    if (b.action === 'historyCut' && !s.owner && s.reconciling && !s.steps && b.base === s.base && /^[0-9a-f]{64}$/.test(b.proof)) {
      const bonds = await this.io.bondHistory({ ...s, world: s.snapshot.world }, b.bonds);
      if (!this.valid(s)) return;
      const proof = await s.cut.withBonds(bonds);
      if (!this.valid(s)) return;
      if (proof !== b.proof) { this.stop('伙伴历史归并结果不同'); return; }
      s.pastBonds = bonds;
      s.cut.changes.life = { ...(s.cut.changes.life || s.snapshot.world.data.life), bonds };
      s.cut.proof = s.proof = proof;
      s.joining = false;
      await this.finishCheckpoint(s);
      return;
    }
    if (b.action === 'pastJoined' && s.owner && !s.executed && !s.steps?.next?.sealed && b.base === s.base && b.proof === s.proof) {
      s.steps?.close();
      s.steps = undefined;
      if (b.follow === true && !s.journal.broken) {
        s.followAnchor = true;
        return this.send(s, { action: 'followAnchor', base: s.base, proof: s.proof });
      }
      s.nextCut = true;
      return;
    }
    if (b.action === 'joined' && s.owner && !s.steps && b.base === s.base && b.proof === s.proof) {
      if (s.changedAfterCut || s.world.data.tick !== s.base || s.store.revision !== s.revision ||
          s.world.data.archives?.at !== s.archiveAt || this.io.archiveStable?.() === false) {
        if (b.follow !== true || s.journal.broken) { s.nextCut = true; return; }
        s.followAnchor = true;
        return this.send(s, { action: 'followAnchor', base: s.base, proof: s.proof });
      }
      this.start(s);
      return this.offer(s);
    }
    if (b.action === 'followAnchor' && !s.owner && !s.steps && b.base === s.base && b.proof === s.checkedProof) {
      if (s.cut?.changes.chars || s.cut?.changes.ops || s.journal.broken) {
        return this.send(s, { action: 'pastJoined', base: s.base, proof: s.proof, follow: false });
      }
      s.followAnchor = true;
      return this.offerTip(s);
    }
    if (b.action === 'tipReady' && s.owner && s.followAnchor && !s.steps && b.base === s.world.data.tick && b.anchor === s.proof && /^[0-9a-f]{64}$/.test(b.proof)) {
      if (s.journal.broken) { s.nextCut = true; return; }
      const version = s.journal.version, revision = s.store.revision, proof = await s.journal.proof(s.world, s.store, s.proof);
      if (!proof || !this.valid(s) || s.steps || s.world.data.tick !== b.base || s.journal.version !== version ||
          s.store.revision !== revision || this.io.archiveStable?.() === false) return;
      if (proof !== b.proof) {
        s.differences = { fields: ['chars/ops', 'world', 'archive'].filter((name, i) => s.journal.tip.parts[i] !== b.parts?.[i]), tick: b.base };
        this.stop('双方实际提交的增量结果不同'); return;
      }
      this.startTip(s, b.base, proof);
      return this.offer(s);
    }
    if (b.action === 'offer' && !s.owner && !s.steps && s.followAnchor && s.offeredTip?.proof === b.previous &&
        s.offeredTip.tick === b.base && s.offeredTip.version === s.journal.version && s.offeredTip.revision === s.store.revision &&
        this.io.archiveStable?.() !== false && s.world.data.tick === b.base) {
      this.startTip(s, b.base, b.previous);
    }
    if (b.action === 'offer' && !s.owner && !s.steps && s.localJoined && b.base === s.base && b.previous === s.proof) {
      if (s.changedAfterCut || s.world.data.tick !== s.base || s.revision !== s.store.revision || s.archiveAt !== s.world.data.archives?.at) {
        await this.send(s, { action: 'pastJoined', base: s.base, proof: s.proof, follow: !s.cut?.changes.chars && !s.cut?.changes.ops });
        return;
      }
      this.start(s);
    }
    if (!s.steps) return;
    if (b.action === 'archive' && !s.owner && !s.archive) {
      if (!b.boundary || !/^[0-9a-f]{64}$/.test(b.id) || await stepDigest(b.boundary) !== b.id || !this.valid(s) || s.archive) return;
      const ticket = s.archive = { boundary: b.boundary, id: b.id };
      await this.prepareArchive(s, ticket);
      if (ticket.plan) await this.send(s, { action: 'archiveReady', id: ticket.id });
      return;
    }
    if (b.action === 'archiveReady' && s.owner && s.archive?.id && s.archive.id === b.id) {
      s.archive.remote = true;
      return;
    }
    if (b.action === 'offer' && !s.owner && !s.steps.next && b.base === s.steps.tick && b.previous === s.steps.proof &&
        b.archive !== undefined && (!s.archive?.plan || b.archive !== s.archive.id)) {
      this.stop('共同归档尚未校验'); return;
    }
    if (b.action === 'finished') {
      if (!s.owner || !Number.isSafeInteger(b.base) || !/^[0-9a-f]{64}$/.test(b.proof) ||
          (b.base !== s.steps.tick && b.base !== s.steps.next?.tick)) return;
      const ticket = s.archive;
      if (ticket?.id && !ticket.committed) {
        if (b.archive === ticket.id && b.verifiedArchive === true) ticket.remote = true;
        else if (b.archive !== ticket.id && performance.now() - ticket.announced > 1000) {
          ticket.announced = performance.now();
          await this.send(s, { action: 'archive', boundary: ticket.boundary, id: ticket.id });
        }
      }
      s.finished = { base: b.base, proof: b.proof };
      return this.nextOffer(s);
    }
    if (b.action === 'prepared') {
      if (s.steps.next?.digest && s.steps.next.digest === b.digest && b.base === s.steps.tick && /^[0-9a-f]{64}$/.test(b.outcomes)) {
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
    if (s.preload) { await s.preload; s.preload = null; }
    if (!this.valid(s)) return;
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
    if (s.snapshot && !s.steps) return false;
    if (s.waiting && s.world.data.tick < s.base) {
      if (performance.now() - s.began >= 2000) this.stop('直连未送达已约定的起始步');
      return false;
    }
    if (!s.localReady || s.localReady !== s.remoteReady) {
      this.stop('本步输入尚未得到双方确认', true, true); return false;
    }
    const slot = s.steps.take(s.world.data.tick);
    if (!slot) { this.stop('共同基准已变更'); return false; }
    s.running = true;
    const handle = s.handle;
    s.handle = s.localReady = s.remoteReady = null;
    this.io.advance(s.world, slot.tick, () => this.valid(s), handle).then(async result => {
      if (!this.valid(s)) return;
      if (!result || result.tick !== slot.tick) { this.stop('共同结算未提交'); return; }
      this.committed(s);
      s.base = result.tick;
      const proof = await s.steps.complete(slot, { ...result, outcomes: slot.outcomes });
      if (!this.valid(s) || !proof) return;
      s.running = false;
      if (s.owner) await this.nextOffer(s);
      else await this.send(s, { action: 'finished', base: s.base, proof,
        ...(s.archive && { archive: s.archive.id, verifiedArchive: !!s.archive.plan }) });
    }).catch(error => { if (this.current === s) this.stop(error.message); });
    return true;
  }
}
