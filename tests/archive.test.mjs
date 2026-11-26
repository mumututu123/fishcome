import test from 'node:test';
import assert from 'node:assert/strict';
import { World, chooseClaim, clone } from '../www/engine.js';
import { ARCHIVE, ARCHIVE_FIELDS, ArchiveStore, archivePlan, archivePlanAsync, reachesArchiveThreshold, archiveChunks, encodeArchive, decodeArchive, assembleFragments, emptyArchiveState, mergeArchiveState, compactKnown } from '../www/archive.js';
import { newLife } from '../www/life.js';
import { fishCatalog } from '../www/fish-profile.js';
import { signer, actorId, verifyEnvelope } from '../www/storage.js';
import { Network } from '../www/network.js';
import { loadReplicaArchives, verifyReplica } from '../www/replica.js';
const now = Date.now(), old = now - 10 * 86400000, glyph = (x, y, ch = 'Q') => ({ x, y, ch, color: '#88aacc' });
test('分批检查归档大小保留 UTF-8 字节阈值和原有归档选择', async () => {
  const { w } = await fixture();
  w.data.participants['引号"'] = '鱼🌊';
  w.data.optional = undefined;
  const bytes = Buffer.byteLength(JSON.stringify(w.data));
  assert.equal(await reachesArchiveThreshold(w.data, bytes), true);
  assert.equal(await reachesArchiveThreshold(w.data, bytes + 1), false);
  assert.deepEqual(await archivePlanAsync(w.data, now, { pressure: true }), archivePlan(w.data, now, { pressure: true }));
});
const blank = () => Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}]));

test('并发吸收同一归档只更新一次余额、归档版本和起源索引', async () => {
  const store = new ArchiveStore();
  const roots = { [crypto.randomUUID()]: old };
  const id = 'account:referral';
  async function claim(t, inviter) {
    const records = blank();
    records.ops[id] = { id, kind: 'referral', actor: 'account', cost: 0, t, inviter };
    return encodeArchive(records, roots);
  }
  const later = await claim(old + 1, 'later'), first = await claim(old, 'first');
  await store.ingest(later, chooseClaim);
  await Promise.all([store.ingest(first, chooseClaim), store.ingest(first, chooseClaim)]);
  assert.equal(store.summary.ledger.first, 10);
  assert.equal(store.summary.ledger.later, 0);
  assert.equal(store.revision, 2);
  assert.deepEqual([...store.rootsByChunk.values()], [roots, roots]);
});

test('热记录未通过校验时，新归档不会写入磁盘或运行世界', async () => {
  const data = new World(now).serialize(), store = new ArchiveStore();
  const records = blank(), [id, op] = Object.entries(data.ops)[0];
  records.ops[id] = op;
  delete data.ops[id];
  data.fishes[id].actor += '-old';
  const chunk = await encodeArchive(records, data.roots);
  data.archives.chunks[chunk.manifest.id] = chunk.manifest;
  let writes = 0;
  await assert.rejects(loadReplicaArchives(data, store, () => chunk.encoded, {
    beforeIngest(extra, checked) {
      assert.deepEqual(extra.ops[id], op);
      assert.deepEqual(checked.ops[id], op);
      return verifyReplica(data, extra, store, { current: checked });
    },
    persist() { writes++; }
  }), /创建者/);
  assert.equal(writes, 0);
  assert.deepEqual(store.manifests, {});
});

test('提交前校验的重复归档记录与实际合流结果一致', async () => {
  const data = new World(now).serialize(), store = new ArchiveStore();
  const id = Object.keys(data.fishes)[0];
  async function travel(days) {
    const records = blank();
    records.travel[id] = { since: data.fishes[id].created, days };
    return encodeArchive(records, data.roots);
  }
  const oldChunk = await travel({ '2020-01-01': 7 });
  await store.ingest(oldChunk, chooseClaim);
  const left = await travel({ '2020-01-02': 2 }), right = await travel({ '2020-01-02': 1 });
  for (const chunk of [oldChunk, left, right]) data.archives.chunks[chunk.manifest.id] = chunk.manifest;
  let checked;
  await loadReplicaArchives(data, store, id => [left, right].find(chunk => chunk.manifest.id === id).encoded, {
    beforeIngest(extra) { checked = extra.travel[id]; }
  });
  assert.deepEqual(checked, await store.get('travel', id));
});

test('副本聊天须与合流后的世界有共同起源，沉积来源可来自其他世界', async () => {
  const owner = await identity(), sender = new Network(owner);
  sender.sign = await signer(owner);
  const world = new World(now).serialize();
  const root = crypto.randomUUID();
  const message = await sender.makeEnvelope('chat', { nick: '测试', text: '旧记忆', roots: [root], t: now });
  world.chats[message.id] = message;
  await assert.rejects(verifyReplica(world), /聊天不属于/);
  await verifyReplica(world, {}, undefined, { current: { roots: { [root]: now } } });
  delete world.chats[message.id];
  world.chatSources[message.id] = message;
  await verifyReplica(world);
});
async function identity() { const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']), pub = await crypto.subtle.exportKey('jwk', pair.publicKey), secret = await crypto.subtle.exportKey('jwk', pair.privateKey); return { actor: await actorId(pub), pub, secret, nick: '档案测试' }; }
async function fixture() {
  const owner = await identity(), w = new World(old, undefined, { populate: false, ambient: false }), sender = new Network(owner, {}, () => {}, () => {}); sender.sign = await signer(owner);
  async function apply(body, at = old) { const op = { id: body.kind === 'earn' ? `${owner.actor}:hour:${body.serial}` : crypto.randomUUID(), actor: owner.actor, nick: owner.nick, roots: w.roots, t: at, ...body }; assert(w.apply({ ...op, proof: await sender.makeEnvelope('op', op) }).ok); return op.id; }
  const dead = await apply({ kind: 'fish', x: 20, y: 20, name: '旧鱼', cells: [glyph(0, 0), glyph(1, 0)], cost: 2 }); w.starve(dead, old + 86400000);
  for (const c of w.fishCells(dead)) assert.fail('饥饿后不应留下鱼');
  for (const c of Object.values(w.data.chars)) if (c.kind === 'food') { c.kind = 'burn'; c.entity = ''; c.path.push({ id: `weathering:${c.id}`, reason: 'weathering', t: old + 2 * 86400000, target: '', x: c.x, y: c.y }); }
  await apply({ kind: 'earn', serial: 1, cost: 0 });
  w.data.life = newLife(now); const live = await apply({ kind: 'fish', x: 40, y: 20, name: '活鱼', cells: [glyph(0, 0), glyph(1, 0)], cost: 2 }, now);
  for (let i = 0; i < 100; i++) assert(w.addChat(await sender.makeEnvelope('chat', { nick: owner.nick, text: `旧聊${i}`, t: old + i, roots: w.roots })).ok);
  w.data.tick = now; return { w, owner, dead, live, sender };
}
async function pack(w) { const records = archivePlan(w.data, now), chunks = await archiveChunks(records, w.data.roots), store = new ArchiveStore(); for (const chunk of chunks) { await store.ingest(chunk, chooseClaim); w.data.archives.chunks[chunk.manifest.id] = chunk.manifest; } w.attachArchives(store); await compactKnown(w, store); return { store, chunks, records }; }

test('归档保留活实体依赖与最近80条聊天，只移动超过7天的结束记录', async () => {
  const { w, dead, live } = await fixture(), records = archivePlan(w.data, now); assert(records.ops[dead]); assert(!records.ops[live]); assert.equal(Object.keys(records.chats).length, 20); assert.equal(Object.keys(records.chars).length, 2); assert(!records.travel[live]);
});

test('容量压力可提前归档24小时前结束的记录，仍保护活鱼凭据与最近聊天', async () => {
  const { w, live } = await fixture(), at = now - 2 * 86400000, id = crypto.randomUUID();
  w.data.ops[id] = { id, actor: 'pressure', kind: 'earn', t: at, serial: 1, cost: 0 }; w.data.ops[live].t = at;
  for (const message of Object.values(w.data.chats)) message.body.t = at;
  assert(!archivePlan(w.data, now).ops[id]); const records = archivePlan(w.data, now, { pressure: true });
  assert(records.ops[id]); assert(!records.ops[live]); assert.equal(Object.keys(records.chats).length, 20);
});

test('异步读档期间成为活实体依赖的凭据不能被删除', async () => {
  const { w, dead } = await fixture(), chunks = await archiveChunks(archivePlan(w.data, now), w.data.roots), store = new ArchiveStore();
  for (const chunk of chunks) await store.ingest(chunk, chooseClaim);
  const get = store.get.bind(store); store.get = async (field, id) => { const record = await get(field, id); if (field === 'ops' && id === dead) w.data.fishes[dead] = { id: dead }; return record; };
  await compactKnown(w, store); assert(w.data.ops[dead]);
});

test('最近一餐只剩归档证据时，合流保留准确进食时间', async () => {
  const { w, live } = await fixture(), records = blank(), id = crypto.randomUUID(), at = now - 2 * 86400000;
  records.chars[id] = { id, kind: 'burn', created: at, path: [{ id: 'meal', reason: 'eat', target: live, t: at }] };
  const store = new ArchiveStore(); await store.ingest(await encodeArchive(records, w.data.roots), chooseClaim); w.attachArchives(store);
  w.data.fishes[live].created = old; w.data.fishes[live].lastFed = at; w.merge(w.serialize()); assert.equal(w.data.fishes[live].lastFed, at);
});
test('压缩内容哈希、目录和原始签名均保持一致', async () => {
  const { w, dead } = await fixture(), chunks = await archiveChunks(archivePlan(w.data, now), w.data.roots); assert(chunks.length);
  for (const chunk of chunks) { const raw = await decodeArchive(chunk.encoded, chunk.manifest); assert.deepEqual(raw, chunk.raw); for (const op of Object.values(raw.records.ops)) assert(await verifyEnvelope(op.proof)); }
  assert(chunks.some(chunk => chunk.raw.records.ops[dead]));
});
test('归档前后钱包、鱼谱和累计消费一致，重复加载不重复奖励', async () => {
  const { w, owner, dead, live } = await fixture(), before = w.wallet(owner.actor), { store, chunks } = await pack(w); assert.equal(w.wallet(owner.actor), before); assert(!w.data.ops[dead]); assert(w.data.ops[live]); assert(!Object.values(w.data.chars).some(c => c.kind === 'burn'));
  const catalog = fishCatalog(w.data); assert.equal(catalog.get(dead).name, '旧鱼'); assert(!catalog.get(dead).alive); assert(catalog.get(live).alive);
  for (const chunk of chunks) await store.ingest(chunk, chooseClaim); assert.equal(w.wallet(owner.actor), before);
});
test('旧快照不会复活已归档的消失字符，也不会重复消费或奖励', async () => {
  const { w, owner } = await fixture(), saved = w.serialize(), before = w.wallet(owner.actor), { store } = await pack(w);
  const extras = await store.dependencies(saved, w.data); w.merge(saved, extras); await compactKnown(w, store); assert.equal(w.wallet(owner.actor), before); assert.equal(Object.values(w.data.chars).filter(c => c.kind === 'burn').length, 0); assert.equal(Object.keys(w.data.chats).length, 80);
});
test('旧聊天可按需展开，日常状态和常规快照不携带归档正文', async () => {
  const { w } = await fixture(), { store } = await pack(w); const oldChats = await store.chats(100, w.data.chats, w.data.archives); assert.equal(Object.keys(oldChats).length, 100); assert.equal(Object.keys(w.data.chats).length, 80); const serialized = w.serialize(); assert(!serialized.archivedCatalog); assert(!serialized.archiveChunks); assert(Object.keys(serialized.archives.chunks).length);
});
test('编码后的档案与原始可变对象脱离，不受后续世界合流改变', async () => {
  const { w } = await fixture(), records = archivePlan(w.data, now), chunk = await encodeArchive(records, w.data.roots); w.data.roots[crypto.randomUUID()] = now; const op = Object.values(records.ops)[0]; op.nick = '修改后的名字'; assert.notEqual(Object.values(chunk.raw.records.ops)[0].nick, op.nick); assert.deepEqual(await decodeArchive(chunk.encoded, chunk.manifest), chunk.raw);
});
test('目录篡改、错误哈希和解压超限均拒绝', async () => {
  const { w } = await fixture(), chunk = await encodeArchive(archivePlan(w.data, now), w.data.roots);
  await assert.rejects(() => decodeArchive(chunk.encoded, { ...chunk.manifest, id: '0'.repeat(64) }), /哈希/);
  await assert.rejects(() => decodeArchive(chunk.encoded, { ...chunk.manifest, counts: { ...chunk.manifest.counts, ops: 999 } }), /目录/);
  await assert.rejects(() => decodeArchive(chunk.encoded, { ...chunk.manifest, rawSize: ARCHIVE.maxChunk + 1 }), /目录/);
  const bytes = await new Response(new Blob(['a'.repeat(ARCHIVE.maxChunk + 1)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); await assert.rejects(() => decodeArchive(Buffer.from(bytes).toString('base64'), { ...chunk.manifest, rawSize: 100 }), /超限/);
});
test('重算内容哈希不能让被修改的消费凭据获得有效签名', async () => {
  const { w } = await fixture(), records = clone(archivePlan(w.data, now)), op = Object.values(records.ops).find(op => op.kind === 'fish'); op.cost++; op.proof.body.cost++; const chunk = await encodeArchive(records, w.data.roots), raw = await decodeArchive(chunk.encoded, chunk.manifest); assert.equal(await verifyEnvelope(raw.records.ops[op.id].proof), false);
});
test('同一字符的分区历史按原有争食规则合流，顺序不改变最终归档事实', async () => {
  const root = crypto.randomUUID(), id = crypto.randomUUID(), records = blank(); records.chars[id] = { id, kind: 'burn', path: [{ id: `eat:${id}`, t: old, reason: 'eat', rank: 2, target: 'a' }, { id: 'burn', t: old + 1, reason: 'starve' }] };
  const a = await encodeArchive(records, { [root]: old }), changed = clone(records); changed.chars[id].path[0].rank = 3; changed.chars[id].path[0].target = 'b'; const b = await encodeArchive(changed, { [root]: old });
  const left = new ArchiveStore(), right = new ArchiveStore(); for (const chunk of [a, b]) await left.ingest(chunk, chooseClaim); for (const chunk of [b, a]) await right.ingest(chunk, chooseClaim);
  assert.deepEqual(await left.get('chars', id), await right.get('chars', id)); assert(left.summary.lastMeals.has('b')); assert(!left.summary.lastMeals.has('a'));
});
test('归档缓存有界，旧档案可以从持久存储重新读取', async () => {
  const files = new Map(), store = new ArchiveStore({ load: id => files.get(id) }); const root = crypto.randomUUID(); const ids = [];
  for (let i = 0; i < 6; i++) { const records = blank(), id = crypto.randomUUID(); ids.push(id); records.ops[id] = { id, actor: 'a', kind: 'food', cost: 1 }; const chunk = await encodeArchive(records, { [root]: old }); files.set(chunk.manifest.id, chunk.encoded); await store.ingest(chunk, chooseClaim); }
  assert(store.cache.size <= 4); assert(store.packs.size <= 4); assert.equal((await store.get('ops', ids[0])).cost, 1); assert.equal(store.summary.ledger.a, -6);
});
test('目录合流顺序无关，同哈希的目录不能被覆盖', async () => {
  const { w } = await fixture(), chunk = await encodeArchive(archivePlan(w.data, now), w.data.roots), a = { ...emptyArchiveState(old), chunks: { [chunk.manifest.id]: chunk.manifest } }, b = emptyArchiveState(now);
  assert.deepEqual(mergeArchiveState(a, b), mergeArchiveState(b, a)); assert.throws(() => mergeArchiveState(a, { ...a, chunks: { [chunk.manifest.id]: { ...chunk.manifest, rawSize: 1 } } }), /不可覆盖/);
});
test('大记录分片保留原签名，冷缓存淘汰后仍能重新组装', async () => {
  const { w, sender, owner } = await fixture(), records = blank(), id = `${owner.actor}:hour:2`, op = { id, actor: owner.actor, roots: w.roots, t: old, kind: 'earn', serial: 2, cost: 0, note: '完整的旧记录'.repeat(100000) }; records.ops[id] = { ...op, proof: await sender.makeEnvelope('op', op) };
  const chunks = await archiveChunks(records, w.data.roots); assert(chunks.length > 2); assert(chunks.every(c => c.manifest.rawSize <= ARCHIVE.maxChunk));
  const files = new Map(chunks.map(c => [c.manifest.id, c.encoded])), store = new ArchiveStore({ load: key => files.get(key) }); for (const chunk of chunks) await store.ingest(chunk, chooseClaim); store.cache.clear(); store.bigCache.clear();
  const original = await store.get('ops', id); assert.deepEqual(original, records.ops[id]); assert(await verifyEnvelope(original.proof)); assert.equal(store.summary.ledger[owner.actor], 1);
});
test('缺少任意大记录分片时不能归档原记录或形成余额索引', async () => {
  const { w, sender, owner } = await fixture(), records = blank(), id = `${owner.actor}:hour:2`, op = { id, actor: owner.actor, roots: w.roots, t: old, kind: 'earn', serial: 2, cost: 0, note: '旧'.repeat(200000) }; records.ops[id] = { ...op, proof: await sender.makeEnvelope('op', op) };
  const chunks = await archiveChunks(records, w.data.roots), decoded = await Promise.all(chunks.slice(1).map(async c => ({ manifest: c.manifest, raw: await decodeArchive(c.encoded, c.manifest) })));
  await assert.rejects(() => assembleFragments(decoded), /不完整/);
});
