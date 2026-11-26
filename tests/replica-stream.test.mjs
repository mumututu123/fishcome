import assert from 'node:assert/strict';
import test from 'node:test';
import { changesSince, fitsLegacyEnvelope, PAGE_UNITS, replicaPages, ReplicaReader, ReplicaTransfers } from '../www/replica-stream.js';
import { mergeBreeding } from '../www/breeding.js';
import { WorldBroadcast } from '../www/world-broadcast.js';
import { World } from './empty-world.mjs';

test('分块保留标量、空表、跨块的字符、长记录及签名内的键顺序', async () => {
  const body = { delta: false, world: {
    tick: 12, roots: {}, notices: [], chats: {
      id: { nick: '鱼', text: '🐟"\n'.repeat(PAGE_UNITS), proof: { z: 1, a: 2 } }
    }, participants: { '伙伴': '来' }
  } };
  const reader = new ReplicaReader();
  const pages = [...replicaPages(body)];
  assert(pages.length > 2);
  for (const page of pages.slice(0, -1)) {
    assert.equal(page.text.length, PAGE_UNITS);
    assert.equal(reader.append(page.text, page.last), null);
  }
  assert.deepEqual(reader.append(pages.at(-1).text, true), body);
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert(await fitsLegacyEnvelope(body, bytes));
  assert.equal(await fitsLegacyEnvelope(body, bytes - 1), false);
});

test('确认版本后只补齐新增、同毫秒修改和出生的记录，过期基线不能合流', async t => {
  const old = { roots: { r: 1 }, tick: 1, fishes: { f: { x: 3 }, other: { x: 1 } }, participants: { a: '甲' }, breeding: {} };
  const current = { roots: { r: 1 }, tick: 2, fishes: { f: { x: 4 }, other: { x: 1 } }, participants: { a: '甲', b: '乙' }, breeding: { n: { at: 2 } } };
  const delta = await changesSince(old, current);
  assert.deepEqual(delta, { ...current, fishes: { f: { x: 4 } }, participants: { b: '乙' } });
  let merged = false;
  const receiver = new ReplicaTransfers({ onMessage: () => { merged = true; }, directControl() {} });
  t.after(() => receiver.stop());
  const [page] = replicaPages({ base: 'stale', world: delta });
  const message = { kind: 'replicaPage', from: 's', actor: 'a', body: { kind: 'catchup', id: crypto.randomUUID(), index: 0, ...page } };
  await assert.rejects(receiver.receive(message, { node: 's', confirmedReplica: 'current' }), /未确认/);
  assert.equal(merged, false);
});

test('广播跨路径乱序时只交付一次完整版本，拒绝缺失数据和跨发送者拼接', async t => {
  const received = [];
  const streams = new ReplicaTransfers({ onMessage: msg => received.push(msg) });
  t.after(() => streams.stop());
  const body = { world: { life: { story: 'a'.repeat(PAGE_UNITS * 2) } } };
  const id = crypto.randomUUID();
  const messages = [...replicaPages(body)].map((p, index) => ({
    kind: 'replicaPage', actor: 'one', from: 'one-1', body: { kind: 'merge', id, index, ...p }
  }));
  await streams.receive(messages[1], {});
  await streams.receive(messages[2], {});
  assert.deepEqual(received, []);
  await assert.rejects(streams.receive({ ...messages[0], actor: 'two' }, {}), /版本不一致/);
  await streams.receive(messages[0], {});
  await streams.receive(messages[0], {});
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].body, body);
  assert.throws(() => new ReplicaReader().append('["header",{}]\n["table","__proto__"]\n', true));
});

test('握手中断后在新连接继续上一已确认块，接收方重启后从头恢复', async t => {
  for (const restart of [false, true]) {
    const applied = [], indices = [];
    const source = { node: 'source' }, target = { node: 'target' };
    const inPeer = { node: source.node }, outPeer = () => ({ dc: { readyState: 'open' }, node: target.node });
    let peer = outPeer(), interrupt = true;
    let receiver;
    const sender = new ReplicaTransfers({
      async directControl(p, kind, packet) {
        indices.push(packet.index);
        if (packet.index === 2 && interrupt) throw new Error('断开');
        return receiver.receive({ actor: 's', from: source.node, kind, body: packet }, inPeer);
      }
    });
    const fresh = () => new ReplicaTransfers({
      onMessage: msg => applied.push(msg.body),
      directControl: (_, kind, packet) => sender.receive({ from: target.node, kind, body: packet }, peer)
    });
    receiver = fresh();
    t.after(() => { sender.stop(); receiver.stop(); });
    const body = { world: { rows: { a: 'a'.repeat(4 * PAGE_UNITS) } } };
    await assert.rejects(sender.hello(peer, body), /断开/);
    assert.deepEqual(applied, []);
    if (restart) { receiver.stop(); receiver = fresh(); }
    interrupt = false; peer = outPeer();
    await sender.hello(peer, { world: {} });
    assert.deepEqual(applied, [body]);
    assert.deepEqual(indices.slice(0, restart ? 6 : 5), restart ? [0, 1, 2, 2, 0, 1] : [0, 1, 2, 2, 3]);
  }
});

test('最后的确认丢失后重发末页，不重复合流', async t => {
  let applied = 0, drop = true, peer = { node: 'b', dc: { readyState: 'open' } };
  const sender = new ReplicaTransfers({ async directControl(_, kind, packet) {
    await receiver.receive({ from: 'a', actor: 'a', kind, body: packet }, { node: 'a' });
    if (drop) throw new Error('确认丢失');
  } });
  const receiver = new ReplicaTransfers({
    onMessage: () => { applied++; },
    directControl: (_, kind, body) => drop ? undefined : sender.receive({ from: 'b', kind, body }, peer)
  });
  t.after(() => { sender.stop(); receiver.stop(); });
  const body = { world: { tick: 1 } };
  await assert.rejects(sender.hello(peer, body), /确认丢失/);
  drop = false; peer = { node: 'b', dc: { readyState: 'open' } };
  const result = await sender.hello(peer, { world: { tick: 2 } });
  assert.equal(applied, 1);
  assert.deepEqual(result.world, body.world);
});

test('首连补发较新接触时钟时同时保留未变接触并清除已结束接触', async () => {
  const world = new World(100);
  world.data.contacts = { ongoing: { since: 25 }, ended: { since: 60 } };
  const before = world.serialize(), after = world.serialize();
  after.contactAt++;
  after.contacts = { ongoing: after.contacts.ongoing, added: { since: 100 } };
  const delta = await changesSince(before, after);
  mergeBreeding(world, delta);
  assert.deepEqual(world.data.contacts, after.contacts);
  assert.equal(world.data.contactAt, after.contactAt);
});

test('日常广播只读取变化行，签名时的新变化进入下一包，未知前台编辑只重建一次', async () => {
  const world = new World(100), data = world.data;
  data.fishes = { fish: { x: 1 }, resting: { x: 2 } };
  data.chars = { cell: { ch: '鱼' } };
  data.travel = { fish: { days: { today: 1 } } };
  let inform, allowScan = true, release;
  const channel = new WorldBroadcast(callback => { inform = callback; });
  const network = { live: () => [1], broadcast: (_, body) => body };
  await channel.send(network, data, 100);
  for (const field of ['fishes', 'chars', 'travel', 'scenes', 'ops', 'participants', 'chats', 'chatSources']) {
    data[field] = new Proxy(data[field], { ownKeys(table) {
      assert(allowScan, '已知变更时枚举了 ' + field);
      return Reflect.ownKeys(table);
    } });
  }
  allowScan = false;
  const mark = (field, id) => inform(world, { values: {}, tables: { [field]: { set: [[id, data[field][id]]], remove: [] } } });
  const idle = await channel.send(network, data, 1100);
  for (const field of ['fishes', 'chars', 'travel']) assert.deepEqual(idle.world[field], {});
  data.fishes.fish.x = 3;
  data.travel.fish.days.today = 2;
  mark('fishes', 'fish'); mark('fishes', 'resting'); mark('travel', 'fish');
  const held = channel.send({ ...network, broadcast: (_, body) => new Promise(resolve => { release = () => resolve(body); }) }, data, 2100);
  data.fishes.fish.x = 4; mark('fishes', 'fish');
  release();
  const first = (await held).world;
  assert.deepEqual(first.fishes, { fish: { x: 3 } });
  assert.deepEqual(first.travel, { fish: { days: { today: 2 } } });
  assert.deepEqual((await channel.send(network, data, 3100)).world.fishes, { fish: { x: 4 } });
  inform(world, null); allowScan = true;
  data.chars.cell.ch = '游';
  const rebuilt = (await channel.send(network, data, 4100)).world;
  assert.deepEqual(rebuilt.chars, { cell: { ch: '游' } }); assert.deepEqual(rebuilt.fishes, {});
  allowScan = false;
  assert.deepEqual((await channel.send(network, data, 5100)).world.chars, {});
});
