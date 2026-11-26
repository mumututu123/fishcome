import test from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../www/network.js';

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
