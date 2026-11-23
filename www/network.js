import { signer, verifyEnvelope } from './storage.js';
const CHUNK = 16000, MAX_PEERS = 8, MAX_RAW = 32 * 1024 * 1024, encoder = new TextEncoder(), decoder = new TextDecoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function inflateBounded(bytes) { const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), chunks = []; let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RAW) { await reader.cancel(); throw new Error('解压数据过大'); } chunks.push(value); } const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
export class Network {
  constructor(identity, meta, onMessage, onChange) { this.identity = identity; this.meta = meta; this.node = identity.actor.slice(0, 16) + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 19); this.onMessage = onMessage; this.onChange = onChange; this.connections = new Map(); this.seen = new Map(); this.pending = new Map(); this.stats = { sent: 0, received: 0, rejected: 0 }; }
  async local(route, payload = {}) { const response = await fetch('/local/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: this.meta.token, node: this.node, ...payload }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '本地配对通道不可用'); return result; }
  async start(nick) { this.sign = await signer(this.identity); await this.local('register', { nick }); this.events = new EventSource(`/local/events?node=${this.node}&token=${encodeURIComponent(this.meta.token)}`); this.events.onmessage = e => { try { this.signal(JSON.parse(e.data)).catch(error => this.onChange(error.message)); } catch { } }; }
  live() { return [...this.connections.values()].filter(p => p.dc?.readyState === 'open'); }
  has(node) { return [...this.connections.values()].some(p => p.node === node && !['closed', 'failed'].includes(p.pc.connectionState)); }
  async connect(url, requestedNode = '', visited = new Set()) {
    if (this.connections.size >= MAX_PEERS) return;
    if (visited.has(url + requestedNode)) return; visited.add(url + requestedNode);
    const status = await this.local('probe', { url });
    const possible = (status.clients || []).filter(c => c.id !== this.node && !this.has(c.id) && c.peers < MAX_PEERS && (!requestedNode || c.id === requestedNode));
    const target = possible.sort((a, b) => a.peers - b.peers)[0];
    if (!target) { for (const hint of (status.hints || []).slice(0, 8)) { if (hint.id !== this.node && !this.has(hint.id)) { try { await this.connect(hint.url, hint.id, visited); if (this.live().length) return; } catch { } } } throw new Error('入口可访问，但暂时没有正在玩的伙伴或空位'); }
    const id = crypto.randomUUID(), p = this.make(id, url, target.id); this.attach(p, p.pc.createDataChannel('tide'));
    try { await p.pc.setLocalDescription(await p.pc.createOffer()); await this.ice(p.pc); const result = await this.local('relay', { url, signal: { type: 'offer', from: this.node, to: target.id, connection: id, sdp: p.pc.localDescription.toJSON() } }); if (!result.ok) throw new Error(result.error || '配对入口繁忙'); } catch (e) { this.close(p); throw e; }
  }
  make(id, url, node) {
    const p = { id, url, node, pc: new RTCPeerConnection({ iceServers: [] }), packets: new Map(), sendQueue: Promise.resolve(), queued: 0, created: Date.now() };
    this.connections.set(id, p); p.pc.ondatachannel = event => this.attach(p, event.channel);
    p.pc.onconnectionstatechange = () => { if (['closed', 'failed'].includes(p.pc.connectionState)) this.close(p); };
    setTimeout(() => { if (p.dc?.readyState !== 'open') this.close(p); }, 30000); return p;
  }
  async ice(pc) { if (pc.iceGatheringState === 'complete') return; await new Promise(resolve => { const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } }; pc.addEventListener('icegatheringstatechange', done); setTimeout(() => { pc.removeEventListener('icegatheringstatechange', done); resolve(); }, 5000); }); }
  async signal(s) {
    if (s.from === this.node) return;
    if (s.type === 'offer') {
      if (this.connections.size >= MAX_PEERS || this.has(s.from)) { await this.local('relay', { url: s.fromUrl, signal: { type: 'reject', from: this.node, to: s.from, connection: s.connection } }); return; }
      const p = this.make(s.connection, s.fromUrl, s.from); try { await p.pc.setRemoteDescription(s.sdp); await p.pc.setLocalDescription(await p.pc.createAnswer()); await this.ice(p.pc); await this.local('relay', { url: p.url, signal: { type: 'answer', from: this.node, to: s.from, connection: s.connection, sdp: p.pc.localDescription.toJSON() } }); } catch (e) { this.close(p); throw e; }
    } else { const p = this.connections.get(s.connection); if (!p) return; if (s.type === 'reject') { this.close(p); return; } p.node = s.from; p.url = s.fromUrl; await p.pc.setRemoteDescription(s.sdp); }
  }
  attach(p, dc) {
    p.dc = dc; dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 65536;
    dc.onopen = () => { const duplicates = this.live().filter(x => x.node === p.node).sort((a, b) => a.id.localeCompare(b.id)); for (const extra of duplicates.slice(1)) this.close(extra); this.onChange(); };
    dc.onclose = () => this.close(p);
    dc.onmessage = e => { this.receive(p, e.data).catch(() => { this.stats.rejected++; }); };
  }
  close(p) { if (!this.connections.has(p.id)) return; this.connections.delete(p.id); p.pc.onconnectionstatechange = null; if (p.dc) p.dc.onclose = null; p.pc.close(); this.onChange(); }
  async makeEnvelope(kind, body) { const message = { id: crypto.randomUUID(), kind, from: this.node, actor: this.identity.actor, key: this.identity.pub, body }; return { ...message, signature: await this.sign(message) }; }
  async encode(message) { const raw = encoder.encode(JSON.stringify(message)); if (raw.byteLength > 32 * 1024 * 1024) throw new Error('世界快照过大'); if (raw.byteLength > 2048 && typeof CompressionStream !== 'undefined') { const bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); const result = new Uint8Array(bytes.length + 1); result[0] = 1; result.set(bytes, 1); return result; } const result = new Uint8Array(raw.length + 1); result.set(raw, 1); return result; }
  async broadcast(kind, body) { const message = await this.makeEnvelope(kind, body); this.seen.set(message.id, Date.now()); const bytes = await this.encode(message); await Promise.allSettled(this.live().map(p => this.send(p, message.id, bytes))); return message; }
  async direct(p, kind, body) { const message = await this.makeEnvelope(kind, body); this.seen.set(message.id, Date.now()); await this.send(p, message.id, await this.encode(message)); return message; }
  send(p, id, bytes) {
    if (!p.dc || p.dc.readyState !== 'open' || p.queued > 8) return Promise.resolve(); p.queued++;
    const operation = p.sendQueue.catch(() => {}).then(async () => { const total = Math.ceil(bytes.length / CHUNK); for (let index = 0; index < total; index++) { let waited = 0; while (p.dc.bufferedAmount > 262144 && p.dc.readyState === 'open') { await sleep(20); if (++waited > 500) throw new Error('连接发送队列超时'); } if (p.dc.readyState !== 'open') break; const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK), frame = new Uint8Array(44 + part.length); frame.set(encoder.encode(id), 0); const view = new DataView(frame.buffer); view.setUint32(36, total); view.setUint32(40, index); frame.set(part, 44); p.dc.send(frame); this.stats.sent += frame.length; } }).finally(() => { p.queued--; }); p.sendQueue = operation; return operation;
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
    await this.onMessage(message, p);
    // Hello carries a replica for this edge only; other packets travel over the bounded mesh.
    if (!['hello', 'historyRequest', 'history', 'historyEnd'].includes(message.kind)) await Promise.allSettled(this.live().filter(peer => peer.id !== p.id).map(peer => this.send(peer, id, bytes)));
  }
  async presence(hints = []) { await this.local('presence', { peers: this.live().length, hints: hints.slice(0, 12) }); }
  async stop() { this.events?.close(); for (const p of [...this.connections.values()]) this.close(p); await this.local('unregister').catch(() => {}); }
}
