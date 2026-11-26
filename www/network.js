import { signer, verifyEnvelope } from './storage.js';
import { normalizeInvite, decodeInvite } from './invite.js';
import { changesSince, fitsLegacyEnvelope, ReplicaTransfers } from './replica-stream.js';
const CHUNK = 16000, MAX_PEERS = 8, MAX_RAW = 32 * 1024 * 1024, encoder = new TextEncoder(), decoder = new TextDecoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DIRECT_ERROR = '入口可访问，但浏览器直连未建立，请检查双方网络及防火墙后重试';
export async function lanDescription(description, fromUrl) {
  const ip = new URL(await decodeInvite(fromUrl)).hostname;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || typeof description?.sdp !== 'string') return description;
  // The launcher supplies its IPv4 route to this peer; ICE supplies the UDP port.
  const sdp = description.sdp.replace(/^(a=candidate:\S+[ \t]+\d+[ \t]+udp[ \t]+\d+[ \t]+)\S+\.local([ \t]+\d+[ \t]+typ[ \t]+host(?=[ \t\r\n]|$)[^\r\n]*)/gim, (_, prefix, suffix) => prefix + ip + suffix);
  return sdp === description.sdp ? description : { ...description, sdp };
}
async function inflateBounded(bytes) { const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), chunks = []; let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RAW) { await reader.cancel(); throw new Error('解压数据过大'); } chunks.push(value); } const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
export class Network {
  constructor(identity, meta, onMessage, onChange) { this.identity = identity; this.meta = meta; this.node = identity.actor.slice(0, 16) + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 19); this.onMessage = onMessage; this.onChange = onChange; this.replicas = new ReplicaTransfers(this); this.lastLegacyBeat = 0; this.connections = new Map(); this.seen = new Map(); this.pending = new Map(); this.stats = { sent: 0, received: 0, rejected: 0 }; }
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
    try { await p.pc.setLocalDescription(await p.pc.createOffer()); await this.ice(p.pc); const result = await this.local('relay', { url, signal: { type: 'offer', replicaPages: 1, from: this.node, to: target.id, connection: id, sdp: p.pc.localDescription.toJSON() } }); if (!result.ok) throw new Error(result.error || '配对入口繁忙'); await this.waitForConnection(p); } catch (e) { this.close(p, e); throw e; }
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
      const p = this.make(s.connection, s.fromUrl, s.from); p.replicaPages = s.replicaPages === 1; try { await p.pc.setRemoteDescription(await lanDescription(s.sdp, s.fromUrl)); await p.pc.setLocalDescription(await p.pc.createAnswer()); await this.ice(p.pc); await this.local('relay', { url: p.url, signal: { type: 'answer', replicaPages: 1, from: this.node, to: s.from, connection: s.connection, sdp: p.pc.localDescription.toJSON() } }); } catch (e) { this.close(p); throw e; }
    } else { const p = this.connections.get(s.connection); if (!p) return; if (s.type === 'reject') { this.close(p, new Error('对方暂时无法接受连接，请稍后重试')); return; } p.node = s.from; p.url = s.fromUrl; p.replicaPages = s.replicaPages === 1; await p.pc.setRemoteDescription(await lanDescription(s.sdp, s.fromUrl)); }
  }
  attach(p, dc) {
    p.dc = dc; dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 65536;
    dc.onopen = () => { clearTimeout(p.timeout); for (const waiter of p.waiters) waiter.resolve(); p.waiters.clear(); const duplicates = this.live().filter(x => x.node === p.node).sort((a, b) => a.id.localeCompare(b.id)); for (const extra of duplicates.slice(1)) this.close(extra); this.onChange(); };
    dc.onclose = () => this.close(p);
    dc.onmessage = e => { this.receive(p, e.data).catch(() => { this.stats.rejected++; }); };
  }
  close(p, error = new Error(DIRECT_ERROR)) { if (!this.connections.has(p.id)) return; this.connections.delete(p.id); this.replicas.close(p, error); clearTimeout(p.timeout); p.error = error; for (const waiter of p.waiters) waiter.reject(error); p.waiters.clear(); p.pc.onconnectionstatechange = null; if (p.dc) p.dc.onclose = null; p.pc.close(); this.onChange(); }
  async makeEnvelope(kind, body) { const message = { id: crypto.randomUUID(), kind, from: this.node, actor: this.identity.actor, key: this.identity.pub, body }; return { ...message, signature: await this.sign(message) }; }
  async encode(message) { const raw = encoder.encode(JSON.stringify(message)); if (raw.byteLength > 32 * 1024 * 1024) throw new Error('世界快照过大'); if (raw.byteLength > 2048 && typeof CompressionStream !== 'undefined') { const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); const result = new Uint8Array(bytes.length + 1); result[0] = 1; result.set(bytes, 1); return result; } const result = new Uint8Array(raw.length + 1); result.set(raw, 1); return result; }
  replicaPeers() { return this.live().filter(p => !p.replicaPages || p.sentHello && p.confirmedReplica); }
  fitsLegacy(kind, body) {
    // Web Crypto P-256 signatures are 64 bytes, or 88 base64 characters.
    const header = { id: '0'.repeat(36), kind, from: this.node, actor: this.identity.actor, key: this.identity.pub, body: null, signature: '0'.repeat(88) };
    return fitsLegacyEnvelope(body, MAX_RAW - encoder.encode(JSON.stringify(header)).length + 4);
  }
  async broadcastEnvelope(message, peers = this.live()) { this.seen.set(message.id, Date.now()); const bytes = await this.encode(message); await Promise.allSettled(peers.map(p => this.send(p, message.id, bytes))); return message; }
  async broadcast(kind, body) {
    if ((kind === 'merge' || kind === 'world') && body.world) {
      const peers = this.replicaPeers();
      if (!peers.length) return;
      const legacy = peers.some(p => !p.replicaPages) || Date.now() - this.lastLegacyBeat < 120000;
      if (!legacy || !await this.fitsLegacy(kind, body)) {
        if (peers.every(p => !p.replicaPages)) throw new Error('世界太大，联机伙伴需更新才能分块同步');
        return this.replicas.broadcast(kind, body, peers);
      }
      return this.broadcastEnvelope(await this.makeEnvelope(kind, body), peers);
    }
    return this.broadcastEnvelope(await this.makeEnvelope(kind, body));
  }
  async direct(p, kind, body, captureCurrent) {
    if (kind === 'hello' && body.world) {
      if (p.replicaPages) {
        const base = await this.replicas.hello(p, body);
        if (captureCurrent) {
          const current = await captureCurrent();
          // The peer has the baseline. Changes after this cut can travel in the
          // live stream while we reconcile what changed during its first join.
          p.sentHello = true;
          await this.replicas.hello(p, { base: base.version, world: await changesSince(base.world, current) }, 'catchup');
        }
        p.sentHello = true;
        return;
      }
      if (!await this.fitsLegacy(kind, body)) throw new Error('世界太大，联机伙伴需更新才能分块同步');
    }
    return this.directControl(p, kind, body);
  }
  async directControl(p, kind, body) { const message = await this.makeEnvelope(kind, body); this.seen.set(message.id, Date.now()); await this.send(p, message.id, await this.encode(message), true); return message; }
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
    let raw = bytes.slice(1); if (bytes[0] === 1) raw = await inflateBounded(raw); if (raw.length > MAX_RAW) return;
    const message = JSON.parse(decoder.decode(raw)); if (message.id !== id || !await verifyEnvelope(message)) { this.stats.rejected++; return; }
    this.seen.set(id, Date.now()); if (this.seen.size > 20000) { for (const [k, at] of this.seen) if (Date.now() - at > 120000) this.seen.delete(k); }
    const replicaPage = message.kind === 'replicaPage';
    if (replicaPage || message.kind === 'replicaReceipt') {
      if (!await this.replicas.receive(message, p)) return;
    } else {
      if ((message.kind === 'beat' || message.kind === 'hello') && message.body.member?.replicaPages !== 1) this.lastLegacyBeat = Date.now();
      await this.onMessage(message, p);
    }
    // Hello carries a replica for this edge only; other packets travel over the bounded mesh.
    if (!['hello', 'historyRequest', 'history', 'historyEnd', 'archiveRequest', 'archiveChunk', 'archiveMissing'].includes(message.kind)) await Promise.allSettled(this.live().filter(peer => peer.id !== p.id).map(peer => this.send(peer, id, bytes, replicaPage)));
  }
  async presence(hints = []) { await this.local('presence', { peers: this.live().length, hints: hints.slice(0, 12) }); }
  async stop() { this.events?.close(); for (const p of [...this.connections.values()]) this.close(p); this.replicas.stop(); await this.local('unregister').catch(() => {}); }
}
