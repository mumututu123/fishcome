import { CONFIG, chooseClaim, hash, validGlyph, validateOperation } from './engine.js';
import { verifyEnvelope } from './storage.js';
import { verifyReferral } from './referral.js';
import { CHAT_FLOOR, validChatMessage, chatGlyphs, chatColor, chatCellId } from './chat.js';
import { validTravel } from './fish-status.js';
import { HOUR, validWildCell } from './seaweed.js';
import { MINUTE, validBubble } from './bubbles.js';
import { fishOrigin, validBreedingRecord, inheritedGlyph } from './breeding.js';
import { validTerrain } from './geography.js';
import { validInitialOp, initialSources } from './genesis.js';
import { validateLife, validPlankton } from './life.js';
import { validEcology } from './ecology.js';
import { validLegends, validGhostCell } from './legends.js';
import { ARCHIVE_FIELDS, assembleFragments, decodeArchive, validArchiveState } from './archive.js';
import { buildOriginSources, inspectFishOrigin } from './diagnostics.js';

const opBody = op => { const { proof, ...body } = op; return body; };
export async function verifyChats(messages = {}, store, current = {}) {
  for (const [id, message] of Object.entries(messages)) {
    if (!validChatMessage(message) || id !== message.id) throw new Error('聊天记录无效');
    const known = [current.chats?.[id], current.chatSources?.[id]];
    for (const field of ['chats', 'chatSources']) if (store?.ids[field].has(id)) known.push(await store.get(field, id));
    const copies = known.filter(Boolean);
    if (copies.length) {
      const encoded = JSON.stringify(message);
      if (copies.some(copy => JSON.stringify(copy) !== encoded)) throw new Error('已有聊天记录不可覆盖');
    } else if (!await verifyEnvelope(message)) throw new Error('聊天签名无效');
  }
}
export async function verifyReplica(data, extra = {}, store, { current = {}, context: ctx = 'replica', diagnostics } = {}) {
  if (!data || data.protocol !== 1 || !data.roots || !data.chars || !data.fishes || !data.scenes || !data.ops || Object.keys(data.chars).length > 100000 || Object.keys(data.ops).length > 500000) throw new Error('世界快照不兼容或超出首版规模');
  if (data.terrain && !validTerrain(data.terrain, data.roots)) throw new Error('固定海底地形被修改或无效');
  if (!validEcology(data.ecology) || !validArchiveState(data.archives) || data.archives?.at > Date.now() + 60000) throw new Error('生态或归档时钟无效');
  for (const [root, at] of Object.entries(data.roots)) if (!/^[0-9a-f-]{36}$/i.test(root) || !Number.isFinite(at) || at < 0 || at > Date.now() + 60000) throw new Error('世界起源无效');
  for (const [root, at] of Object.entries(data.roots)) if (current.roots?.[root] !== undefined && current.roots?.[root] !== at) throw new Error('世界起源时间不能修改');
  const genesisSources = initialSources({ ...current.roots, ...data.roots });
  for (const [id, op] of Object.entries(data.ops)) {
    if (op.genesis !== undefined) { if (id !== op.id || !validInitialOp(op, genesisSources)) throw new Error('初始鱼记录被修改或无效'); continue; }
    const known = current.ops?.[id] || await store?.get('ops', id);
    if (known && JSON.stringify(known) === JSON.stringify(op)) continue;
    if (known && JSON.stringify(opBody(known)) !== JSON.stringify(opBody(op)) && !(op.kind === 'referral' && known.kind === 'referral')) throw new Error('已有消费记录不可覆盖');
    const { proof, ...clean } = op;
    if (id !== op.id || !proof || proof.kind !== 'op' || JSON.stringify(clean) !== JSON.stringify(proof.body) || proof.actor !== op.actor || !await verifyEnvelope(proof) || validateOperation(op, data.roots) || (op.kind === 'referral' && !await verifyReferral(op))) throw new Error('世界包含无效操作凭据');
  }
  if (data.seaweedHour !== undefined && (!Number.isInteger(data.seaweedHour) || data.seaweedHour < 0 || data.seaweedHour > Math.floor((Date.now() + 60000) / HOUR))) throw new Error('海草生长时钟无效');
  if (data.bubbleMinute !== undefined && (!Number.isInteger(data.bubbleMinute) || data.bubbleMinute < 0 || data.bubbleMinute > Math.floor((Date.now() + 60000) / MINUTE))) throw new Error('气泡生成时钟无效');
  if (data.bubbles !== undefined && (!data.bubbles || typeof data.bubbles !== 'object' || Array.isArray(data.bubbles) || Object.keys(data.bubbles).length > 200000)) throw new Error('气泡记录无效');
  const bubbleSources = { ...extra.chars, ...current.chars, ...data.chars };
  // Check branch-local structure here; reconcile the source's final history during merge.
  for (const [id, bubble] of Object.entries(data.bubbles || {})) if (id !== bubble.id || !validBubble(bubble, bubbleSources, false) || bubble.born > Date.now() + 60000) throw new Error('气泡缺少合法海草来源');
  await verifyChats(data.chats, store, current);
  await verifyChats(data.chatSources, store, { ...current, chats: { ...current.chats, ...data.chats } });
  const sources = buildOriginSources(data, extra, current);
  if (!validateLife(data.life, sources)) throw new Error('鱼生记录无效');
  if (!validLegends(data.legends, sources)) throw new Error('稀有异象记录无效');
  if (data.breeding !== undefined && (!data.breeding || typeof data.breeding !== 'object' || Array.isArray(data.breeding) || Object.keys(data.breeding).length > 500000)) throw new Error('繁殖记录无效');
  for (const [id, record] of Object.entries(data.breeding || {})) if (record.id !== id || !validBreedingRecord(record, sources) || record.at > Date.now() + 60000) throw new Error('繁殖记录缺少合法来源');
  if (data.contacts !== undefined && (!data.contacts || typeof data.contacts !== 'object' || Array.isArray(data.contacts) || Object.keys(data.contacts).length > 500000 || !Number.isFinite(data.contactAt) || data.contactAt > Date.now() + 60000)) throw new Error('接触计时无效');
  for (const [id, contact] of Object.entries(data.contacts || {})) if (id !== `${contact.male}|${contact.female}` || fishOrigin(sources, contact.male)?.gender !== 'male' || fishOrigin(sources, contact.female)?.gender !== 'female' || !Number.isFinite(contact.since) || !Number.isFinite(contact.lastAt) || contact.since < 0 || contact.since > contact.lastAt || contact.lastAt > data.contactAt) throw new Error('接触计时缺少合法来源');
  for (const [id, fish] of Object.entries(data.fishes)) {
    const issue = inspectFishOrigin(id, fish, sources);
    if (!issue.ok) {
      diagnostics?.record('error', ctx, '鱼的创建者记录无效', { ...issue, dataOps: Object.keys(data.ops || {}).length, extraOps: Object.keys(extra.ops || {}).length, dataBreeding: Object.keys(data.breeding || {}).length, extraBreeding: Object.keys(extra.breeding || {}).length });
      throw new Error('鱼的创建者记录无效');
    }
  }
  if (data.travel !== undefined && (!data.travel || typeof data.travel !== 'object' || Array.isArray(data.travel))) throw new Error('鱼运动记录无效');
  for (const [id, record] of Object.entries(data.travel || {})) {
    const source = fishOrigin(sources, id);
    if (!validTravel(record) || !source || record.since < source.created || record.since > Date.now() + 60000) {
      diagnostics?.record('error', ctx, '鱼运动记录缺少合法来源', { id, since: record?.since ?? null, sourceCreated: source?.created ?? null, hasSource: Boolean(source) });
      throw new Error('鱼运动记录缺少合法来源');
    }
  }
  const sourceGlyphs = new Map();
  for (const [id, c] of Object.entries(data.chars)) {
    if (id !== c.id) throw new Error('鱼元身份重复或被篡改');
    if (c.ecoGraceAt !== undefined && (!Number.isFinite(c.ecoGraceAt) || c.ecoGraceAt < c.created || c.ecoGraceAt > Date.now() + 60000)) throw new Error('海草更替过渡时间无效');
    if ((!c.chat && !validGlyph(c.ch)) || !/^#[0-9a-f]{6}$/i.test(c.color) || !Number.isInteger(c.x) || !Number.isInteger(c.y) || !Array.isArray(c.path) || c.path.length > 1024 || !['fish', 'scene', 'food', 'burn', 'seaweed'].includes(c.kind)) throw new Error('世界鱼元无效');
    const missingOwner = c.kind === 'fish' && !(data.fishes[c.entity] || current.fishes?.[c.entity] || extra.fishes?.[c.entity]);
    if (c.chat) {
      const message = data.chatSources?.[c.chat] || current.chatSources?.[c.chat] || extra.chatSources?.[c.chat] || extra.chats?.[c.chat], floor = data.scenes[CHAT_FLOOR] || current.scenes?.[CHAT_FLOOR] || extra.scenes?.[CHAT_FLOOR];
      if (message && !sourceGlyphs.has(c.chat)) sourceGlyphs.set(c.chat, new Map(chatGlyphs(message.body.text).map(glyph => [glyph.index, glyph.ch])));
      if (!message || id !== chatCellId(message, c.chatIndex) || sourceGlyphs.get(c.chat).get(c.chatIndex) !== c.ch || c.color !== chatColor(hash(message.actor)) || c.payer !== '' || c.kind !== 'scene' || c.entity !== CHAT_FLOOR || c.path.length || c.x < 0 || c.x >= CONFIG.width || c.y < 0 || c.y >= CONFIG.depth || floor?.x !== 0 || floor?.y !== 0 || !floor.fixed) throw new Error('聊天沉积缺少合法来源或被修改');
      continue;
    }
    if (c.ghost) {
      if (missingOwner || !validGhostCell(c, sources.roots) || !['scene', 'burn'].includes(c.kind) && inheritedGlyph(c, '蛆', sources) !== c.ch || c.created > Date.now() + 60000 || c.kind === 'fish' && !c.path.some(e => ['eat', 'birth'].includes(e.reason) && e.target === c.entity)) throw new Error('船蛆缺少合法幽灵船来源');
      continue;
    }
    if (c.plankton) {
      if (missingOwner || !validPlankton(c, sources.roots) || (!['scene', 'burn'].includes(c.kind) && inheritedGlyph(c, '*', sources) !== c.ch) || c.created > Date.now() + 60000 || (c.kind === 'fish' && !c.path.some(event => ['eat', 'birth'].includes(event.reason) && event.target === c.entity))) throw new Error('浮游食物缺少合法生态来源');
      continue;
    }
    if (c.wild || c.kind === 'seaweed') {
      if (missingOwner || !validWildCell(c, CONFIG, hash, genesisSources) || (!['scene', 'burn'].includes(c.kind) && inheritedGlyph(c, '草', sources) !== c.ch) || c.created > Date.now() + 60000 || (c.kind === 'fish' && !c.path.some(event => ['eat', 'birth'].includes(event.reason) && event.target === c.entity))) throw new Error('海草缺少合法生态来源');
      continue;
    }
    if (missingOwner) throw new Error('鱼元缺少所属的鱼');
    const source = data.ops[c.id.slice(0, 36)] || current.ops?.[c.id.slice(0, 36)] || extra.ops?.[c.id.slice(0, 36)], index = +c.id.slice(37);
    const initial = source?.kind === 'food' && c.id === source.id ? source : ['fish', 'scene'].includes(source?.kind) ? source.cells[index] : source?.kind === 'sceneScale' && source.factor === 2 && Number.isInteger(index) && index >= 0 && index < source.cost * 4 / 3 && index % 4 !== 0 ? c : null;
    if (!initial || source.actor !== c.payer) throw new Error('鱼元缺少合法消费凭据');
    if (c.kind === 'fish' || c.kind === 'food') { if (!['food', 'fish'].includes(source.kind) || inheritedGlyph(c, initial.ch, sources) !== c.ch || initial.color !== c.color) throw new Error('鱼鱼元只能由合法创建与生态流转生成'); if (c.kind === 'fish' && !c.path.length && (c.entity !== source.id || c.x !== initial.x || c.y !== initial.y)) throw new Error('禁止人工重排已投放的鱼'); }
  }
}

async function verifyArchivedOps(ops, roots, scope = roots) {
  const initial = initialSources(roots);
  for (const [id, op] of Object.entries(ops)) {
    if (op.roots !== undefined && (!Array.isArray(op.roots) || !op.roots.some(root => scope[root] !== undefined))) throw new Error('归档操作不属于这个世界');
    if (op.genesis !== undefined) { if (id !== op.id || !validInitialOp(op, initial)) throw new Error('归档初始鱼凭据无效'); continue; }
    const { proof, ...clean } = op;
    if (id !== op.id || !proof || proof.kind !== 'op' || JSON.stringify(clean) !== JSON.stringify(proof.body) || proof.actor !== op.actor || !await verifyEnvelope(proof) || validateOperation(op, roots) || op.kind === 'referral' && !await verifyReferral(op)) throw new Error('归档操作签名或凭据无效');
  }
}
// A damaged live fish can be repaired if no archived record relies on its certificate.
function verifyArchiveBirthSources(chunks, sources) {
  const needed = new Set();
  const addFish = id => { if (typeof id === 'string' && id.startsWith('born:')) needed.add(id.slice(5)); };
  for (const chunk of chunks) {
    const records = chunk.logical || chunk.raw.records;
    for (const id of Object.keys(records.fishes)) addFish(id);
    for (const id of Object.keys(records.travel)) addFish(id);
    for (const record of Object.values(records.breeding)) { addFish(record?.male); addFish(record?.female); }
    for (const cell of Object.values(records.chars)) {
      if (cell?.kind === 'fish') addFish(cell.entity);
      for (const step of cell?.path || []) if (step?.reason === 'birth') needed.add(step.birth);
    }
  }
  for (const id of needed) {
    const record = sources.breeding[id];
    if (!record) continue; // Missing sources are reported by the referring record's validator.
    if (record.id !== id || !validBreedingRecord(record, sources)) throw new Error('归档繁殖凭据无效');
    addFish(record.male);
    addFish(record.female);
  }
}

export async function loadReplicaArchives(data, target, load, { current = {}, persist, diagnostics } = {}) {
  if (!validArchiveState(data.archives)) throw new Error('归档目录无效');
  const chunks = [];
  for (const [id, manifest] of Object.entries(data.archives?.chunks || {})) {
    const existing = target.manifests[id];
    if (existing && JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('已有归档目录不可覆盖');
    let roots = target.rootsByChunk.get(id);
    if (!existing) {
      const encoded = await load(id);
      if (!encoded) throw Object.assign(new Error('备份或本地记忆缺少归档文件'), { code: 'archive_missing' });
      const raw = await decodeArchive(encoded, manifest);
      chunks.push({ encoded, manifest, raw });
      roots = raw.roots;
    }
    for (const [root, at] of Object.entries(roots)) if (data.roots[root] !== at) throw new Error('归档不属于这个世界');
  }
  if (!chunks.length) return;
  await assembleFragments(chunks, data.archives, async id => ({ manifest: target.manifests[id], raw: await target.raw(id) }));
  const pool = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])); for (const chunk of chunks) for (const field of ARCHIVE_FIELDS) Object.assign(pool[field], (chunk.logical || chunk.raw.records)[field]);
  const prior = await target.dependencies({ ...data, ...Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, { ...data[f], ...pool[f] }])) }, current);
  const sources = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, { ...prior[f], ...current[f], ...pool[f], ...data[f] }]));
  await verifyArchivedOps({ ...pool.ops, ...data.ops }, { ...current.roots, ...data.roots }, data.roots);
  verifyArchiveBirthSources(chunks, sources);
  // Records in this batch become trusted only after their own signatures have passed.
  const checked = { ...current, chats: { ...current.chats }, ops: { ...current.ops } };
  for (const chunk of chunks) {
    const records = chunk.logical || chunk.raw.records;
    await verifyReplica({ protocol: 1, roots: data.roots, ...records }, sources, target, { current: checked, diagnostics, context: 'archive' });
    Object.assign(checked.chats, records.chats, records.chatSources);
    Object.assign(checked.ops, records.ops);
  }
  await verifyChats(data.chats, target, checked);
  await verifyChats(data.chatSources, target, { ...checked, chats: { ...checked.chats, ...data.chats } });
  if (persist) await persist(chunks);
  for (const chunk of chunks) await target.ingest(chunk, chooseClaim);
}
