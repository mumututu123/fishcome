import assert from 'node:assert/strict';
import test from 'node:test';
import { changesSince, fitsLegacyEnvelope, PAGE_UNITS, replicaPages, ReplicaReader, ReplicaTransfers } from '../www/replica-stream.js';
import { decodeReplicaRowDelta, encodeReplicaRowDelta, replicaRowBase } from '../www/replica-row-delta.js';
import { mergeBreeding } from '../www/breeding.js';
import { ArchiveStore } from '../www/archive.js';
import { applyInputRows, simulationApplied } from '../www/simulation-changes.js';
import { ReplicaInventory, ReplicaRecovery, ReplicaSwims, WorldBroadcast } from '../www/world-broadcast.js';

test('心跳按已知记录并集修复，允许在途记录先到达，搬入归档不会触发全海重传', () => {
  const records = () => ({ roots: { sea: 1 }, ops: { fish: 1, feed: 1 }, chats: {}, chatSources: {} });
  const archives = () => ({ ids: { ops: new Map(), chats: new Map(), chatSources: new Map() } });
  const sender = new ReplicaInventory(), receiver = new ReplicaInventory();
  const left = records(), right = records(), a = archives(), b = archives();
  sender.heartbeat(left, a);
  b.ids.ops.set('feed', 'pack');
  delete right.ops.feed;
  a.ids.ops.set('fish', 'pack');
  left.ops.create = 1;
  const inFlight = sender.heartbeat(left, a);
  assert.equal(inFlight.opCount, 3);
  assert.equal(inFlight.settledRecords.ops, 2);
  assert.equal(receiver.missing(inFlight, right, b), false);
  const settled = sender.heartbeat(left, a);
  assert.equal(receiver.missing(settled, right, b), true);
  b.ids.ops.set('create', 'new');
  assert.equal(receiver.missing(settled, right, b), false);
  assert.equal(receiver.missing({ opCount: 2 }, right, b), true);
  assert.equal(receiver.missing({}, right, b), false);
  assert.equal(sender.heartbeat(records(), a).settledRecords.ops, 0);
});
import { CONFIG, World } from './empty-world.mjs';

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

test('同毫秒的鱼位置修正和先前日期的运动修正在广播和补发中保留', async () => {
  const now = Date.UTC(2026, 0, 20), today = '2026-01-20', yesterday = '2026-01-19';
  const world = new World(now), data = world.data, channel = new WorldBroadcast();
  const network = { live: () => [1], broadcast: (_, body) => body };
  data.fishes = { sameClock: { x: 1, posAt: now }, newClock: { x: 2, posAt: now }, unchanged: { x: 3, posAt: now } };
  data.travel = {
    earlierDay: { since: now - 86400000, days: { [yesterday]: 1, [today]: 2 } },
    currentDay: { since: now, days: { [today]: 3 } },
    unchanged: { since: now, days: { [today]: 4 } }
  };
  const before = (await channel.send(network, data, now)).world;
  data.fishes.sameClock.x = 10;
  data.fishes.newClock.posAt++;
  data.travel.earlierDay.days[yesterday]++;
  data.travel.currentDay.days[today]++;
  const broadcast = (await channel.send(network, data, now + 1000)).world;
  const catchup = await changesSince(before, data);
  for (const packet of [broadcast, catchup]) {
    assert.deepEqual(packet.fishes, { sameClock: { x: 10, posAt: now }, newClock: { x: 2, posAt: now + 1 } });
    assert.deepEqual(packet.travel, {
      earlierDay: { since: now - 86400000, days: { [yesterday]: 2, [today]: 2 } },
      currentDay: { since: now, days: { [today]: 4 } }
    });
  }
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

test('合流按鱼元归属清理空造景，同位置的两份造景各自保留', () => {
  const at = Date.now() - 1000;
  const world = new World(at), other = new World(at, world.id);
  const place = (target, x) => {
    const id = crypto.randomUUID();
    const cells = [0, 1].map(x => ({ x, y: 0, ch: '景', color: '#88aacc' }));
    assert(target.apply({ id, actor: id, kind: 'scene', t: at, x, y: 20, cost: cells.length, cells }).ok);
    return id;
  };
  const kept = place(world, 40), empty = place(world, 50), samePosition = place(other, 40);
  for (const cell of world.sceneCells(empty)) cell.kind = 'burn';
  world.merge(other.serialize());
  assert.deepEqual(Object.keys(world.data.scenes).sort(), [kept, samePosition].sort());
  assert.deepEqual(world.sceneCells(kept).map(cell => cell.id), [kept + ':0', kept + ':1']);
  assert.deepEqual(world.sceneCells(samePosition).map(cell => cell.id), [samePosition + ':0', samePosition + ':1']);
});

test('连续合流跳过未变的鱼元归属，仍与完整合流同样处理进食、掉落、归档和前台编辑', () => {
  const at = Date.now() - 10000, full = new World(at), live = new World(at, full.id);
  const fish = crypto.randomUUID(), cell = { x: 0, y: 0, ch: 'o', color: '#88aacc' };
  for (const world of [full, live]) {
    assert(world.apply({ id: fish, actor: fish, kind: 'fish', t: at, x: 40, y: 20, cost: 2, gender: 'male',
      cells: [cell, { ...cell, x: 1, ch: '鱼' }] }).ok);
    world.attachArchives(new ArchiveStore());
  }
  const loose = { ...cell, id: 'loose', kind: 'food', entity: '', born: at, created: at, path: [] };
  let tick = at, scans = 0;
  const charValues = live.charValues.bind(live);
  live.charValues = (...kinds) => { if (!kinds.length) scans++; return charValues(...kinds); };
  const merge = (chars = {}, fishes = {}, scenes = {}) => {
    const delta = { protocol: 1, roots: { ...full.data.roots }, tick: tick += 500, ops: {}, scenes, chars, fishes };
    const previous = scans;
    full.merge(delta);
    live.merge(delta, {}, 'replica');
    assert.deepEqual(live.serialize(), full.serialize());
    return scans - previous;
  };
  assert.equal(merge({ loose }), 1);
  assert.equal(merge({ loose: { ...loose, y: 1, moveAt: tick + 500 } }), 0);
  const scene = { id: 'deposit', x: 20, y: 10, posAt: tick };
  const grain = { ...loose, id: 'one', kind: 'scene', entity: scene.id, path: [{ id: 'settle', reason: 'expire', t: tick }] };
  const burn = id => ({ ...grain, id, kind: 'burn', entity: '', path: [...grain.path, { id: 'remove', reason: 'delete', t: tick }] });
  assert.equal(merge({ one: grain, two: { ...grain, id: 'two' } }, {}, { deposit: scene }), 0);
  assert.equal(merge({ one: burn('one') }), 0);
  assert(live.data.scenes.deposit);
  assert.equal(merge({ two: burn('two') }), 0);
  assert.equal(live.data.scenes.deposit, undefined);
  const meal = { ...loose, kind: 'fish', entity: fish, x: 2, path: [{ id: 'eat', reason: 'eat', target: fish, t: tick }] };
  merge({ loose: meal });
  assert.equal(live.data.fishes[fish].lastFed, meal.path[0].t);
  const archivedMealAt = tick + 100;
  for (const world of [full, live]) {
    world.archives.summary.lastMeals.set(fish, archivedMealAt);
    world.archives.revision = 1;
  }
  merge();
  assert.equal(live.data.fishes[fish].lastFed, archivedMealAt);
  for (const world of [full, live]) {
    applyInputRows(world, [['chars', 'loose', { ...loose }]]);
    delete world.data.chars[fish + ':0'];
    simulationApplied(world, { tables: { chars: { set: [], remove: [fish + ':0'] } }, values: {} });
  }
  merge();
  assert.equal(live.data.fishes[fish], undefined);
  assert.equal(live.data.chars[fish + ':1'].kind, 'food');
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

const dir = (index, ids) => { const directions = []; directions[index] = ids; return directions; };

test('广播等待发送期间，鱼的父辈、普通鱼和关系记录各自保留捕获时的值', async () => {
  const world = new World(100), data = world.data;
  data.fishes = { plain: { x: 1, facing: 1 }, child: { x: 2, parents: ['p', 'q'] } };
  data.life.bonds = { 'p|q': { a: 'p', b: 'q', seconds: 1 }, old: { details: [1] } };
  let notify, release;
  const channel = new WorldBroadcast(callback => { notify = callback; });
  const network = { live: () => [1], broadcast: (_, body) => body };
  await channel.send(network, data, 100);
  data.tick = 600;
  data.fishes.plain.x = 4;
  data.fishes.child.x = 5;
  notify(world, { values: { tick: 600 }, tables: { fishes: { set: Object.entries(data.fishes), remove: [] } } });
  const expectedFish = structuredClone(data.fishes), expectedLife = structuredClone(data.life);
  const sending = channel.send({ ...network, broadcast: (_, body) => new Promise(resolve => { release = () => resolve(body); }) }, data, 600);
  data.fishes.child.parents.push('r');
  data.fishes.plain.x++;
  data.life.bonds['p|q'].seconds++;
  data.life.bonds.old.details.push(2);
  release();
  const { world: sent } = await sending;
  assert.deepEqual(sent.fishes, expectedFish);
  assert.deepEqual(sent.life, expectedLife);
});

test('连续步以增量中的鱼行序号携带泳姿，繁忙时合并状态并省略缺步泳姿', async () => {
  const channel = new WorldBroadcast(), world = new World(100), data = world.data;
  const packets = [], network = { live: () => [1], broadcast: (_, body) => { packets.push(body); return body; } };
  data.fishes = { a: { x: 1 }, b: { x: 2 } };
  await channel.send(network, data, 100);
  data.tick += CONFIG.step;
  data.fishes.b.x++;
  let release;
  const first = channel.send({ ...network, broadcast: (_, body) => {
    packets.push(body);
    return new Promise(resolve => { release = resolve; });
  } }, data, 600, undefined, dir(5, ['b', 'absent']));
  const sent = packets.at(-1);
  assert.deepEqual(sent.swims, dir(5, [0]));
  const reader = new ReplicaReader();
  let received;
  for (const page of replicaPages(sent)) received = reader.append(page.text, page.last);
  assert.deepEqual(received, JSON.parse(JSON.stringify(sent)));
  assert.equal(received.delta, true);
  assert.deepEqual(received.world.fishes, { b: { x: 3 } });
  assert(!Object.hasOwn(received.world, 'swims'));

  data.tick += CONFIG.step;
  data.fishes.a.x++;
  await channel.send(network, data, 1100, undefined, dir(5, ['a']));
  assert.equal(packets.length, 2);
  release(); await first;
  data.tick += CONFIG.step;
  data.fishes.b.x++;
  await channel.send(network, data, 1600, undefined, dir(5, ['b']));
  assert.deepEqual(packets.at(-1).world.fishes, { a: { x: 2 }, b: { x: 4 } });
  assert(!Object.hasOwn(packets.at(-1), 'swims'));
});

test('只播放同一来源相邻确认步的泳姿，跨缝可游动，转向和合流修正直接定位', () => {
  const local = new World(100).data, animation = new ReplicaSwims();
  const fish = (id, x, facing, posAt) => ({ id, x, y: 20, facing, posAt, actor: 'owner', created: 1 });
  local.fishes = { a: fish('a', 999, 1, 100), b: fish('b', 2, 1, 100), c: fish('c', 4, 1, 100), d: fish('d', 8, 1, 100) };
  const message = (tick, fishes, swims, from = 'leader', actor = 'actor', roots = local.roots) =>
    ({ from, actor, body: { delta: true, world: { tick, fishes, roots, terrain: local.terrain }, swims } });
  const apply = (packet, correct) => animation.merge(local, packet, () => {
    local.tick = Math.max(local.tick, packet.body.world.tick);
    if (local.tick === packet.body.world.tick) Object.assign(local.fishes, structuredClone(packet.body.world.fishes));
    correct?.();
  });
  assert.equal(apply(message(100, {})).directions, undefined);
  const next = message(600, {
    a: fish('a', 0, 1, 600), b: fish('b', 3, -1, 600), c: fish('c', 5, 1, 600), d: fish('d', 9, 1, 600)
  }, dir(5, [0, 1, 2, 3]));
  next.body.world.chars = { cell: { kind: 'fish', entity: 'd' } };
  assert.deepEqual(apply(next, () => { local.fishes.c.x = 6; }).directions?.flat(), ['a']);

  const latest = animation.latest;
  assert.equal(apply(message(100, { a: fish('a', 999, 1, 100) }, dir(5, [0]))), undefined);
  assert.equal(animation.latest, latest);
  assert.equal(local.fishes.a.x, 0);
  assert.equal(apply(message(1600, { a: fish('a', 2, 1, 1600) }, dir(5, [0]))).directions, undefined);
  assert.equal(local.fishes.a.x, 2);
  assert.deepEqual(apply(message(2100, { a: fish('a', 3, 1, 2100) }, dir(5, [0]))).directions?.flat(), ['a']);

  assert.equal(apply(message(2600, { a: fish('a', 4, 1, 2600) })).directions, undefined);
  assert.equal(apply(message(3100, { a: fish('a', 5, 1, 3100) }, dir(5, [0]), 'new leader')).directions, undefined);
  assert.equal(apply(message(3600, { a: fish('a', 6, 1, 3600) }, dir(5, [0]), 'new leader', 'new actor')).directions, undefined);
  assert.equal(apply(message(4100, { a: fish('a', 7, 1, 4100) }, dir(5, [0, 0]), 'new leader', 'new actor')).directions, undefined);
  assert.equal(apply(message(4600, { a: fish('a', 8, 1, 4600) }, dir(5, [0]), 'new leader', 'new actor', {})), undefined);
  assert.equal(animation.latest, null);
});

test('等各伙伴应用回执后才继续发送，慢伙伴合并积压行而不阻塞其他伙伴', async t => {
  const received = { slow: [], fast: [] }, forwarded = [], errors = [];
  const peers = ['slow', 'fast'].map(node => ({ node, confirmedReplica: 'joined' }));
  let releaseSlow;
  const hold = new Promise(resolve => { releaseSlow = resolve; });
  const receivers = new Map();
  const sender = new ReplicaTransfers({
    directControl(peer, kind, body) {
      const { replica, via } = receivers.get(peer.node);
      return Promise.resolve().then(() => {
        replica.receive({ kind, from: 'source', actor: 'actor', body }, via).then(relay => forwarded.push(relay), error => errors.push(error));
      });
    },
    close: (_, error) => errors.push(error)
  });
  t.after(() => { releaseSlow(); sender.stop(); for (const { replica } of receivers.values()) replica.stop(); });
  for (const peer of peers) receivers.set(peer.node, {
    via: { node: 'source', replicaLive: true },
    replica: new ReplicaTransfers({
      onMessage(message) {
        assert.equal(message.kind, 'world');
        received[peer.node].push(message.body);
        if (peer.node === 'slow' && message.body.world.tick === 1) return hold;
      },
      directControl(_, kind, body) { return sender.receive({ kind, from: peer.node, body }, peer); }
    })
  });
  const wait = async check => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
    assert(check());
  };
  sender.publishLive({ delta: true, world: { tick: 1, fishes: { a: { x: 1 } } } }, peers);
  await wait(() => received.slow.length === 1 && received.fast.length === 1);
  assert.equal(receivers.get('slow').replica.incoming.size, 1);
  await wait(() => !sender.live.has(peers[1]));
  sender.publishLive({ delta: true, swims: [null, [0]], world: { tick: 2, chars: { c: { x: 7 } }, fishes: { a: { x: 2 } }, contacts: { aged: {} } } }, peers);
  await wait(() => received.fast.length === 2 && !sender.live.has(peers[1]));
  sender.publishLive({ delta: true, swims: [null, [0]], world: { tick: 3, breeding: { finished: { status: 'born' } }, fishes: { b: { x: 3 } }, contacts: {} } }, peers);
  await wait(() => received.fast.length === 3 && !sender.live.has(peers[1]));
  assert.deepEqual(received.fast.map(body => body.world.tick), [1, 2, 3]);
  assert.equal(received.slow.length, 1);
  assert.equal(receivers.get('slow').replica.incoming.size, 1);
  releaseSlow();
  await wait(() => !sender.live.size);
  assert.deepEqual(received.slow.map(body => body.world.tick), [1, 3]);
  assert.deepEqual(received.slow[1], { delta: true, world: { tick: 3, breeding: { finished: { status: 'born' } },
    fishes: { a: { x: 2 }, b: { x: 3 } }, contacts: {}, chars: { c: { x: 7 } } } });
  assert.deepEqual(errors, []);
  assert(forwarded.length && forwarded.every(value => value === false));
});

test('定期全量接替积压增量，回执丢失会释放连接并由新连接的完整状态恢复', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], closed = [];
  const older = { node: 'peer', confirmedReplica: 'joined' }, fresh = { node: 'peer', confirmedReplica: 'joined' };
  const sender = new ReplicaTransfers({
    directControl(peer, kind, body) { sent.push({ peer, kind, ...body }); },
    close(peer, error) { closed.push([peer, error.message]); sender.close(peer, error); }
  });
  t.after(() => sender.stop());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const ack = (peer, packet) => sender.receive({
    kind: 'replicaReceipt', from: peer.node, body: { id: packet.id, index: packet.index, next: packet.index + 1 }
  }, peer);
  sender.publishLive({ delta: true, world: { tick: 1, fishes: {} } }, [older]);
  sender.publishLive({ delta: true, world: { tick: 2, fishes: { old: { x: 2 } } } }, [older]);
  sender.publishLive({ delta: false, world: { tick: 3, fishes: { current: { x: 3 } } } }, [older]);
  sender.publishLive({ delta: true, world: { tick: 4, fishes: { current: { x: 4 } } } }, [older]);
  assert.equal(sent.length, 1);
  await ack(older, sent[0]); await flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(new ReplicaReader().append(sent[1].text, true), {
    delta: false, world: { tick: 4, fishes: { current: { x: 4 } } }
  });
  sender.publishLive({ delta: true, world: { tick: 5, fishes: { current: { x: 5 } } } }, [older]);
  t.mock.timers.tick(120000); await flush();
  assert.deepEqual(closed, [[older, '伙伴应用世界增量超时']]);
  assert.equal(sent.length, 2);
  assert.equal(sender.live.size, 0);

  sender.publishLive({ delta: false, world: { tick: 6, fishes: { current: { x: 6 } } } }, [fresh]);
  await ack(older, sent[1]); await flush();
  assert(sender.live.has(fresh));
  await ack(fresh, sent[2]); await flush();
  assert.equal(sender.live.size, 0);
  assert.equal(new ReplicaReader().append(sent[2].text, true).world.fishes.current.x, 6);
});

test('实时更新的末页比中间页更早验签时仍应用完整版本并确认', async t => {
  const received = [], receipts = [];
  const peer = { node: 'source', replicaLive: true };
  const replica = new ReplicaTransfers({
    onMessage(message) { received.push(message.body); },
    directControl(_, kind, body) { receipts.push({ kind, body }); }
  });
  t.after(() => replica.stop());
  const world = { tick: 500, chars: { large: { text: '鱼'.repeat(PAGE_UNITS * 20) } } };
  const pages = [...replicaPages({ delta: true, world })];
  const id = crypto.randomUUID();
  const deliver = index => replica.receive({ kind: 'replicaPage', from: peer.node, actor: 'actor',
    body: { kind: 'live', id, index, ...pages[index] } }, peer);
  await deliver(0);
  await deliver(pages.length - 1);
  assert.deepEqual(received, []);
  for (let index = 1; index < pages.length - 1; index++) await deliver(index);
  assert.deepEqual(received, [{ delta: true, world }]);
  assert.deepEqual(receipts, [{ kind: 'replicaReceipt', body: { id, index: pages.length - 1, next: pages.length } }]);
});

test('紧凑更新重建字段和鱼行顺序，切主或缺步原样发送', () => {
  const before = { tick: 500, fishes: { a: { id: 'a', actor: 'one', x: 1, parents: ['p'] }, b: { id: 'b', x: 4 } },
    chars: { x: { id: 'x', state: 'food' } }, travel: { a: { since: 500, days: { today: 2 } } },
    life: { at: 500, bonds: { 'a|b': { at: 500, seconds: 2 }, 'a|c': { at: 500, seconds: 4 } }, stories: { s: { kind: 'a' } } } };
  const body = { delta: true, swims: [[0]], world: { tick: 1000, fishes: { b: { id: 'b', x: 5 },
    a: { id: 'a', actor: 'one', x: 2, parents: ['p'] }, born: { id: 'born', x: 1 } },
    chars: { x: { state: 'burn', id: 'x' } }, travel: { a: { since: 500, days: { today: 3 } } },
    life: { at: 1000, bonds: { 'a|c': { at: 1000, seconds: 5 } }, stories: {} } } };
  const base = replicaRowBase(crypto.randomUUID(), before);
  const compact = encodeReplicaRowDelta(body, base);
  assert.equal(compact.rowBase, base.id);
  assert.deepEqual(compact.world.fishes[0], [1, 2, 5]);
  assert.deepEqual(compact.world.chars[0], ['x', body.world.chars.x]);
  const reader = new ReplicaReader();
  let received;
  for (const page of replicaPages(compact)) received = reader.append(page.text, page.last);
  assert.equal(JSON.stringify(decodeReplicaRowDelta(received, base)), JSON.stringify(body));
  assert.equal(decodeReplicaRowDelta(received, null), null);
  const skipped = { ...body, world: { ...body.world, tick: 1500 } };
  assert.equal(encodeReplicaRowDelta(skipped, base), skipped);
  const takeover = { ...body, delta: false };
  assert.equal(encodeReplicaRowDelta(takeover, base), takeover);
});

test('一端遗失基准时仅原格式确认本轮，下一轮继续使用紧凑更新', async t => {
  const peer = { node: 'follower', replicaLive: true, replicaRows: true, confirmedReplica: 'joined' };
  const via = { node: 'leader', replicaLive: true, replicaRows: true };
  const received = [], packets = [], errors = [];
  const sender = new ReplicaTransfers({
    directControl(_, kind, body) {
      packets.push(JSON.parse(body.text.split('\n')[0])[1]);
      return receiver.receive({ kind, body, from: via.node, actor: 'publisher' }, via);
    },
    close(_, error) { errors.push(error); }
  });
  const receiver = new ReplicaTransfers({
    onMessage(message) { received.push(message.body.world); },
    directControl(_, kind, body) { return sender.receive({ kind, body, from: peer.node }, peer); }
  });
  t.after(() => { sender.stop(); receiver.stop(); });
  const publish = async tick => {
    sender.publishLive({ delta: true, world: { tick, fishes: { a: { id: 'a', x: tick / 500 } } } }, [peer]);
    for (let i = 0; i < 100 && sender.live.size; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.live.size, 0);
  };
  await publish(500);
  receiver.rowsReceived.delete(via);
  await publish(1000);
  await publish(1500);
  assert.deepEqual(received.map(world => [world.tick, world.fishes.a.x]), [[500, 1], [1000, 2], [1500, 3]]);
  assert.deepEqual(packets.map(packet => !!packet.rowBase), [false, true, false, true]);
  assert.deepEqual(errors, []);
});

test('已确认直连持续发差量，归档删除后回收比较基线，旧网状成员仍定期补齐', async () => {
  let notify, legacy = false;
  const channel = new WorldBroadcast(callback => { notify = callback; });
  const world = new World(100), data = world.data;
  const record = { id: 'cold', kind: 'fish' };
  const network = { live: () => [1], periodicWorldRequired: () => legacy, broadcast: (_, body) => body };
  data.ops.cold = record;
  assert.equal((await channel.send(network, data, 100)).delta, false);
  assert(channel.previous.rows.ops.has('cold'));
  delete data.ops.cold;
  notify(world, { values: {}, tables: { ops: { set: [], remove: ['cold'] } } });
  const afterArchive = await channel.send(network, data, 31000);
  assert.equal(afterArchive.delta, true);
  assert.deepEqual(afterArchive.world.ops, {});
  assert(!channel.previous.rows.ops.has('cold'));

  data.ops.cold = record;
  notify(world, { values: {}, tables: { ops: { set: [['cold', record]], remove: [] } } });
  assert.deepEqual((await channel.send(network, data, 32000)).world.ops, { cold: record });
  legacy = true;
  const repair = await channel.send(network, data, 33000);
  assert.equal(repair.delta, false);
  assert.deepEqual(repair.world.ops, { cold: record });
});

test('选主期间跳过的更新只向原发布者补齐，较早的全量及其他发布者不清除等待', () => {
  const recovery = new ReplicaRecovery();
  const packet = (from, actor, tick) => ({ from, actor, body: { world: { tick } } });
  const source = tick => packet('original-publisher', 'original-actor', tick);
  recovery.ignore(source(100));
  assert.equal(recovery.request(packet('other', 'other-actor', 200), 1000), undefined);
  const first = recovery.request(source(200), 1000);
  assert.equal(first.to, 'original-publisher');
  assert.match(first.request, /^[0-9a-f-]{36}$/i);
  assert.equal(recovery.request(source(200), 2000), undefined);

  recovery.covered(packet('other', 'other-actor', 900), first.request);
  recovery.covered(packet('original-publisher', 'other-actor', 900), first.request);
  recovery.covered(source(99), first.request);
  recovery.ignore(source(100));
  recovery.covered(source(250), first.request);
  const latest = recovery.request(source(300), 6000);
  assert.equal(latest.to, 'original-publisher');
  assert.notEqual(latest.request, first.request);
  recovery.covered(source(300), latest.request);
  assert.equal(recovery.request(source(400), 12000), undefined);

  recovery.ignore(source(500));
  recovery.covered(source(500));
  assert.equal(recovery.request(source(600), 13000).to, 'original-publisher');
  recovery.covered(source(550));
  assert.equal(recovery.request(source(600), 19000), undefined);
});
