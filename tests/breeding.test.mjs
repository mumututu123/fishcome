import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, EYES, cellPosition, components, velocities, clone, hash } from './empty-world.mjs';
import { CONTACT_TIME, BREEDING_TIME, activeBreeding, breedingId, cancelBreeding, updateContacts, finishBreeding, chooseOwner, motionUnits, commitUnit, validBreedingRecord, inheritedGlyph, repairLocalBirthTimes } from '../www/breeding.js';
import { WorldBroadcast } from '../www/world-broadcast.js';
import { Network } from '../www/network.js';
import { actorId, signer } from '../www/storage.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { HOUR, GREENS, growthRoll, weedId, validWildCell } from '../www/seaweed.js';
import { storiesFor } from '../www/life.js';
import { fishCatalog } from '../www/fish-profile.js';
import { LEGENDS, legendSchedule, settleLegendary } from '../www/legends.js';
const t = Date.now() - 2 * BREEDING_TIME;
const cell = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
function fish(world, gender, x, y, cells = [cell(0, 0), cell(1, 0), cell(2, 0)], actor = gender, suppliedId) {
  const id = suppliedId || crypto.randomUUID(); assert(world.apply({ id, kind: 'fish', actor, nick: actor, gender, t, x, y, cells, cost: cells.length }).ok); return id;
}
function pair(fatherCells, motherCells, motherX = 23, motherY = 20) {
  const world = new World(t), male = fish(world, 'male', 20, 20, fatherCells), female = fish(world, 'female', motherX, motherY, motherCells); return { world, male, female };
}
function contacts(world, now) { updateContacts(world, now, world.fishGroups(), world.sceneryMap()); }
function bind(world) { for (let i = 0; i <= CONTACT_TIME; i += CONFIG.step) contacts(world, t + i); return Object.values(world.data.breeding).find(record => record.status === 'active'); }
const transition = (cell, next, record) => { Object.assign(cell, next); cell.path.push({ ...record, target: next.entity || '', x: next.x, y: next.y }); };

test('全量签名时发生的出生及新配对取消在下一包抵达，随后只发有变化的凭据', async () => {
  const { world } = pair(), first = bind(world), peer = new World(t);
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', keys.publicKey), secret = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const sender = new Network({ actor: await actorId(pub), pub }, {}), channel = new WorldBroadcast(), frames = [], packets = [];
  sender.sign = await signer({ secret });
  sender.connections.set('peer', { sendQueue: Promise.resolve(), queued: 0, dc: {
    readyState: 'open', bufferedAmount: 0, send: frame => frames.push(frame.buffer)
  } });
  const receiver = new Network({ actor: 'peer' }, {}, message => { peer.merge(message.body.world); packets.push(message.body); });
  const from = { packets: new Map() };
  async function deliver(sending) {
    await sending;
    const count = packets.length;
    for (const frame of frames.splice(0)) await receiver.receive(from, frame);
    assert.equal(receiver.stats.rejected, 0);
    assert.equal(packets.length, count + 1);
    return packets.at(-1);
  }

  const fullInFlight = channel.send(sender, world.data, t);
  const father = fish(world, 'male', 40, 20, undefined, 'new-father');
  fish(world, 'female', 43, 20, undefined, 'new-mother');
  for (let i = 0; i <= CONTACT_TIME; i += CONFIG.step) contacts(world, first.started + i);
  const second = world.breedingState(father);
  cancelBreeding(world.data, second, second.started, 'a');
  finishBreeding(world, first.ends + CONFIG.step, transition);

  const initial = await deliver(fullInFlight);
  assert.equal(initial.delta, false);
  assert.equal(peer.data.breeding[first.id].status, 'active');
  assert.equal(peer.data.breeding[second.id], undefined);
  const finished = clone(world.data.breeding), nextInFlight = channel.send(sender, world.data, t + 1000);
  const concurrent = new World(t);
  concurrent.merge(initial.world);
  finishBreeding(concurrent, first.ends, transition);
  world.merge(concurrent.serialize());
  const replacement = world.serialize();
  replacement.breeding[second.id].reason = 'z';
  world.merge(replacement);
  assert.equal(world.data.breeding[second.id].at, second.started);
  const next = await deliver(nextInFlight);
  assert.equal(next.delta, true);
  assert.equal(peer.data.breeding[second.id].reason, 'a');
  assert.equal(peer.data.breeding[first.id].status, 'born');
  assert.deepEqual(peer.data.breeding, finished);
  const correction = await deliver(channel.send(sender, world.data, t + 2000));
  assert.deepEqual(Object.keys(correction.world.breeding).sort(), [first.id, second.id].sort());
  assert.equal(peer.data.breeding[second.id].reason, 'z');
  assert.equal(peer.data.fishes[first.baby.id].created, first.ends);
  for (const c of peer.fishCells(first.baby.id)) assert.equal(c.path.find(e => e.birth === first.id).t, first.ends);
  assert.deepEqual(peer.data.breeding, world.data.breeding);
  assert.deepEqual((await deliver(channel.send(sender, world.data, t + 3000))).world.breeding, {});
});

test('无人接收时不读世界；首包、选主重置、断线重连与周期修复都发送完整历史', async () => {
  const channel = new WorldBroadcast(), packets = [];
  let connected = false;
  const network = { live: () => connected ? [1] : [], broadcast: (kind, body) => packets.push(body) };
  const unreadable = new Proxy({}, { get() { throw new Error('空闲广播仍在读世界'); } });
  await channel.send(network, unreadable, t);
  assert.equal(packets.length, 0);
  const { world } = pair(), record = bind(world);
  cancelBreeding(world.data, record, record.started, 'parent-gone');
  connected = true;
  async function check(now, full) {
    await channel.send(network, world.data, now);
    assert.equal(packets.at(-1).delta, !full);
    assert.deepEqual(Object.keys(packets.at(-1).world.breeding), full ? [record.id] : []);
  }
  await check(t, true);
  await check(t + 1000, false);
  channel.reset();
  await check(t + 2000, true);
  await check(t + 32001, true);
  connected = false;
  await channel.send(network, unreadable, t + 33000);
  connected = true;
  await check(t + 34000, true);
  world.data.breeding = clone(world.data.breeding);
  await check(t + 35000, true);
  assert.deepEqual(packets.at(-1).world.ops, world.data.ops);
  const sending = channel.send(network, world.data, t + 36000);
  channel.reset();
  await sending;
  await check(t + 37000, true);
});

test('正常广播读取最新合体位置，不再读取已送达的繁殖历史', async () => {
  const { world } = pair(), history = bind(world);
  cancelBreeding(world.data, history, history.started, 'incomplete-bodies');
  const father = fish(world, 'male', 40, 20, undefined, 'new-father');
  fish(world, 'female', 43, 20, undefined, 'new-mother');
  for (let i = 0; i <= CONTACT_TIME; i += CONFIG.step) contacts(world, history.started + i);
  const pairRecord = world.breedingState(father);
  const channel = new WorldBroadcast(), network = { live: () => [1], broadcast: (kind, body) => body };
  const full = await channel.send(network, world.data, t);
  assert.equal(full.world.breeding[history.id].status, 'cancelled');
  Object.defineProperty(world.data.breeding, history.id, {
    get() { throw new Error('增量广播仍在读取已发送的历史'); }, enumerable: true
  });
  const unit = motionUnits(world, world.fishGroups()).find(unit => unit.id === pairRecord.id);
  unit.fish.x += 1;
  commitUnit(unit, pairRecord.started + CONFIG.step);
  const delta = await channel.send(network, world.data, t + 1000);
  assert.equal(delta.delta, true);
  assert.equal(delta.world.breeding[history.id], undefined);
  assert.equal(delta.world.breeding[pairRecord.id].pose.male.x, full.world.breeding[pairRecord.id].pose.male.x + 1);
});

test('查询配对和推进模拟时只遍历一次繁殖历史', () => {
  const { world, male, female } = pair(), record = bind(world);
  const history = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
    const id = `old-pair:${index}`;
    return [id, { id, male, female, started: t - index - 1, status: 'cancelled' }];
  }));
  let scans = 0;
  world.data.breeding = new Proxy({ ...history, [record.id]: record }, {
    ownKeys(records) { scans++; return Reflect.ownKeys(records); },
  });
  for (let i = 0; i < 5; i++) {
    assert.equal(activeBreeding(world.data, male), record);
    assert.equal(world.breedingState(female), record);
    assert.equal(activeBreeding(world.data, 'unpaired'), undefined);
    world.step(t + CONTACT_TIME + (i + 1) * CONFIG.step);
  }
  assert(scans <= 1, `繁殖历史被遍历了 ${scans} 次`);
});

test('更换繁殖记录表后按原顺序查询，校正冲突时保留较早的配对', () => {
  const { world, male, female } = pair(), first = bind(world);
  assert.equal(world.breedingState(male), first);
  const partner = fish(world, 'female', 40, 20, undefined, 'other');
  const started = first.started + CONFIG.step, id = breedingId(male, partner, started);
  const later = { ...clone(first), id, female: partner, started, ends: started + BREEDING_TIME, at: started };
  world.data.breeding = { [id]: later, [first.id]: first };

  assert.equal(world.breedingState(male), later);
  assert.equal(world.breedingState(partner), later);
  finishBreeding(world, started, transition);
  assert.equal(later.reason, 'conflicting-pair');
  assert.equal(world.breedingState(male), first);
  assert.equal(world.breedingState(female), first);
  assert.equal(world.breedingState(partner), undefined);
});

test('公母八邻域连续接触满5秒才绑定，中断、长时间休眠重置计时', () => {
  const { world, male, female } = pair(); assert.equal(world.breedingState(male), undefined);
  contacts(world, t); for (let i = 500; i < 5000; i += 500) contacts(world, t + i);
  assert.equal(Object.keys(world.data.breeding).length, 0); contacts(world, t + 5000); assert.equal(world.breedingState(male)?.ends, t + 5000 + BREEDING_TIME);
  assert.equal(world.breedingState(female), world.breedingState(male));
  const interrupted = pair(); contacts(interrupted.world, t); contacts(interrupted.world, t + 500); interrupted.world.data.fishes[interrupted.female].x += 10; contacts(interrupted.world, t + 1000); assert.equal(Object.keys(interrupted.world.data.contacts).length, 0);
  interrupted.world.data.fishes[interrupted.female].x -= 10; contacts(interrupted.world, t + 1500); contacts(interrupted.world, t + 6500); assert.equal(Object.keys(interrupted.world.data.breeding).length, 0);
  const sameSex = pair(); sameSex.world.data.ops[sameSex.female].gender = 'male'; assert.equal(bind(sameSex.world), undefined);
  const legacy = pair(); delete legacy.world.data.ops[legacy.female].gender; assert.equal(bind(legacy.world), undefined);
});
test('接触不能隔着造景，繁殖期间不能与第三条鱼配对', () => {
  const diagonal = pair(undefined, undefined, 23, 21);
  assert(diagonal.world.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 23, y: 20, cells: [cell(0, 0, '#'), cell(1, 0, '#')], cost: 2 }).ok);
  assert.equal(bind(diagonal.world), undefined);
  const { world, male } = pair(), record = bind(world); assert(record);
  fish(world, 'female', 17, 20, undefined, 'other'); for (let i = 5500; i <= 12000; i += 500) contacts(world, t + i);
  assert.equal(Object.values(world.data.breeding).filter(r => r.status === 'active').length, 1); assert.equal(world.breedingState(male).id, record.id);
});
test('合体游速按外接宽高和两鱼总字数计算，移动与水平翻转保持相对形状', () => {
  const { world, male, female } = pair(), record = bind(world), units = motionUnits(world, world.fishGroups());
  assert.equal(units.length, 1); assert.deepEqual(velocities(units[0].cells), { x: 2, y: 1 / 3 }); assert.deepEqual(world.swimVelocities(male), world.swimVelocities(female));
  const unit = units[0], initial = world.fishCells(male).map(c => cellPosition(world.data.fishes[male], c));
  assert(world.turn(unit.fish, unit.cells)); unit.fish.x -= 1; unit.fish.y += 1; commitUnit(unit, t + 5500);
  assert.equal(world.data.fishes[male].x - world.data.fishes[female].x, 3); assert.equal(world.data.fishes[male].y, world.data.fishes[female].y);
  assert.equal(world.data.fishes[male].facing, -1); assert.equal(world.data.fishes[female].facing, -1);
  assert(validBreedingRecord(record, world.data));
  const reflected = world.fishCells(male).map(c => cellPosition(world.data.fishes[male], c));
  assert.deepEqual(reflected, initial.map(p => ({ x: 45 - p.x - 1, y: p.y + 1 })));
});
test('合体移动、转头检查两条鱼全部鱼元与扫过路径，碰墙不移动', () => {
  const { world } = pair(); bind(world); const unit = motionUnits(world, world.fishGroups())[0];
  assert(world.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 26, y: 20, cells: [cell(0, 0, '#'), cell(0, 1, '#')], cost: 2 }).ok);
  assert.equal(world.canOccupy({ ...unit.fish, x: unit.fish.x + 1 }, unit.cells), false);
  const bent = pair([cell(0, 0), cell(1, 1), cell(2, 2)], [cell(0, 0), cell(1, 0), cell(2, 0)], 23, 22); bind(bent.world);
  const turning = motionUnits(bent.world, bent.world.fishGroups())[0];
  assert(bent.world.apply({ id: crypto.randomUUID(), actor: 'wall', t, kind: 'scene', x: 22, y: 20, cells: [cell(0, 0, '#'), cell(1, 0, '#')], cost: 2 }).ok);
  assert.equal(bent.world.turn(turning.fish, turning.cells), false);
});
test('繁殖期间两鱼正常进食，字色长在吃到的鱼上，合体仍保持固定位置', () => {
  const { world, male, female } = pair(); bind(world);
  const foodIds = [];
  for (const [index, x] of [19, 26].entries()) { const id = crypto.randomUUID(); foodIds.push(id); assert(world.apply({ id, actor: 'feeder', t, kind: 'food', x, y: 0, ch: index ? '口' : '草', color: '#55bc68', cost: 1 }).ok); world.data.chars[id].y = 20; }
  world.step(t + 5500);
  assert.equal(world.data.chars[foodIds[0]].entity, male); assert.equal(world.data.chars[foodIds[1]].entity, female);
  assert.equal(world.fishCells(male).length, 4); assert.equal(world.fishCells(female).length, 4);
  assert.equal(world.data.fishes[male].lastFed, t + 5500); assert.equal(world.data.fishes[female].lastFed, t + 5500);
  assert.equal(world.data.fishes[male].x - world.data.fishes[female].x, -3); assert.equal(world.fishStatus(male, t + 5500).meals24, 1);
});
test('1小时后只转移进入繁殖时的接触鱼元，父母各保留至少两个连通鱼元，小鱼补眼且不复制鱼元', () => {
  const { world, male, female } = pair(), record = bind(world), ids = Object.keys(world.data.chars), positions = new Map(Object.values(world.data.chars).map(c => [c.id, cellPosition(world.data.fishes[c.entity], c)]));
  finishBreeding(world, record.ends - 1, transition); assert.equal(world.counts().fish, 2);
  finishBreeding(world, record.ends, transition); assert.equal(record.status, 'born'); assert.equal(world.counts().fish, 3); assert.deepEqual(Object.keys(world.data.chars), ids);
  for (const actor of ['male', 'female']) assert.equal(storiesFor(world.data, fishCatalog(world.data), actor).filter(story => story.kind === 'birth').length, 1);
  const baby = world.data.fishes[record.baby.id], cells = world.fishCells(baby.id);
  assert.equal(cells.length, 2); assert(cells.some(c => EYES.has(c.ch))); assert.equal(cells.filter(c => EYES.has(c.ch)).length, 1);
  for (const c of cells) { assert.deepEqual(cellPosition(baby, c), positions.get(c.id)); assert.equal(c.color, '#88aacc'); assert.equal(inheritedGlyph(c, 'Q', world.data), c.ch); }
  for (const id of [male, female]) { assert.equal(world.fishCells(id).length, 2); assert.equal(components(world.fishCells(id)).length, 1); assert.equal(world.breedingState(id), undefined); }
  assert(validBreedingRecord(record, world.data)); assert.equal(world.wallet('male'), 17); assert.equal(world.wallet('female'), 17);
  assert.equal(world.myFishes(baby.actor).some(f => f.id === baby.id), true); assert.equal(world.fishStatus(baby.id, record.ends).meals24, 0);
  finishBreeding(world, record.ends + 500, transition); assert.equal(world.counts().fish, 3);
});
test('归属优先继承鱼元数量，再比较分裂后的父母字数，最后稳定随机', () => {
  const { world, female } = pair(undefined, [0, 1, 2, 3, 4].map(y => cell(0, y)), 23, 19), record = bind(world);
  finishBreeding(world, record.ends, transition); assert.equal(record.baby.fatherCount, 1); assert.equal(record.baby.motherCount, 3); assert.equal(record.baby.owner, female); assert.equal(record.baby.actor, 'female'); assert(validBreedingRecord(record, world.data));
  const largeFather = pair([0, 1, 2, 3, 4].map(x => cell(x, 0)), undefined, 25, 20), second = bind(largeFather.world); finishBreeding(largeFather.world, second.ends, transition); assert.equal(second.baby.owner, largeFather.male);
  assert.equal(chooseOwner(record, 1, 2, 10, 2), record.female);
  const chosen = chooseOwner(record, 2, 2, 4, 4); assert([record.male, record.female].includes(chosen)); assert.equal(chooseOwner(clone(record), 2, 2, 4, 4), chosen);
});
test('出生后父母过小、父母断裂或小鱼不连通时取消出生，鱼元不减少', () => {
  const cases = [pair([cell(0, 0), cell(1, 0)], [cell(0, 0), cell(1, 0)], 22, 20), pair([0, 1, 2, 3, 4].map(x => cell(x, 0)), [0, 1, 2].map(y => cell(0, y)), 22, 17), pair([0, 1, 2, 3, 4, 5, 6].map(x => cell(x, 0)), [cell(0, 0), cell(6, 0), ...[0, 1, 2, 3, 4, 5, 6].map(x => cell(x, 1))], 20, 21)];
  for (const { world } of cases) { const record = bind(world); assert(record); const before = clone(world.data.chars); finishBreeding(world, record.ends, transition); assert.equal(record.status, 'cancelled'); assert.equal(world.counts().fish, 2); assert.deepEqual(world.data.chars, before); }
});
test('繁殖期间亲鱼消失取消绑定，饥饿丢失接触鱼元时不转移其他鱼元替代', () => {
  const { world, male, female } = pair(), record = bind(world); assert.equal(world.breedingState(female), record);
  delete world.data.fishes[male]; finishBreeding(world, t + 6000, transition); assert.equal(record.reason, 'parent-gone');
  assert.equal(world.breedingState(male), undefined); assert.equal(world.breedingState(female), undefined);
  const second = pair(), attempt = bind(second.world), removed = attempt.contact.male[0]; second.world.starve(second.male, t + 6000, removed); finishBreeding(second.world, attempt.ends, transition); assert.equal(attempt.status, 'cancelled'); assert.equal(second.world.data.chars[removed].kind, 'burn');
});
test('异象捕获一条亲鱼后两条亲鱼立即解除配对', () => {
  const { world, male, female } = pair(), record = bind(world);
  assert.equal(world.breedingState(male), record);
  const slot = Math.ceil(record.started / LEGENDS.period);
  let schedule;
  for (let i = 0; schedule?.kind !== 'cthulhu'; i++) {
    const seed = `breeding-legend-${i}`;
    schedule = legendSchedule({ [seed]: t }, seed, slot);
  }
  const { seed, id } = schedule, at = schedule.started + LEGENDS.warning;
  const { x, y, facing } = world.data.fishes[male], cells = world.fishCells(male).map(cell => cell.id).sort();
  world.data.roots[seed] = t;
  world.data.legends.events[id] = { seed, slot, at: schedule.started, arms: { 0: { fish: male, at, x, y, pose: { x, y, facing }, cells } }, minute: 0, drops: [] };
  settleLegendary(world, at, transition);
  assert.equal(record.reason, 'legend');
  assert.equal(world.breedingState(male), undefined);
  assert.equal(world.breedingState(female), undefined);
});
test('繁殖状态、出生归属、鱼元和运动记录跨存档与合流保存，旧快照不复活孕期或重复出生', () => {
  const { world } = pair(), record = bind(world), active = world.serialize();
  const restored = restoreCheckpoint({ world: active, at: t + 5000, lastOnlineAt: t + 5000 }, t + 6000).world; assert(restored.breedingState(record.male));
  assert.deepEqual(restored.serialize().breeding, active.breeding);
  const fromArchive = new World(t); assert.equal(fromArchive.breedingState(record.male), undefined);
  fromArchive.merge({ ...active, breeding: {} }, { breeding: active.breeding });
  assert.deepEqual(fromArchive.breedingState(record.male), active.breeding[record.id]);
  const peer = new World(t); assert.equal(peer.breedingState(record.male), undefined);
  peer.merge(active); const previous = peer.breedingState(record.male); assert.equal(previous, peer.data.breeding[record.id]);
  commitUnit(motionUnits(world, world.fishGroups())[0], record.started + CONFIG.step);
  peer.merge(world.serialize()); assert.notEqual(peer.breedingState(record.male), previous);
  assert.equal(peer.breedingState(record.male), peer.data.breeding[record.id]);
  finishBreeding(restored, record.ends, transition); const born = restored.serialize();
  assert.equal(restored.breedingState(record.male), undefined);
  assert.equal(peer.breedingState(record.male)?.status, 'active');
  peer.merge(born); assert.equal(peer.breedingState(record.male), undefined); peer.merge(active); peer.merge(born);
  assert.equal(peer.counts().fish, 3); assert.equal(peer.data.breeding[record.id].status, 'born'); assert.equal(peer.breedingState(record.male), undefined); assert.equal(peer.fishCells(born.breeding[record.id].baby.id).length, 2);
  assert.equal(peer.data.travel[born.breeding[record.id].baby.id].since, record.ends);
});
test('出生记录与眼睛转换必须可追溯，伪造归属、性别或鱼元转换被拒绝', () => {
  const { world } = pair(), record = bind(world); finishBreeding(world, record.ends, transition);
  for (const mutate of [r => r.baby.actor = 'intruder', r => r.baby.gender = r.baby.gender === 'male' ? 'female' : 'male', r => r.baby.cells[0].after = '#', r => r.ends--, r => r.pose.male.x++]) { const bad = clone(record); mutate(bad); assert.equal(validBreedingRecord(bad, { ...world.data, breeding: { [bad.id]: bad } }), false); }
  const born = world.fishCells(record.baby.id)[0], bad = clone(born); bad.path.at(-1).before = '#'; assert.equal(inheritedGlyph(bad, 'Q', world.data), null);
});
test('完整模拟循环持续接触5秒后配对，合体眼睛共同寻食且两鱼运动同量', () => {
  const world = new World(t);
  function idleId() { let id; do { id = crypto.randomUUID(); } while (hash(`${id}:0`) % 3 !== 1 || Math.floor(hash(`${id}:0`) / 3) % 3 !== 1); return id; }
  const male = fish(world, 'male', 20, 20, [cell(0, 0, 'o'), cell(1, 0), cell(2, 0)], 'male', idleId()), female = fish(world, 'female', 23, 20, undefined, 'female', idleId());
  for (let elapsed = 0; elapsed <= 5000; elapsed += 500) world.step(t + elapsed);
  assert(world.breedingState(male));
  const food = crypto.randomUUID(); assert(world.apply({ id: food, actor: 'feed', t: t + 5000, kind: 'food', x: 30, y: 0, ch: '口', color: '#aabbcc', cost: 1 }).ok); world.data.chars[food].y = 20;
  const old = { x: world.data.fishes[male].x, y: world.data.fishes[male].y }, other = { x: world.data.fishes[female].x, y: world.data.fishes[female].y };
  world.step(t + 5500);
  assert.equal(world.data.fishes[male].x - old.x, world.data.fishes[female].x - other.x); assert.equal(world.data.fishes[male].y - old.y, world.data.fishes[female].y - other.y);
  assert.equal(world.fishStatus(male, t + 5500).movement, world.fishStatus(female, t + 5500).movement); assert(world.fishStatus(male, t + 5500).movement > 0);
});
test('小鱼长大后可以繁殖，后代归属和多代眼睛转换仍可追溯', () => {
  const { world, male, female } = pair(), first = bind(world); finishBreeding(world, first.ends, transition);
  const child = world.data.fishes[first.baby.id]; child.x = 40; child.y = 20; world.data.fishes[male].y = world.data.fishes[female].y = 50;
  for (const x of [2, 3]) {
    const id = crypto.randomUUID(); assert(world.apply({ id, actor: 'feeder', t, kind: 'food', x: 40 + x, y: 0, ch: 'Q', color: '#aabbcc', cost: 1 }).ok);
    transition(world.data.chars[id], { kind: 'fish', entity: child.id, x, y: 0 }, { id: `eat:${id}`, t: first.ends, reason: 'eat' });
  }
  const gender = child.gender === 'male' ? 'female' : 'male'; fish(world, gender, 37, 20, undefined, 'new-parent');
  for (let elapsed = 500; elapsed <= 5500; elapsed += 500) contacts(world, first.ends + elapsed);
  const second = world.breedingState(child.id); assert(second); finishBreeding(world, second.ends, transition); assert.equal(second.status, 'born'); assert(validBreedingRecord(second, world.data));
  const inherited = world.fishCells(second.baby.id).find(c => c.path.filter(p => p.reason === 'birth').length === 2); assert(inherited); assert.equal(inheritedGlyph(inherited, 'Q', world.data), inherited.ch);
  assert(world.myFishes(second.baby.actor).some(f => f.id === second.baby.id));
});
test('曾吃入鱼体的海草也可遗传，补眼后仍保留合法自然来源与原色', () => {
  const { world, male } = pair(), tip = world.fishCells(male).find(c => c.x === 2); world.starve(male, t + 500, tip.id);
  const source = 'floor:22'; let hour = Math.floor(t / HOUR) - 10000; while (!growthRoll(source, ++hour, hash)) {}
  const id = weedId(source, hour, hash), grass = { id, kind: 'food', entity: '', payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x: 22, y: 20, born: t, created: hour * HOUR, path: [], wild: { source, hour, plant: id, index: 0, x: 22, y: 119 } }; world.data.chars[id] = grass;
  transition(grass, { kind: 'fish', entity: male, x: 2, y: 0 }, { id: `eat:${id}`, t, reason: 'eat' });
  const record = bind(world); finishBreeding(world, record.ends, transition); assert.equal(grass.entity, record.baby.id); assert(validWildCell(grass, CONFIG, hash)); assert.equal(inheritedGlyph(grass, '草', world.data), grass.ch); assert(validBreedingRecord(record, world.data));
});

test('concurrent births converge without losing the newest fish position or birth proof', () => {
  const { world } = pair(), record = bind(world), active = world.serialize();
  const make = now => {
    const replica = new World(t); replica.merge(active);
    finishBreeding(replica, now, transition);
    return replica.serialize();
  };
  const early = make(record.ends), late = make(record.ends + 500);
  const id = early.breeding[record.id].baby.id;
  late.fishes[id].x += 4;
  const later = new World(t); later.merge(late);
  const meal = crypto.randomUUID(), mealAt = record.ends + 1000;
  assert(later.apply({ id: meal, kind: 'food', actor: 'feeder', t, x: 21, y: 0, ch: 'Q', color: '#88aacc', cost: 1 }).ok);
  transition(later.data.chars[meal], { kind: 'fish', entity: id, x: 2, y: 0 }, { id: 'meal', t: mealAt, reason: 'eat' });
  const moved = later.fishCells(id)[0], shedAt = mealAt + 500, eatenAt = mealAt + 1000;
  transition(moved, { kind: 'food', entity: '', x: 25, y: 20 }, { id: 'shed', t: shedAt, reason: 'shed' });
  transition(moved, { kind: 'fish', entity: record.male, x: 2, y: 0 }, { id: 'eat-again', t: eatenAt, reason: 'eat' });
  const fed = later.serialize();
  const cold = new World(t);
  cold.merge(late, { breeding: early.breeding });
  assert.equal(cold.data.breeding[record.id].baby.created, record.ends);
  assert.equal(cold.data.fishes[id].created, record.ends);
  for (const c of cold.fishCells(id)) assert.equal(inheritedGlyph(c, 'Q', cold.data), c.ch);
  for (const [left, right] of [[early, late], [late, early], [early, fed], [fed, early]]) {
    const merged = new World(t); merged.merge(left); merged.merge(right); merged.merge(right);
    const snapshot = merged.serialize(), saved = JSON.parse(JSON.stringify(snapshot));
    const restored = restoreCheckpoint({ world: saved, lastOnlineAt: record.ends + 500 }, record.ends + 1000).world;
    for (const data of [snapshot, restored.data]) {
      const birth = data.breeding[record.id];
      assert(validBreedingRecord(birth, data));
      assert.equal(data.fishes[id].created, birth.baby.created);
      assert.equal(data.fishes[id].actor, birth.baby.actor);
      assert.equal(data.fishes[id].x, late.fishes[id].x);
      const fedBranch = left === fed || right === fed;
      assert.equal(data.fishes[id].lastMealAt, fedBranch ? mealAt : undefined);
      if (fedBranch) {
        const cell = data.chars[moved.id];
        assert.equal(cell.entity, record.male);
        assert.deepEqual([cell.x, cell.y], [2, 0]);
        assert.deepEqual(cell.path.slice(-3).map(e => [e.reason, e.t]), [
          ['birth', record.ends], ['shed', shedAt], ['eat', eatenAt]
        ]);
        assert.equal(inheritedGlyph(cell, 'Q', data), cell.ch);
      }
      for (const c of Object.values(data.chars).filter(c => c.entity === id)) {
        if (c.id !== meal) assert.equal(c.path.find(e => e.birth === record.id).t, birth.baby.created);
        assert.equal(inheritedGlyph(c, 'Q', data), c.ch);
      }
    }
  }
});


test('legacy local repair is non-mutating, idempotent and does not bless mismatched ownership', () => {
  const { world } = pair(), record = bind(world);
  finishBreeding(world, record.ends, transition);
  const data = world.serialize(), { id } = record.baby;
  assert.strictEqual(repairLocalBirthTimes(data), data);
  const legacy = clone(data);
  legacy.fishes[id].created += 500;
  const inherited = Object.values(legacy.chars).find(c => c.entity === id);
  inherited.path.at(-1).t += 500;
  const repaired = repairLocalBirthTimes(legacy);
  assert.equal(repaired.fishes[id].created, record.ends);
  assert.equal(repaired.chars[inherited.id].path.at(-1).t, record.ends);
  assert.equal(legacy.fishes[id].created, record.ends + 500);
  assert.equal(inherited.path.at(-1).t, record.ends + 500);
  assert.strictEqual(repairLocalBirthTimes(repaired), repaired);
  legacy.fishes[id].actor = 'someone-else';
  inherited.path.at(-1).before = '#';
  assert.strictEqual(repairLocalBirthTimes(legacy), legacy);
  const invalidProof = clone(data);
  invalidProof.fishes[id].created += 500;
  invalidProof.breeding[record.id].baby.owner = 'someone-else';
  assert.strictEqual(repairLocalBirthTimes(invalidProof), invalidProof);
});
