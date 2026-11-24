import test from 'node:test';
import assert from 'node:assert/strict';
import { lanDescription, Network } from '../www/network.js';
import { encodeInvite } from '../www/invite.js';

test('只替换mDNS UDP host候选地址，保留端口、扩展字段和全部其他SDP', async () => {
  const lines = [
    'v=0',
    'a=candidate:123 1 udp 2122260223 abcd.local 64228 typ host generation 0 network-cost 999',
    'a=candidate:456\t1\tUDP\t2122260223\tefgh.LOCAL\t50001\ttyp\thost',
    'a=candidate:789 1 udp 2122260223 192.168.10.20 50002 typ host',
    'a=candidate:012 1 tcp 2122260223 abcd.local 9 typ host tcptype active',
    'a=candidate:345 1 udp 2122260223 abcd.local 50003 typ srflx raddr 10.0.0.1 rport 50000',
    'a=candidate:678 1 udp 2122260223 abcd.local 50004 typ relay',
    'a=candidate:901 1 udp 2122260223 abcd.local.example 50005 typ host',
    'a=candidate:234 1 udp 2122260223 abcd.local 50006 typ hostname',
    'a=note:abcd.local 64228',
    'a=end-of-candidates'
  ];
  for (const newline of ['\r\n', '\n', '\r']) {
    const original = { type: 'offer', sdp: lines.join(newline) + newline };
    const result = await lanDescription(original, await encodeInvite('http://10.0.0.42:39241', 'a'.repeat(64)));
    const expected = [...lines];
    expected[1] = expected[1].replace('abcd.local', '10.0.0.42');
    expected[2] = expected[2].replace('efgh.LOCAL', '10.0.0.42');
    assert.equal(result.sdp, expected.join(newline) + newline);
    assert.equal(result.type, 'offer');
    assert.equal(original.sdp, lines.join(newline) + newline, '收到的原始描述不应被修改');
  }
});

test('入口是域名或IPv6时逐字沿用原SDP，没有mDNS候选也保持原样', async () => {
  const original = { type: 'answer', sdp: 'a=candidate:1 1 udp 1 abcd.local 64228 typ host' };
  for (const endpoint of ['http://colleague.local:39241', 'http://colleague.example:39241', 'http://[::1]:39241']) {
    assert.equal(await lanDescription(original, await encodeInvite(endpoint)), original);
  }
  const numeric = { type: 'answer', sdp: 'a=candidate:1 1 udp 1 10.0.0.3 64228 typ host\r\n' };
  assert.equal(await lanDescription(numeric, await encodeInvite('http://10.0.0.42:39241')), numeric);
});

test('offer与answer接收分支都用发信方路由IPv4转换后再设置远端描述', async () => {
  for (const type of ['offer', 'answer']) {
    const network = new Network({ actor: 'a'.repeat(64) }, {}, () => {}, () => {});
    let received;
    const p = { id: 'connection', node: 'remote', pc: {
      async setRemoteDescription(description) { received = description; },
      async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; },
      async setLocalDescription(description) { this.localDescription = { toJSON: () => description }; }
    } };
    network.make = (id, url, node) => { p.url = url; network.connections.set(id, p); return p; };
    network.ice = async () => {};
    network.local = async () => ({ ok: true });
    if (type === 'answer') network.connections.set(p.id, p);
    const original = { type, sdp: 'a=candidate:123 1 udp 2122260223 abcd.local 64228 typ host\r\n' };
    await network.signal({ type, from: 'remote', connection: p.id, fromUrl: await encodeInvite('http://192.168.10.18:39241'), sdp: original });
    assert.deepEqual(received, { type, sdp: 'a=candidate:123 1 udp 2122260223 192.168.10.18 64228 typ host\r\n' });
  }
});
