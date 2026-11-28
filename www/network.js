import { signer, verifyEnvelope, readSignedFrame } from './storage.js';
import { normalizeInvite, decodeInvite } from './invite.js';
import { changesSince, coalesceWorld, fitsLegacyEnvelope, LIVE_FRAME_UNITS, PAGE_UNITS, ReplicaTransfers } from './replica-stream.js';
import { supportsPoseBytes } from './replica-row-delta.js';
const CHUNK = 16000, MAX_PEERS = 8, MAX_RAW = 32 * 1024 * 1024, encoder = new TextEncoder(), decoder = new TextDecoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const replicaRowsVersion = 1;
const replicaOffer = { replicaPages: 1, replicaLive: 1, replicaRows: replicaRowsVersion, replicaFrames: 1, replicaPoseBytes: Number(supportsPoseBytes), replicaTransitions: 1, replicaSignedFrames: 1 };
const signedPageBytes = new WeakMap();
function replicaCapabilities(peer, signal) {
  peer.replicaPages = signal.replicaPages === 1;
  peer.replicaLive = peer.replicaPages && signal.replicaLive === 1;
  peer.replicaRows = peer.replicaLive && replicaRowsVersion === 1 && signal.replicaRows === 1;
  peer.replicaFrames = peer.replicaRows && signal.replicaFrames === 1;
  peer.replicaTransitions = peer.replicaFrames && signal.replicaTransitions === 1;
  peer.replicaSignedFrames = peer.replicaFrames && signal.replicaSignedFrames === 1;
  peer.replicaPoseBytes = peer.replicaFrames && supportsPoseBytes && signal.replicaPoseBytes === 1;
}
const DIRECT_ERROR = '入口可访问，但浏览器直连未建立，请检查双方网络及防火墙后重试';
export async function lanDescription(description, fromUrl) {
  const ip = new URL(await decodeInvite(fromUrl)).hostname;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || typeof description?.sdp !== 'string') return description;
  // The launcher supplies its IPv4 route to this peer; ICE supplies the UDP port.
  const sdp = description.sdp.replace(/^(a=candidate:\S+[ \t]+\d+[ \t]+udp[ \t]+\d+[ \t]+)\S+\.local([ \t]+\d+[ \t]+typ[ \t]+host(?=[ \t\r\n]|$)[^\r\n]*)/gim, (_, prefix, suffix) => prefix + ip + suffix);
  return sdp === description.sdp ? description : { ...description, sdp };
}
async function inflateBounded(bytes, limit = MAX_RAW) { const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), chunks = []; let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error('解压数据过大'); } chunks.push(value); } const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
export class Network {
  constructor(identity, meta, onMessage, onChange, onReject, recentArchivePacks) { this.recentArchivePacks = recentArchivePacks; this.identity = identity; this.meta = meta; this.node = identity.actor.slice(0, 16) + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 19); this.onMessage = onMessage; this.onChange = onChange; this.onReject = onReject; this.replicas = new ReplicaTransfers(this); this.lastLegacyBeat = 0; this.worldMembers = new Map(); this.connections = new Map(); this.seen = new Map(); this.pending = new Map(); this.stats = { sent: 0, received: 0, rejected: 0 }; }
  async local(route, payload = {}) { const response = await fetch('/local/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: this.meta.token, node: this.node, ...payload }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '本地配对通道不可用'); return result; }
  async start(nick) { this.sign = await signer(this.identity); await this.local('register', { nick, actor: this.identity.actor }); this.events = new EventSource(`/local/events?node=${this.node}&token=${encodeURIComponent(this.meta.token)}`); this.events.onmessage = e => { try { this.signal(JSON.parse(e.data)).catch(error => this.onChange(error.message)); } catch { } }; }
  live() { return [...this.connections.values()].filter(p => p.dc?.readyState === 'open'); }
  has(node) { return [...this.connections.values()].some(p => p.node === node && !['closed', 'failed'].includes(p.pc.connectionState)); }
  async connectInvite(value, options = {}) { const code = await normalizeInvite(value); return this.connect(code, '', new Set(), code, !!options.silent); }
  async connect(url, requestedNode = '', visited = new Set(), entryInvite = '', silent = false) {
    url = await normalizeInvite(url);
    if (visited.has(url + requestedNode)) return; visited.add(url + requestedNode);
    const status = await this.local('probe', { url });
    const existing = [...this.connections.values()].find(p => (status.clients || []).some(c => c.id === p.node && (!requestedNode || c.id === requestedNode)));
    if (existing) return this.waitForConnection(existing);
    if (this.connections.size >= MAX_PEERS) throw new Error('你的直接连接已达上限，请稍后重试');
    const possible = (status.clients || []).filter(c => c.id !== this.node && !this.has(c.id) && c.peers < MAX_PEERS && (!requestedNode || c.id === requestedNode));
    const target = possible.sort((a, b) => a.peers - b.peers)[0];
    if (!target) { for (const hint of (status.hints || []).slice(0, 8)) { if (hint.id !== this.node && !this.has(hint.id)) { try { await this.connect(hint.url, hint.id, visited, entryInvite, silent); if (this.live().length) return; } catch { } } } throw new Error('入口可访问，但暂时没有正在玩的伙伴或空位'); }
    const id = crypto.randomUUID(), p = this.make(id, url, target.id); p.entryInvite = entryInvite; p.silent = silent; this.attach(p, p.pc.createDataChannel('tide'));
    try { await p.pc.setLocalDescription(await p.pc.createOffer()); await this.ice(p.pc); const result = await this.local('relay', { url, signal: { type: 'offer', ...replicaOffer, from: this.node, to: target.id, connection: id, sdp: p.pc.localDescription.toJSON() } }); if (!result.ok) throw new Error(result.error || '配对入口繁忙'); await this.waitForConnection(p); } catch (e) { this.close(p, e); throw e; }
  }
  waitForConnection(p) { if (p.dc?.readyState === 'open') return Promise.resolve(); if (!this.connections.has(p.id)) return Promise.reject(p.error || new Error(DIRECT_ERROR)); return new Promise((resolve, reject) => p.waiters.add({ resolve, reject })); }
  make(id, url, node) {
    const p = { id, url, node, pc: new RTCPeerConnection({ iceServers: [] }), packets: new Map(), sendQueue: Promise.resolve(), queued: 0, created: Date.now(), waiters: new Set() };
    this.connections.set(id, p); p.pc.ondatachannel = event => this.attach(p, event.channel);
    p.pc.onconnectionstatechange = () => { if (['closed', 'failed'].includes(p.pc.connectionState)) this.close(p); };
    p.timeout = setTimeout(() => { if (p.dc?.readyState !== 'open') this.close(p, new Error(DIRECT_ERROR)); }, 30000); return p;
  }
  async ice(pc) { if (pc.iceGatheringState === 'complete') return; await new Promise(resolve => { const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } }; pc.addEventListener('icegatheringstatechange', done); setTimeout(() => { pc.removeEventListener('icegatheringstatechange', done); resolve(); }, 5000); }); }
  async signal(s) {
    if (s.from === this.node) return;
    s.fromUrl = await normalizeInvite(s.fromUrl);
    if (s.type === 'offer') {
      if (this.connections.size >= MAX_PEERS || this.has(s.from)) { await this.local('relay', { url: s.fromUrl, signal: { type: 'reject', from: this.node, to: s.from, connection: s.connection } }); return; }
      const p = this.make(s.connection, s.fromUrl, s.from); replicaCapabilities(p, s); try { await p.pc.setRemoteDescription(await lanDescription(s.sdp, s.fromUrl)); await p.pc.setLocalDescription(await p.pc.createAnswer()); await this.ice(p.pc); await this.local('relay', { url: p.url, signal: { type: 'answer', ...replicaOffer, from: this.node, to: s.from, connection: s.connection, sdp: p.pc.localDescription.toJSON() } }); } catch (e) { this.close(p); throw e; }
    } else { const p = this.connections.get(s.connection); if (!p) return; if (s.type === 'reject') { this.close(p, new Error('对方暂时无法接受连接，请稍后重试')); return; } p.node = s.from; p.url = s.fromUrl; replicaCapabilities(p, s); await p.pc.setRemoteDescription(await lanDescription(s.sdp, s.fromUrl)); }
  }
  attach(p, dc) {
    p.dc = dc; dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 65536;
    dc.onopen = () => { clearTimeout(p.timeout); for (const waiter of p.waiters) waiter.resolve(); p.waiters.clear(); const duplicates = this.live().filter(x => x.node === p.node).sort((a, b) => a.id.localeCompare(b.id)); for (const extra of duplicates.slice(1)) this.close(extra); this.onChange(); };
    dc.onclose = () => this.close(p);
    dc.onmessage = e => { this.receive(p, e.data).catch(error => { this.stats.rejected++; this.onReject?.(error, p); }); };
  }
  close(p, error = new Error(DIRECT_ERROR)) { if (!this.connections.has(p.id)) return; this.connections.delete(p.id); this.replicas.close(p, error); clearTimeout(p.timeout); p.error = error; for (const waiter of p.waiters) waiter.reject(error); p.waiters.clear(); p.pc.onconnectionstatechange = null; if (p.dc) p.dc.onclose = null; p.pc.close(); this.onChange(); }
  async makeEnvelope(kind, body, { capturedWorld = false } = {}) {
    const page = kind === 'replicaPage' && typeof body?.text === 'string';
    if (capturedWorld || page) {
      // Detached world snapshots and serialized page strings stay immutable
      // through signing and encoding; only the surrounding message can change.
      const key = page ? 'text' : 'world';
      const { [key]: snapshot, ...metadata } = body;
      body = { ...structuredClone(metadata), [key]: snapshot };
    } else body = structuredClone(body);
    const message = { id: crypto.randomUUID(), kind, from: this.node, actor: this.identity.actor, key: this.identity.pub, body };
    if (page && this.sign.bytes) {
      const bytes = encoder.encode(JSON.stringify(message));
      const envelope = { ...message, signature: await this.sign.bytes(bytes) };
      signedPageBytes.set(envelope, bytes);
      return envelope;
    }
    return { ...message, signature: await this.sign(message) };
  }
  async encode(message) {
    const signed = signedPageBytes.get(message);
    // JSON.stringify appended the envelope's closing brace after the body. The
    // receiver authenticates precisely those bytes, including property order.
    const parts = signed ? [signed.subarray(0, -1), encoder.encode(',"signature":' + JSON.stringify(message.signature) + '}')]
      : [encoder.encode(JSON.stringify(message))];
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (size > MAX_RAW) throw new Error('世界快照过大');
    if (size > 2048 && typeof CompressionStream !== 'undefined') {
      const bytes = new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      const result = new Uint8Array(bytes.length + 1);
      result[0] = 1; result.set(bytes, 1); return result;
    }
    const result = new Uint8Array(size + 1);
    let offset = 1;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  async encodeLiveFrame(id, body, knownArchives) {
    if (knownArchives && this.recentArchivePacks) {
      let left = PAGE_UNITS, archivePacks;
      for (const [hash, encoded] of this.recentArchivePacks()) {
        if (encoded.length > left || Object.hasOwn(knownArchives, hash) || !Object.hasOwn(body.world.archives?.chunks ?? {}, hash)) continue;
        (archivePacks ??= {})[hash] = encoded;
        left -= encoded.length;
      }
      if (archivePacks) body = { ...body, archivePacks };
    }
    const message = { id, kind: 'replicaFrame', from: this.node, actor: this.identity.actor, key: this.identity.pub, body };
    const text = JSON.stringify(message);
    if (text.length > LIVE_FRAME_UNITS) return;
    const raw = encoder.encode(text);
    if (raw.length > LIVE_FRAME_UNITS) return;
    const compressed = raw.length > 2048 && typeof CompressionStream !== 'undefined';
    const [signature, payload] = await Promise.all([
      this.sign.bytes(raw),
      compressed ? new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer() : raw
    ]);
    const wire = new Uint8Array(65 + payload.byteLength);
    wire[0] = compressed ? 3 : 2;
    wire.set(Uint8Array.from(atob(signature), c => c.charCodeAt(0)), 1);
    wire.set(compressed ? new Uint8Array(payload) : raw, 65);
    return wire;
  }
  replicaPeers() { return this.live().filter(p => !p.replicaPages || p.sentHello && p.confirmedReplica); }
  worldReplicaPeers() {
    const ready = this.replicaPeers();
    const joining = this.live().filter(peer => peer.replicaLive && peer.sentHello && !peer.confirmedReplica);
    return joining.length ? [...ready, ...joining] : ready;
  }
  liveReplicaFrom(node) { return this.worldReplicaPeers().some(peer => peer.node === node && peer.replicaLive); }
  periodicWorldRequired() {
    return this.worldReplicaPeers().some(peer => !peer.replicaLive) || this.hasRelayedWorldPeer(this.live());
  }
  hasRelayedWorldPeer(peers, now = Date.now()) {
    const direct = new Set(peers.map(peer => peer.node));
    let relayed = false;
    for (const [node, seen] of this.worldMembers) {
      if (now - seen >= 120000) this.worldMembers.delete(node);
      else if (!direct.has(node)) relayed = true;
    }
    return relayed;
  }
  fitsLegacy(kind, body) {
    // Web Crypto P-256 signatures are 64 bytes, or 88 base64 characters.
    const header = { id: '0'.repeat(36), kind, from: this.node, actor: this.identity.actor, key: this.identity.pub, body: null, signature: '0'.repeat(88) };
    return fitsLegacyEnvelope(body, MAX_RAW - encoder.encode(JSON.stringify(header)).length + 4);
  }
  async broadcastEnvelope(message, peers = this.live()) { this.seen.set(message.id, Date.now()); const bytes = await this.encode(message); await Promise.allSettled(peers.map(p => this.send(p, message.id, bytes))); return message; }
  stageWorld(body, peers) { this.replicas.stageLive(body, peers.filter(peer => peer.replicaLive)); }
  clearPendingWorld() {
    this.replicas.discardPendingLive();
    this.worldRelayPending = null;
  }
  relayWorld(body, options) {
    this.worldRelayPending = { body: coalesceWorld(this.worldRelayPending?.body, body), options };
    if (this.worldRelayRunning) return;
    this.worldRelayRunning = true;
    const send = async () => {
      try {
        while (this.worldRelayPending) {
          const next = this.worldRelayPending;
          this.worldRelayPending = null;
          const connected = this.replicaPeers();
          const peers = this.hasRelayedWorldPeer(connected) ? connected : connected.filter(peer => !peer.replicaLive);
          if (peers.length) await this.broadcastReplica('world', next.body, next.options, peers);
        }
      } finally { this.worldRelayRunning = false; }
    };
    send().catch(error => this.onChange?.(error.message));
  }
  async broadcastReplica(kind, body, options, peers) {
    const legacy = peers.some(p => !p.replicaPages) || Date.now() - this.lastLegacyBeat < 120000;
    if (!legacy || !await this.fitsLegacy(kind, body)) {
      if (peers.every(p => !p.replicaPages)) throw new Error('世界太大，联机伙伴需更新才能分块同步');
      return this.replicas.broadcast(kind, body, peers);
    }
    return this.broadcastEnvelope(await this.makeEnvelope(kind, body, options), peers);
  }
  async broadcast(kind, body, options) {
    if ((kind === 'merge' || kind === 'world') && body.world) {
      const peers = kind === 'world' ? this.worldReplicaPeers() : this.replicaPeers();
      if (!peers.length) return;
      if (kind === 'world') {
        const live = peers.filter(peer => peer.replicaLive);
        if (live.length) {
          const snapshot = options?.capturedWorld ? body : structuredClone(body);
          this.replicas.publishLive(snapshot, live);
          if (live.length !== peers.length || this.hasRelayedWorldPeer(peers)) this.relayWorld(snapshot, { capturedWorld: true });
          return;
        }
      }
      return this.broadcastReplica(kind, body, options, peers);
    }
    return this.broadcastEnvelope(await this.makeEnvelope(kind, body));
  }
  async direct(p, kind, body, captureCurrent, options) {
    if (kind === 'hello' && body.world) {
      if (p.replicaPages) {
        const base = await this.replicas.hello(p, body);
        if (p.replicaLive) { p.replicaCatchingUp = true; p.sentHello = true; }
        if (captureCurrent) {
          const current = await captureCurrent();
          // The peer has the baseline. Changes after this cut can travel in the
          // live stream while we reconcile what changed during its first join.
          p.sentHello = true;
          await this.replicas.hello(p, { base: base.version, world: await changesSince(base.world, current) }, 'catchup');
        }
        p.sentHello = true;
        p.replicaCatchingUp = false;
        this.replicas.resumeLive(p);
        return;
      }
      if (!await this.fitsLegacy(kind, body)) throw new Error('世界太大，联机伙伴需更新才能分块同步');
    }
    return this.directControl(p, kind, body, options);
  }
  async directControl(p, kind, body, options) { const message = await this.makeEnvelope(kind, body, options); this.seen.set(message.id, Date.now()); await this.send(p, message.id, await this.encode(message), true); return message; }
  async send(p, id, bytes, reliable = false) {
    while (reliable && p.queued > 8) await p.sendQueue.catch(() => {});
    if (p.dc?.readyState !== 'open') { if (reliable) throw new Error('伙伴连接已关闭'); return; }
    if (p.queued > 8) return;
    p.queued++;
    const operation = p.sendQueue.catch(() => {}).then(async () => { const total = Math.ceil(bytes.length / CHUNK); for (let index = 0; index < total; index++) { let waited = 0; while (p.dc.bufferedAmount > 262144 && p.dc.readyState === 'open') { await sleep(20); if (++waited > 500) throw new Error('连接发送队列超时'); } if (p.dc.readyState !== 'open') { if (reliable) throw new Error('伙伴连接已关闭'); break; } const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK), frame = new Uint8Array(44 + part.length); frame.set(encoder.encode(id), 0); const view = new DataView(frame.buffer); view.setUint32(36, total); view.setUint32(40, index); frame.set(part, 44); p.dc.send(frame); this.stats.sent += frame.length; } }).finally(() => { p.queued--; }); p.sendQueue = operation; return operation;
  }
  async receive(p, buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 45 || buffer.byteLength > CHUNK + 44) return;
    const frame = new Uint8Array(buffer), id = decoder.decode(frame.subarray(0, 36)), view = new DataView(buffer), total = view.getUint32(36), index = view.getUint32(40);
    if (this.seen.has(id) || total < 1 || total > Math.ceil((MAX_RAW + 1) / CHUNK) || index >= total) return;
    if (!p.packets.has(id)) { if (p.packets.size > 4) return; p.packets.set(id, { total, parts: [], size: 0, count: 0, at: Date.now() }); }
    const record = p.packets.get(id); if (record.total !== total || record.parts[index]) return; record.parts[index] = frame.slice(44); record.size += frame.length - 44; record.count++; this.stats.received += frame.length;
    for (const [pid, entry] of p.packets) if (Date.now() - entry.at > 30000) p.packets.delete(pid);
    if (record.size > 32 * 1024 * 1024) { p.packets.delete(id); return; } if (record.count !== total) return;
    p.packets.delete(id); const bytes = new Uint8Array(record.size); let offset = 0; for (const part of record.parts) { bytes.set(part, offset); offset += part.length; }
    const signedFrame = bytes[0] === 2 || bytes[0] === 3;
    let message;
    if (signedFrame) {
      if (!p.replicaSignedFrames || bytes.length <= 65) throw new Error('伙伴未确认直达实时帧格式');
      const payload = bytes.subarray(65);
      const raw = bytes[0] === 3 ? await inflateBounded(payload, LIVE_FRAME_UNITS) : payload;
      if (raw.length > LIVE_FRAME_UNITS) throw new Error('实时帧超过接收容量');
      message = await readSignedFrame(raw, bytes.subarray(1, 65));
      if (message.id !== id || message.from !== p.node) throw new Error('实时帧来源无效');
    } else {
      let raw = bytes.subarray(1);
      if (bytes[0] === 1) raw = await inflateBounded(raw);
      if (bytes[0] > 1 || raw.length > MAX_RAW) return;
      message = JSON.parse(decoder.decode(raw));
      if (message?.id !== id || message.kind === 'replicaFrame' || !await verifyEnvelope(message)) throw new Error('消息标识或签名无效');
    }
    if (this.seen.has(id)) return;
    this.seen.set(id, Date.now()); if (this.seen.size > 20000) { for (const [k, at] of this.seen) if (Date.now() - at > 120000) this.seen.delete(k); }
    const replicaPage = message.kind === 'replicaPage';
    if (signedFrame || replicaPage || message.kind === 'replicaReceipt') {
      const relayingWorld = replicaPage && message.body?.kind === 'world' && this.liveReplicaFrom(message.from);
      if (!relayingWorld && !await this.replicas.receive(message, p)) return;
    } else {
      if ((message.kind === 'beat' || message.kind === 'hello') && message.body.member?.replicaPages !== 1) this.lastLegacyBeat = Date.now();
      if ((message.kind === 'beat' || message.kind === 'hello') && message.body.member?.id === message.from) this.worldMembers.set(message.from, Date.now());
      if (message.kind !== 'world' || !this.liveReplicaFrom(message.from)) await this.onMessage(message, p);
    }
    // Hello carries a replica for this edge only; other packets travel over the bounded mesh.
    if (!['hello', 'historyRequest', 'history', 'historyEnd', 'archiveRequest', 'archiveChunk', 'archiveMissing'].includes(message.kind)) await Promise.allSettled(this.live().filter(peer => peer.id !== p.id).map(peer => this.send(peer, id, bytes, replicaPage)));
  }
  async presence(hints = []) { await this.local('presence', { peers: this.live().length, hints: hints.slice(0, 12) }); }
  async stop() { this.events?.close(); this.clearPendingWorld(); for (const p of [...this.connections.values()]) this.close(p); this.replicas.stop(); await this.local('unregister').catch(() => {}); }
}
