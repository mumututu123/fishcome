import test from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../www/network.js';
import { LIVE_FRAME_UNITS, ReplicaReader, replicaPages } from '../www/replica-stream.js';
import { encodeReplicaRowDelta, replicaRowBase } from '../www/replica-row-delta.js';
import { WorldBroadcast } from '../www/world-broadcast.js';
import { actorId, signer, verifyEnvelope } from '../www/storage.js';

class PeerConnection {
  connectionState = 'new';
  iceGatheringState = 'complete';
  createDataChannel() { return { readyState: 'connecting' }; }
  async createOffer() { return { type: 'offer', sdp: 'test' }; }
  async setLocalDescription(sdp) { this.localDescription = { toJSON: () => sdp }; }
  close() { this.connectionState = 'closed'; }
}
function fixture(t) {
  t.mock.method(globalThis, 'RTCPeerConnection', PeerConnection);
  const network = new Network({ actor: 'a'.repeat(64) }, {}, () => {}, () => {});
  let offers = 0;
  network.local = async route => route === 'probe'
    ? { clients: [{ id: 'remote', peers: 0 }], hints: [] }
    : (offers++, { ok: true });
  t.after(() => { for (const p of [...network.connections.values()]) network.close(p); });
  return { network, offers: () => offers };
}
// Node has no browser WebRTC constructor; install a stub that the test mock restores.
globalThis.RTCPeerConnection = PeerConnection;
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 10000; i++) { if (check()) return; await flush(); } throw new Error('握手未进入预期状态'); }
const url = 'http://127.0.0.1:39241';

test('双方具备字节帧能力才启用紧凑鱼群位置，旧伙伴继续使用行格式', async () => {
  const network = new Network({ actor: 'local' });
  const peer = { pc: { async setRemoteDescription() {} } };
  network.connections.set('link', peer);
  const answer = { type: 'answer', from: 'peer', fromUrl: url, connection: 'link', sdp: { type: 'answer', sdp: 'test' },
    replicaPages: 1, replicaLive: 1, replicaRows: 1, replicaFrames: 1 };
  await network.signal({ ...answer, replicaPoseBytes: 1 });
  assert.equal(peer.replicaPoseBytes, typeof Uint8Array.prototype.toBase64 === 'function' && typeof Uint8Array.fromBase64 === 'function');
  await network.signal({ ...answer });
  assert.equal(peer.replicaFrames, true);
  assert.equal(peer.replicaPoseBytes, false);
});

test('未通过签名校验的消息只记录一次拒收原因', async () => {
  const reasons = [], frames = [];
  const receiver = new Network({ actor: 'receiver' }, {}, () => assert.fail('无效消息进入了世界'), () => {},
    (error, peer) => reasons.push([error.message, peer.node]));
  const sender = new Network({ actor: 'sender' });
  sender.sign = async () => '无效签名';
  const peer = { node: 'sender', packets: new Map() };
  receiver.attach(peer, {});
  await sender.directControl({ queued: 0, sendQueue: Promise.resolve(), dc: {
    readyState: 'open', bufferedAmount: 0, send: frame => frames.push(frame.buffer)
  } }, 'beat', {});
  for (const data of frames) peer.dc.onmessage({ data });
  await until(() => receiver.stats.rejected);
  assert.deepEqual(reasons, [['消息标识或签名无效', 'sender']]);
  assert.equal(receiver.stats.rejected, 1);
});

test('分块签名复用不可变文本并保留发送时的页码', async t => {
  const network = new Network({ actor: 'a'.repeat(64) });
  network.sign = async () => 'signature';
  const page = { id: crypto.randomUUID(), kind: 'world', index: 2, text: '海'.repeat(65536), last: false };
  const copy = globalThis.structuredClone;
  t.mock.method(globalThis, 'structuredClone', value => {
    assert(!Object.hasOwn(value, 'text'), '每一页的不可变文本不应重新分配');
    return copy(value);
  });
  const sending = network.makeEnvelope('replicaPage', page);
  page.index++;
  const { body } = await sending;
  assert.equal(body.index, 2);
  assert.equal(body.text, page.text);
});

test('页内容只编码一次，发送的完整信封与旧格式逐字节相同并通过原验签器', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const identity = { actor: await actorId(pub), pub, secret: await crypto.subtle.exportKey('jwk', keys.privateKey) };
  const network = new Network(identity);
  network.sign = await signer(identity);
  for (const text of ['鱼"\\\n', '海🐟'.repeat(3000)]) {
    const signed = await network.makeEnvelope('replicaPage', { id: crypto.randomUUID(), kind: 'live', index: 0, text, last: true });
    const wire = await network.encode(signed), payload = new Blob([wire.subarray(1)]);
    assert.equal(wire[0], Number(new TextEncoder().encode(JSON.stringify(signed)).length > 2048));
    const bytes = wire[0] ? new Uint8Array(await new Response(payload.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      : wire.subarray(1);
    assert.deepEqual(bytes, new TextEncoder().encode(JSON.stringify(signed)));
    assert(await verifyEnvelope(JSON.parse(new TextDecoder().decode(bytes))));
    assert.equal(await verifyEnvelope({ ...signed, body: { ...signed.body, text: text + 'x' } }), false);
  }
});

test('直达实时帧验签后才合流，缺少基准、超大或未协商的帧仍按原协议补齐', async t => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const identity = { actor: await actorId(pub), pub, secret: await crypto.subtle.exportKey('jwk', keys.privateKey) };
  const received = [], receipts = [], frames = [];
  const sender = new Network(identity), receiver = new Network({ actor: 'follower' }, {}, message => { received.push(message.body); return true; });
  sender.sign = await signer(identity);
  const dest = { queued: 0, sendQueue: Promise.resolve(), dc: { readyState: 'open', bufferedAmount: 0, send: frame => frames.push(frame.buffer) } };
  const via = { node: sender.node, packets: new Map(), replicaSignedFrames: true, replicaFrames: true, replicaRows: true };
  receiver.directControl = async (_, kind, receipt) => { assert.equal(kind, 'replicaReceipt'); receipts.push(receipt); };
  t.after(() => receiver.replicas.stop());
  const world = { tick: 500, fishes: { fish: { id: 'fish', x: 1 } }, chars: {}, travel: {} };
  const base = replicaRowBase(crypto.randomUUID(), world, true);
  for (const notes of ['', '海'.repeat(8192)]) {
    const next = { delta: true, fromTick: 500, world: { ...world, tick: 1000, fishes: { fish: { id: 'fish', x: 2 } }, notes } };
    const body = encodeReplicaRowDelta(next, base, true), id = crypto.randomUUID();
    const wire = await sender.encodeLiveFrame(id, body);
    assert.equal(wire[0], notes ? 3 : 2);
    await sender.send(dest, id, wire, true);
    assert.equal(frames.length, 1);
    const packet = frames.pop(), tampered = packet.slice(0);
    new Uint8Array(tampered)[45] ^= 1;
    const before = received.length;
    await assert.rejects(receiver.receive(via, tampered));
    await assert.rejects(receiver.receive({ ...via, replicaSignedFrames: false }, packet));
    await assert.rejects(receiver.receive({ ...via, node: 'different' }, packet));
    assert.equal(received.length, before);
    receiver.replicas.rowsReceived.delete(via);
    await receiver.receive(via, packet);
    assert.equal(receipts.at(-1).next, -2);
    assert.equal(received.length, before);
    receiver.replicas.rowsReceived.set(via, base);
    const retry = crypto.randomUUID();
    await sender.send(dest, retry, await sender.encodeLiveFrame(retry, body), true);
    await receiver.receive(via, frames.pop());
    assert.deepEqual(received.at(-1), next);
    assert.deepEqual(receipts.at(-1), { id: retry, index: 0, next: 1 });
  }
  assert.equal(await sender.encodeLiveFrame(crypto.randomUUID(), { text: 'a'.repeat(LIVE_FRAME_UNITS) }), undefined);
});

test('旧伙伴接收已截取的世界时复用快照，并在签名前固定握手资料', async () => {
  const network = new Network({ actor: 'a'.repeat(64) });
  network.sign = async () => 'signature';
  network.fitsLegacy = async () => true;
  network.encode = async () => new Uint8Array();
  network.send = async () => {};
  const peer = { replicaPages: false };
  network.replicaPeers = () => [peer];
  const world = { tick: 1 };
  const update = await network.broadcast('world', { world }, { capturedWorld: true });
  assert.equal(update.body.world, world);
  const cards = [{ status: 'ended' }];
  let release;
  network.sign = () => new Promise(resolve => { release = () => resolve('signature'); });
  const pending = network.direct(peer, 'hello', { world, cards }, undefined, { capturedWorld: true });
  await until(() => release);
  cards[0].status = 'corrected';
  release();
  const hello = await pending;
  assert.equal(hello.body.world, world);
  assert.equal(hello.body.cards[0].status, 'ended');
});

test('支持应用回执的伙伴拥有独立发送通道，旧版和网状中继继续收到原分块', async () => {
  const network = new Network({ actor: 'a'.repeat(64) });
  const modern = { node: 'modern', replicaPages: true, replicaLive: true };
  const older = { node: 'older', replicaPages: true };
  const paths = [], relays = [];
  let peers = [modern, older], release;
  network.replicaPeers = () => peers;
  network.replicas.publishLive = (body, recipients) => paths.push([body.world.tick, recipients]);
  network.broadcastReplica = (_, body, options, recipients) => {
    relays.push([body, recipients]);
    if (body.world.tick === 1) return new Promise(resolve => { release = resolve; });
  };
  const body = (tick, fishes) => ({ delta: true, world: { tick, fishes } });
  await network.broadcast('world', body(1, { x: { x: 1 } }));
  await network.broadcast('world', body(2, { y: { x: 2 } }));
  await network.broadcast('world', body(3, { z: { x: 3 } }));
  assert.deepEqual(paths, [[1, [modern]], [2, [modern]], [3, [modern]]]);
  assert.deepEqual(relays, [[body(1, { x: { x: 1 } }), [older]]]);
  release(); await flush();
  assert.deepEqual(relays[1], [body(3, { y: { x: 2 }, z: { x: 3 } }), [older]]);

  peers = [modern]; network.worldMembers.set('indirect', Date.now());
  await network.broadcast('world', body(4, {}));
  await flush();
  assert.deepEqual(paths.at(-1), [4, [modern]]);
  assert.deepEqual(relays.at(-1), [body(4, {}), [modern]]);
});

test('加入者在补发截取和双向握手之间锁住差量，已加入伙伴继续接收', async t => {
  const host = new Network({ actor: 'a'.repeat(64) }, {}, () => {}), channel = new WorldBroadcast();
  const ready = { node: 'ready', replicaPages: true, replicaLive: true, sentHello: true, confirmedReplica: 'ready' };
  const joining = { node: 'joining', replicaPages: true, replicaLive: true };
  host.live = () => [ready, joining];
  t.after(() => host.replicas.stop());
  const original = { tick: 1, roots: {}, breeding: {}, fishes: {} };
  const unroll = (peer, packet) => host.replicas.receive({ from: peer.node, kind: 'replicaReceipt', body: {
    id: packet.id, index: packet.index, next: packet.index + 1
  } }, peer);
  const packets = { ready: [], joining: [] };
  host.directControl = async (peer, kind, packet) => {
    if (kind !== 'replicaPage') return;
    packets[peer.node].push(new ReplicaReader().append(packet.text, packet.last));
    await unroll(peer, packet);
  };
  let releaseHello, releaseCut, releaseCatchup, catchup;
  host.replicas.hello = (_, body, kind) => new Promise(resolve => {
    if (!kind) releaseHello = () => resolve({ world: body.world, version: 'base' });
    else { catchup = body.world; releaseCatchup = resolve; }
  });
  await channel.send(host, original, 100);
  const joined = host.direct(joining, 'hello', { world: structuredClone(original) }, () => {
    const cut = structuredClone(original);
    return new Promise(resolve => { releaseCut = () => resolve(cut); });
  });
  original.fishes.before = { x: 2 }; original.tick++;
  await channel.send(host, original, 200);
  releaseHello(); await until(() => releaseCut);
  original.fishes.after = { x: 3 }; original.tick++;
  await channel.send(host, original, 300);
  assert.deepEqual(packets.joining, []);
  await until(() => packets.ready.length === 3);
  assert.deepEqual(packets.ready.map(p => Object.keys(p.world.fishes)), [[], ['before'], ['after']]);
  releaseCut(); await until(() => releaseCatchup);
  assert.deepEqual(catchup.fishes, { before: { x: 2 } });
  releaseCatchup(); await joined;
  assert.deepEqual(packets.joining, []);

  const [otherHello] = replicaPages({ world: { tick: 1 } });
  await host.replicas.receive({ from: joining.node, kind: 'replicaPage', body: {
    kind: 'hello', id: crypto.randomUUID(), index: 0, ...otherHello
  } }, joining);
  await until(() => packets.joining.length === 1);
  assert.deepEqual(packets.joining[0].world.fishes, { after: { x: 3 } });
});

test('自动连接尚在握手时手动连接复用同一次尝试，等直连成功才返回', async t => {
  const { network, offers } = fixture(t);
  let finished = 0;
  const automatic = network.connectInvite(url).then(() => finished++);
  await until(() => [...network.connections.values()].some(p => p.waiters.size === 1));
  const manual = network.connectInvite(url).then(() => finished++);
  await until(() => [...network.connections.values()].some(p => p.waiters.size === 2));
  assert.equal(finished, 0);
  assert.equal(network.connections.size, 1);
  assert.equal(offers(), 1);
  const p = [...network.connections.values()][0];
  p.dc.readyState = 'open'; p.dc.onopen();
  await Promise.all([automatic, manual]);
  assert.equal(finished, 2);
  await network.connectInvite(url);
  assert.equal(offers(), 1, '已连接的入口不应误报没有伙伴或重复握手');
});

test('信令发送成功但直连超时不会当作成功，也不会误报没有伙伴', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { network } = fixture(t);
  const attempt = network.connectInvite(url);
  const rejected = assert.rejects(attempt, /入口可访问，但浏览器直连未建立/);
  await until(() => [...network.connections.values()].some(p => p.waiters.size === 1)); t.mock.timers.tick(30000);
  await rejected;
  assert.equal(network.connections.size, 0);
});

test('对方拒绝握手时所有重复连接都收到拒绝原因', async t => {
  const { network } = fixture(t);
  const first = network.connectInvite(url);
  const rejectedFirst = assert.rejects(first, /对方暂时无法接受连接/);
  await until(() => [...network.connections.values()].some(p => p.waiters.size === 1));
  const second = network.connectInvite(url);
  const rejectedSecond = assert.rejects(second, /对方暂时无法接受连接/);
  await until(() => [...network.connections.values()].some(p => p.waiters.size === 2));
  const p = [...network.connections.values()][0];
  await network.signal({ type: 'reject', from: 'remote', fromUrl: url, connection: p.id });
  await Promise.all([rejectedFirst, rejectedSecond]);
});
