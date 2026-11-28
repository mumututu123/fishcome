import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, chooseClaim, clone } from '../www/engine.js';
import { CONTACT_TIME, updateContacts, finishBreeding } from '../www/breeding.js';
import { DiagnosticLog, inspectFishOrigins, repairFishOriginIssues, diagnosticSummary } from '../www/diagnostics.js';

import { ArchiveStore, ARCHIVE_FIELDS, encodeArchive, compactKnown } from '../www/archive.js';
import { loadReplicaArchives, verifyReplica } from '../www/replica.js';
import { worldEdited } from '../www/simulation-changes.js';
import { Network } from '../www/network.js';
import { actorId, signer, verifyEnvelope } from '../www/storage.js';

function makeFishOp(id, actor, t, x, y, gender, cells) {
  return { id, actor, nick: actor.slice(0, 4), kind: 'fish', t, x, y, gender, cost: cells.length, cells };
}

function buildWorldWithBornFish(actorA = 'a'.repeat(64), actorB = 'b'.repeat(64)) {
  const start = 1_700_000_000_000;
  const world = new World(start, '11111111-1111-4111-8111-111111111111', { populate: false, ambient: false });
  const maleId = '22222222-2222-4222-8222-222222222222';
  const femaleId = '33333333-3333-4333-8333-333333333333';
  const maleCells = [
    { x: 0, y: 0, ch: 'o', color: '#8be7df' },
    { x: 1, y: 0, ch: '公', color: '#8be7df' },
    { x: 2, y: 0, ch: '尾', color: '#8be7df' }
  ];
  const femaleCells = [
    { x: 0, y: 0, ch: 'O', color: '#ff9fc8' },
    { x: 1, y: 0, ch: '母', color: '#ff9fc8' },
    { x: 2, y: 0, ch: '尾', color: '#ff9fc8' }
  ];
  assert.equal(world.apply(makeFishOp(maleId, actorA, start + 1000, 10, 10, 'male', maleCells)).ok, true);
  assert.equal(world.apply(makeFishOp(femaleId, actorB, start + 1000, 13, 10, 'female', femaleCells)).ok, true);
  for (let t = start + 1500; t <= start + 1500 + CONTACT_TIME; t += 500) {
    updateContacts(world, t, world.fishGroups(), world.sceneryMap());
  }
  const record = Object.values(world.data.breeding)[0];
  assert(record && record.status === 'active');
  finishBreeding(world, record.ends + 500, (c, next, ev) => { Object.assign(c, next); c.path.push({ ...ev, target: next.entity || '', x: next.x, y: next.y }); });
  assert.equal(record.status, 'born');
  return { world, maleId, femaleId, actorA, actorB, babyId: record.baby.id, breedingId: record.id };
}

test('诊断日志保留上限并支持格式化输出', () => {
  const log = new DiagnosticLog(3);
  log.record('info', 'start', 'a');
  log.record('warn', 'network', 'b', { peer: 'p1' });
  log.record('error', 'replica', 'c');
  log.record('error', 'import', 'd');
  assert.equal(log.list().length, 3);
  assert.equal(log.list()[0].message, 'b');
  assert.match(log.format(), /\[WARN\] \[network\] b/);
  assert.match(log.format(), /"peer":"p1"/);
});

test('准确识别创建鱼与出生鱼的各类创建者异常，并区分可无损对齐与孤儿鱼', () => {
  const { world, babyId } = buildWorldWithBornFish();
  const dirty = world.serialize();
  // 1. 出生鱼时间早于来源且归属错配（旧版分叉场景）
  dirty.fishes[babyId].created -= 3000;
  dirty.fishes[babyId].actor = 'c'.repeat(64);
  // 2. 独立创建鱼缺少 ops 凭据（孤儿鱼）
  const orphanId = '55555555-5555-4555-8555-555555555555';
  dirty.fishes[orphanId] = { id: orphanId, actor: 'e'.repeat(64), nick: '孤儿', x: 30, y: 20, facing: 1, created: 1_700_000_000_500, lastFed: 1_700_000_000_500, hungerAt: 1_700_086_400_500 };

  const report = inspectFishOrigins(dirty);
  assert.equal(report.totalFishes, 4);
  assert.equal(report.issues.length, 2);
  assert.equal(report.safeRepairable, 1);
  assert.equal(report.orphanCount, 1);

  const babyIssue = report.issues.find(i => i.id === babyId);
  assert.deepEqual(babyIssue.reasons.sort(), ['actor_mismatch', 'created_mismatch']);
  assert.equal(babyIssue.repairable, 'safe');

  const orphanIssue = report.issues.find(i => i.id === orphanId);
  assert.deepEqual(orphanIssue.reasons, ['missing_origin_op']);
  assert.equal(orphanIssue.repairable, 'prune_orphan');
});

test('无损对齐修复能修正出生鱼时间/归属/路径与 travel，且不修改孤儿鱼和原对象', () => {
  const { world, maleId, babyId } = buildWorldWithBornFish();
  const dirty = world.serialize();
  const originalBabyCreated = dirty.fishes[babyId].created;
  const originalBabyActor = dirty.fishes[babyId].actor;

  dirty.fishes[babyId].created = originalBabyCreated - 5000;
  dirty.fishes[babyId].actor = 'f'.repeat(64);
  dirty.travel[babyId].since = originalBabyCreated - 5000;
  for (const cell of Object.values(dirty.chars)) {
    for (const ev of cell.path) if (ev.reason === 'birth') ev.t = originalBabyCreated + 1234;
  }
  const snapshotBefore = clone(dirty);

  const res = repairFishOriginIssues(dirty, {}, { mode: 'align' });
  assert.equal(res.changed, true);
  assert.deepEqual(dirty, snapshotBefore);
  assert.equal(res.remaining.length, 0);
  assert.equal(res.data.fishes[babyId].created, originalBabyCreated);
  assert.equal(res.data.fishes[babyId].actor, originalBabyActor);
  assert.equal(res.data.travel[babyId].since, originalBabyCreated);
  for (const cell of Object.values(res.data.chars)) {
    for (const ev of cell.path) if (ev.reason === 'birth') assert.equal(ev.t, originalBabyCreated);
  }
  // 原生创建鱼未被改动
  assert.deepEqual(res.data.fishes[maleId], snapshotBefore.fishes[maleId]);
  assert.deepEqual(res.data.ops, snapshotBefore.ops);
});

test('清理模式可移除彻底缺少创建凭据的孤儿鱼及其无源鱼元与关联记录', () => {
  const { world, maleId } = buildWorldWithBornFish();
  const dirty = world.serialize();
  const orphanId = '44444444-4444-4444-8444-444444444444';
  dirty.fishes[orphanId] = { id: orphanId, actor: 'e'.repeat(64), nick: '孤儿', x: 50, y: 20, facing: 1, created: 1_700_000_000_500, lastFed: 1_700_000_000_500, hungerAt: 1_700_086_400_500 };
  dirty.travel[orphanId] = { since: 1_700_000_000_500, days: {} };
  dirty.contacts[`${orphanId}|${maleId}`] = { male: orphanId, female: maleId, since: 1, lastAt: 2 };
  dirty.life.bonds[`${orphanId}|${maleId}`] = { a: orphanId, b: maleId, score: 10 };
  dirty.life.places[orphanId] = { scene: 's1', at: 1 };
  dirty.life.stories['story-orphan'] = { id: 'story-orphan', kind: 'arrive', fish: orphanId, at: 1 };
  dirty.legends.deaths[orphanId] = { at: 1 };
  dirty.chars[`${orphanId}:0`] = { id: `${orphanId}:0`, payer: 'e'.repeat(64), ch: 'o', color: '#ffffff', kind: 'fish', entity: orphanId, x: 0, y: 0, path: [], created: 1_700_000_000_500 };

  const alignOnly = repairFishOriginIssues(dirty, {}, { mode: 'align' });
  assert.equal(alignOnly.changed, false);
  assert.equal(alignOnly.remaining.length, 1);

  const pruned = repairFishOriginIssues(dirty, {}, { mode: 'align_and_prune' });
  assert.equal(pruned.changed, true);
  assert.equal(pruned.remaining.length, 0);
  assert.equal(pruned.data.fishes[orphanId], undefined);
  assert.equal(pruned.data.travel[orphanId], undefined);
  assert.equal(pruned.data.contacts[`${orphanId}|${maleId}`], undefined);
  assert.equal(pruned.data.life.bonds[`${orphanId}|${maleId}`], undefined);
  assert.equal(pruned.data.life.places[orphanId], undefined);
  assert.equal(pruned.data.life.stories['story-orphan'], undefined);
  assert.equal(pruned.data.legends.deaths[orphanId], undefined);
  assert.equal(pruned.data.chars[`${orphanId}:0`], undefined);
});

async function participant() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const identity = { pub, secret: await crypto.subtle.exportKey('jwk', keys.privateKey), actor: await actorId(pub) };
  const peer = new Network(identity, {}, () => {}, () => {});
  peer.sign = await signer(identity);
  return peer;
}

async function signedFamily() {
  const a = await participant(), b = await participant();
  const family = buildWorldWithBornFish(a.identity.actor, b.identity.actor);
  const data = family.world.serialize();
  for (const op of Object.values(data.ops)) {
    op.proof = await (op.actor === a.identity.actor ? a : b).makeEnvelope('op', op);
  }
  await verifyReplica(data);
  return { ...family, data, a };
}

test('有初始海草的新世界在独立诊断和两端首次合流时均可完整验证', async () => {
  const time = 1_700_000_000_000;
  const a = new World(time, 'd054a8af-a177-407e-b1d3-59534b4285ca');
  const b = new World(time, '2778bd82-ee6d-4fc0-863f-56f5951e1904');
  assert(Object.values(a.data.chars).some(cell => cell.wild?.origin === a.id));
  const snapshot = a.serialize();
  await verifyReplica(snapshot);
  await verifyReplica(snapshot, {}, undefined, { current: b.data });
  b.merge(snapshot);
  await verifyReplica(b.serialize());

  const grass = Object.values(snapshot.chars).find(cell => cell.wild);
  Object.assign(grass, { kind: 'fish', entity: crypto.randomUUID() });
  grass.path.push({ reason: 'eat', target: grass.entity, t: time });
  await assert.rejects(verifyReplica(snapshot), /海草缺少合法生态来源/);
});

test('隔离校验只使用本份快照和指定归档，联机增量可使用已验证的本地来源', async () => {
  const { data, a, maleId } = await signedFamily();
  const delta = clone(data);
  delete delta.ops[maleId];
  await assert.rejects(verifyReplica(delta));
  await verifyReplica(delta, {}, undefined, { current: data });
  const chat = await a.makeEnvelope('chat', { nick: '同事', text: '自己的记忆', t: data.tick, roots: Object.keys(data.roots) });
  data.chats[chat.id] = chat;
  await verifyReplica(data);
  const other = clone(data);
  other.chats[chat.id].body.text = '另一份记忆';
  const { signature, ...body } = other.chats[chat.id];
  other.chats[chat.id].signature = await a.sign(body);
  await assert.rejects(verifyReplica(other, {}, undefined, { current: data }), /已有聊天/);
  await verifyReplica(other);
  other.chatSources[chat.id] = chat;
  await assert.rejects(verifyReplica(other), /已有聊天/);
});

test('归档按鱼表键名和接触双方补齐凭据，修正编号时不会误删有效的鱼', async () => {
  const { data, maleId, femaleId } = await signedFamily();
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  records.ops = data.ops;
  const store = new ArchiveStore();
  await store.ingest(await encodeArchive(records, data.roots), chooseClaim);
  const partial = { fishes: { [maleId]: { ...data.fishes[maleId], id: femaleId } }, ops: {}, chars: {} };
  const extra = await store.dependencies(partial);
  assert.deepEqual(Object.keys(extra.ops), [maleId]);
  const repair = repairFishOriginIssues(partial, extra, { mode: 'align_and_prune' });
  assert.equal(repair.data.fishes[maleId].id, maleId);
  const pair = { male: maleId, female: femaleId, since: data.tick, lastAt: data.tick };
  const contacts = { [`${maleId}|${femaleId}`]: pair };
  assert.deepEqual(Object.keys((await store.dependencies({ contacts })).ops).sort(), [maleId, femaleId].sort());
  const world = new World(data.tick, Object.keys(data.roots)[0], { populate: false });
  Object.assign(world.data, { ops: clone(records.ops), contacts });
  await compactKnown(world, store);
  assert.deepEqual(world.data.ops, records.ops);
});

test('出生鱼元路径或运动时间单独偏移也能修复，并通过独立完整校验', async () => {
  const { data, babyId } = await signedFamily();
  const cell = Object.values(data.chars).find(c => c.entity === babyId);
  const at = data.fishes[babyId].created;
  cell.path.at(-1).t += 500;
  data.travel[babyId] = { since: at - 1, days: { '2023-11-15': 12 } };
  await assert.rejects(verifyReplica(data));
  const fixed = repairFishOriginIssues(data);
  assert.equal(fixed.data.travel[babyId].since, at);
  assert.deepEqual(fixed.data.travel[babyId].days, data.travel[babyId].days);
  assert.equal(fixed.data.chars[cell.id].path.at(-1).t, at);
  await verifyReplica(fixed.data);
  assert.equal(repairFishOriginIssues(fixed.data).changed, false);
});

test('对齐手绘鱼的初始饥饿时钟，兼容尚无接触字段的旧存档', async () => {
  const { data, maleId } = await signedFamily();
  delete data.contacts;
  delete data.contactAt;
  const f = data.fishes[maleId];
  f.created += 1500;
  f.lastFed = f.created;
  f.hungerAt = f.created + CONFIG.hunger;
  const next = repairFishOriginIssues(data).data;
  assert.equal(next.fishes[maleId].hungerAt, data.ops[maleId].t + CONFIG.hunger);
  await verifyReplica(next);
});

test('运动记录丢失起算时间时保留累计里程；鱼表键名损坏时保护仍有凭据的鱼', async () => {
  const { data, maleId, femaleId } = await signedFamily();
  data.travel[maleId] = { days: { '2023-11-14': 7 } };
  await assert.rejects(verifyReplica(data), /鱼运动记录/);
  const fixed = repairFishOriginIssues(data);
  assert.equal(fixed.changed, true);
  assert.deepEqual(fixed.data.travel[maleId], { since: data.fishes[maleId].created, days: data.travel[maleId].days });
  await verifyReplica(fixed.data);
  fixed.data.fishes['broken-key'] = fixed.data.fishes[femaleId];
  delete fixed.data.fishes[femaleId];
  const pruned = repairFishOriginIssues(fixed.data, {}, { mode: 'align_and_prune' });
  assert.equal(pruned.changed, false);
  assert.equal(pruned.remaining[0].repairable, 'blocked');
});

test('清理无来源亲鱼会处理子代及已转移鱼元的历史，保留另一亲鱼和消费凭据', async () => {
  const { data, maleId, femaleId, babyId, breedingId } = await signedFamily();
  delete data.ops[maleId];
  data.fishes[maleId] = null;
  const survivor = Object.values(data.chars).find(c => c.entity === femaleId);
  survivor.path.push({ reason: 'eat', target: maleId, t: data.tick }, { reason: 'eat', target: femaleId, t: data.tick + 500 });
  const repaired = repairFishOriginIssues(data, {}, { mode: 'align_and_prune' });
  assert.deepEqual(Object.keys(repaired.data.fishes), [femaleId]);
  assert.deepEqual(Object.keys(repaired.data.ops), [femaleId]);
  assert.equal(repaired.data.breeding[breedingId], undefined);
  assert.equal(repaired.data.travel[babyId], undefined);
  assert.deepEqual(repaired.data.chars[survivor.id].path.map(e => e.target), [femaleId]);
  assert(Object.values(repaired.data.chars).every(c => c.path.every(e => e.birth !== breedingId)));
  await verifyReplica(repaired.data);
  assert.equal(repairFishOriginIssues(repaired.data, {}, { mode: 'align_and_prune' }).changed, false);
});

test('鱼体损坏但仍有凭据时，清理模式保留该凭据及后代', () => {
  const { world, maleId, babyId } = buildWorldWithBornFish();
  const data = world.serialize();
  data.fishes[maleId] = null;
  const res = repairFishOriginIssues(data, {}, { mode: 'align_and_prune' });
  assert.equal(res.remaining[0].repairable, 'blocked');
  assert.equal(res.changed, false);
  assert(res.data.fishes[babyId]);
});

test('异步签名期间更新世界仍能得到对应同一时刻的可验证增量', async () => {
  const sender = await participant();
  const data = { world: { ops: {}, fishes: {} } };
  const sending = sender.makeEnvelope('world', data);
  data.world.ops.next = { t: Date.now() };
  const message = await sending;
  assert.deepEqual(message.body.world.ops, {});
  assert(await verifyEnvelope(message));
});

test('共享诊断摘要只含统计，不携带聊天、邀请码、身份或任意错误原文', () => {
  const privateText = 'PRIVATE-CONTENT';
  const report = { totalFishes: 4, safeRepairable: 1, orphanCount: 0, issues: [{ id: privateText, summary: privateText, reasons: ['actor_mismatch', privateText] }] };
  const summary = diagnosticSummary({ report, targetKind: 'checkpoint', verifyError: privateText, loaded: { checkpoint: privateText }, identity: { secret: privateText } },
    [{ level: 'error', source: privateText, message: privateText, detail: { actor: privateText, reasons: ['created_mismatch', privateText] } }]);
  assert.equal(JSON.stringify(summary).includes(privateText), false);
  assert.deepEqual(summary.scan.reasons, { actor_mismatch: 1 });
  assert.equal(summary.logs.error, 1);
  assert.deepEqual(summary.events[0].reasons, ['created_mismatch']);
  assert.equal(summary.scan.target, 'checkpoint');
  assert.equal(summary.scan.verified, false);
  assert.equal(diagnosticSummary({ state: 'empty' }, []).scan.state, 'empty');
  assert.deepEqual(diagnosticSummary({ state: 'archive_missing', verifyError: privateText }, []).scan, { state: 'archive_missing' });
});

test('只有签名操作的归档不遍历活鱼和鱼元，随包世界仍按已验证的操作核对', async () => {
  const { data, maleId } = await signedFamily();
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  records.ops[maleId] = data.ops[maleId];
  const chunk = await encodeArchive(records, data.roots);
  const incoming = { roots: data.roots, archives: { ...data.archives, chunks: { [chunk.manifest.id]: chunk.manifest } } };
  const current = { ...data, ops: {}, fishes: new Proxy(data.fishes, { ownKeys: () => assert.fail('归档遍历了活鱼') }),
    chars: new Proxy(data.chars, { ownKeys: () => assert.fail('归档遍历了鱼元') }) };
  let verified = false;
  await loadReplicaArchives(incoming, new ArchiveStore(), () => chunk.encoded, { current,
    beforeIngest(prior) { assert.deepEqual(prior.ops[maleId], records.ops[maleId]); verified = true; } });
  assert.equal(verified, true);
});

test('归档中的鱼依赖热存档的凭据，独立导入时只能使用本份备份', async () => {
  const { data, maleId } = await signedFamily();
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  records.fishes[maleId] = data.fishes[maleId];
  const chunk = await encodeArchive(records, data.roots);
  data.archives.chunks[chunk.manifest.id] = chunk.manifest;
  const load = id => id === chunk.manifest.id ? chunk.encoded : undefined;
  const store = new ArchiveStore();
  await loadReplicaArchives(data, store, load);
  await verifyReplica(data, await store.dependencies(data), store);
  await assert.rejects(loadReplicaArchives({ ...data, roots: {} }, store, load), /归档不属于/);
  await assert.rejects(loadReplicaArchives(data, new ArchiveStore(), () => undefined), /缺少归档/);
  const incomplete = clone(data); delete incomplete.ops[maleId]; delete incomplete.breeding;
  await assert.rejects(loadReplicaArchives(incomplete, new ArchiveStore(), load), /创建者/);
});

test('同一聊天在不同归档中的原文必须一致，冲突时整批归档不写入', async () => {
  const sender = await participant();
  const data = new World(Date.now(), undefined, { populate: false }).serialize();
  const chat = await sender.makeEnvelope('chat', { roots: Object.keys(data.roots), t: data.tick, nick: '甲', text: '一份记录' });
  const { signature, ...changed } = clone(chat);
  changed.body.text = '另一份记录';
  const other = { ...changed, signature: await sender.sign(changed) };
  const bundle = {};
  for (const [field, message] of [['chats', chat], ['chatSources', other]]) {
    const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
    records[field][chat.id] = message;
    const chunk = await encodeArchive(records, data.roots);
    data.archives.chunks[chunk.manifest.id] = chunk.manifest;
    bundle[chunk.manifest.id] = chunk.encoded;
  }
  const store = new ArchiveStore();
  let writes = 0;
  await assert.rejects(loadReplicaArchives(data, store, id => bundle[id], { persist: () => writes++ }), /已有聊天/);
  assert.equal(writes, 0);
  assert.deepEqual(store.manifests, {});
});

test('无关归档不阻断孤儿鱼诊断，归档自身引用的无效繁殖凭据仍会被拒绝', async () => {
  const { data, maleId, femaleId, babyId } = await signedFamily();
  delete data.ops[maleId];
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  records.ops[femaleId] = data.ops[femaleId];
  async function loadRecords() {
    const chunk = await encodeArchive(records, data.roots);
    data.archives.chunks = { [chunk.manifest.id]: chunk.manifest };
    const store = new ArchiveStore();
    await loadReplicaArchives(data, store, () => chunk.encoded);
    return store;
  }
  const store = await loadRecords();
  const extra = await store.dependencies(data);
  const repaired = repairFishOriginIssues(data, extra, { mode: 'align_and_prune' });
  assert.deepEqual(Object.keys(repaired.data.fishes), [femaleId]);
  await verifyReplica(repaired.data, extra, store);
  records.travel[babyId] = data.travel[babyId];
  await assert.rejects(loadRecords(), /归档繁殖凭据无效/);
});

test('分支在不同位置完成同一次出生，增量只带胜出凭据也能保留后续运动和一致路径', async () => {
  const { data: early, babyId, breedingId } = await signedFamily();
  const late = clone(early), record = late.breeding[breedingId];
  record.at += 500; record.baby.created = record.at;
  late.fishes[babyId].created = record.at;
  late.fishes[babyId].posAt = record.at + 2000;
  late.fishes[babyId].x += 5;
  late.travel[babyId].since = record.at;
  const right = Math.max(...record.baby.cells.map(c => c.x));
  for (const inherited of record.baby.cells) {
    inherited.x = right - inherited.x;
    const cell = late.chars[inherited.id];
    cell.x = cell.path.at(-1).x = inherited.x;
    cell.path.at(-1).t = record.at;
  }
  await verifyReplica(late);
  const merged = new World(early.tick, Object.keys(early.roots)[0], { populate: false });
  merged.merge(late);
  merged.merge({ ...early, chars: {}, ops: {} });
  const saved = merged.serialize();
  assert.equal(saved.fishes[babyId].created, early.fishes[babyId].created);
  assert.equal(saved.fishes[babyId].x, late.fishes[babyId].x);
  await verifyReplica(saved);
  for (const inherited of early.breeding[breedingId].baby.cells) {
    assert.equal(saved.chars[inherited.id].path.at(-1).x, inherited.x);
  }
});

test('鱼生验证只覆盖收到的消息和原有来源，等待期间更换世界、归档或创建凭据均重查', async () => {
  const world = new World(Date.now() - 1000), data = world.serialize();
  const [first, second] = Object.keys(world.data.fishes).sort();
  const key = first + '|' + second, at = data.tick;
  data.life.bonds[key] = { a: first, b: second, seconds: 1, at, lastNear: at, run: 0 };
  data.ops = {}; data.fishes = {}; data.chars = {};
  const archive = new ArchiveStore(), extra = {};
  const receipt = await verifyReplica(data, extra, archive, { current: world.data, mergeCut: true });
  const latest = Date.now() + 60000;
  assert(receipt(world.data, data, extra, latest));
  assert(!receipt(world.data, { ...data }, extra, latest));
  assert(!receipt(world.data, data, {}, latest));
  assert(!receipt({ ...world.data }, data, extra, latest));
  assert(!receipt(world.data, data, extra, 0));
  archive.revision = 1;
  assert(!receipt(world.data, data, extra, latest));
  const newer = await verifyReplica(data, extra, archive, { current: world.data, mergeCut: true });
  worldEdited(world);
  delete world.data.ops[first];
  assert.throws(() => world.merge(data, extra, 'replica', true, newer), /鱼生记录无效/);
});
