import { World, CONFIG, clone, EYES, bounds, validGlyph, displayNick, hash, sceneryCount, chooseClaim } from './engine.js';
import { get, set, putMany, newIdentity, verifyEnvelope, actorId, download } from './storage.js';
import { Network } from './network.js';
import { Renderer } from './renderer.js';
import { Creator } from './creator.js';
import { restoreCheckpoint } from './lifecycle.js';
import { CHAT_FLOOR, validChatMessage, orderedChats, chatGlyphs, chatColor, chatCellId, mergeChatRecords } from './chat.js';
import { DAY, shanghaiDay, validTravel } from './fish-status.js';
import { HOUR, validWildCell } from './seaweed.js';
import { MINUTE, validBubble } from './bubbles.js';
import { fishOrigin, validBreedingRecord, inheritedGlyph } from './breeding.js';
import { defaultFishName, displayFishName, fishCatalog } from './fish-profile.js';
import { drawPedigree } from './pedigree.js';
import { normalizeInvite, encodeInvite, decodeInvite, inviteDetails } from './invite.js';
import { verifyReferral } from './referral.js';
import { wrapX, nearX, validTerrain } from './geography.js';
import { initialSources, validInitialOp } from './genesis.js';
import { validateLife, validPlankton, weatherAt, fishLifeText, storiesFor, storyText, returnStory } from './life.js';
import { validEcology } from './ecology.js';
import { memoryForCell, ancestralGlyph, ancestralText } from './easter-eggs.js';
import { activeEvent, eventSchedule, eventTitle, eventPosition, eventLetter, radioTranscript, eventNarration } from './random-events.js';
import { activeLegend, legendSchedule, legendTitle, legendPosition, validLegends, validGhostCell, capturedFish } from './legends.js';
import { ARCHIVE, ARCHIVE_FIELDS, ArchiveStore, archivePlan, archiveChunks, decodeArchive, assembleFragments, validArchiveState, emptyArchiveState, mergeArchiveState, compactKnown } from './archive.js';
const $ = id => document.getElementById(id);
const renderer = new Renderer($('sea'));
let world = new World(undefined, undefined, { populate: false }), identity, network, meta, creator, mode = null, selected = null, dragging, histories = {}, known = [], members = new Map(), pending = new Map(), inbox = new Map(), lastPicture = null, priorCheckpoint = null;
let chatLimit = 80, renderedChatWorld, renderedChatCount = -1, renderedChatLimit = -1;
let trackedFish = null, followBounds = null, myFishListKey = '';
let referralBusy = false;
const myFishCards = new Map();
let lifeSince = Date.now(), returnVisit = false, lifeMessage = null;
let myFishView = 'list', pedigreeFish = null, pedigreeKey = '';
const fishDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
let lastSnapshot = 0, snapshotBusy = false, lastHello = new Set(), lastMeter = Date.now(), lastSave = 0, lastPictureTime = 0, lastChat = 0, selfBeat = 0, lastLeader = '', status = '', started = false, lastRepair = 0;
let lastFull = 0, sentOps = new Set(), sentChars = new Map(), sentChats = new Set(), sentChatSources = new Set(), sentTravel = new Map();
let geometryRepair = false, fishRepairWaiting = 0;
function newArchiveStore() { return new ArchiveStore({ load: id => get('archive:' + id) }); }
let archiveStore = newArchiveStore(), archiveBusy = false, archiveCheckAt = 0, olderChats = {};
const archiveWaiters = new Map(), archiveRequests = new Map(), historyArchiveStores = new Map();
let resumeTask;
let archiveView;
const rejectedOps = new Set();
function rejectOperation(id) { rejectedOps.add(id); inbox.delete(id); }
let lastOnlineAt = Date.now();
const historyQueues = new Map();
const opBody = op => { const { proof, ...body } = op; return body; };
function authorNick(actor, fallback) { return actor === identity?.actor ? identity.nick : active().find(member => member.actor === actor)?.nick || world.data.participants[actor] || displayNick(fallback) || '匿名'; }
function rememberAuthor(actor, nick) { if (typeof nick === 'string' && world.data.participants[actor] !== nick) { world.data.participants[actor] = nick; renderedChatCount = -1; renderChat(); } }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000); }
function member() { return { id: network.node, actor: identity.actor, nick: displayNick(identity.nick), url: meta.url, at: Date.now(), visible: !document.hidden, peers: network.live().length }; }
function active() { return [...members.values()].filter(m => Date.now() - m.at < 120000); }
function leader() { return active().sort((a, b) => +b.visible - +a.visible || a.id.localeCompare(b.id))[0]?.id || network.node; }
function amLeader() { return !!network && leader() === network.node; }
function pendingCost() { return [...pending.values()].reduce((n, p) => n + (p.cost || 0), 0); }
function balance() { return identity ? world.wallet(identity.actor) - pendingCost() : 20; }
function update() {
  if (!identity) return; const count = world.counts(); $('online').textContent = new Set(active().map(m => m.actor)).size || 1; $('fishCount').textContent = count.fish; $('sceneCount').textContent = count.scene; $('balance').textContent = balance();
  const remain = Math.max(0, 3600 - Math.floor(identity.remainder || 0)); $('hourProgress').textContent = `下一鱼元 ${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
  $('worldLabel').textContent = world.roots.length > 1 ? `合流之海 · ${world.roots.length} 个起源` : '新生的海'; $('networkStatus').textContent = status || (network.live().length ? `伙伴已接入 · 世界由浏览器共同维持` : '独自在线，也可以开始创作');
  if (world.data.pendingChatGlyphs) $('networkStatus').textContent += ` · ${world.data.pendingChatGlyphs} 个聊天鱼元等待海底空位`;
  $('depthLabel').textContent = `水深 ${Math.max(0, Math.round(renderer.camera.y))} 格 · ${renderer.camera.y < CONFIG.shallow ? '浅水区' : '深水区'}`; $('zoomLabel').textContent = Math.round(renderer.scale * 100) + '%';
  $('networkDetails').textContent = `直连邻居 ${network.live().length}/8 · 已收 ${(network.stats.received / 1024).toFixed(0)} KB · 已发 ${(network.stats.sent / 1024).toFixed(0)} KB`;
  if ($('foodDialog').open) updateFoodBrush();
  if ($('creatorDialog').open) creator?.render();
  if ($('myFishDialog').open) renderMyFishes();
  if (selected) inspect(selected, false);
  renderLife();
}
async function remember(url) { try { if (!url) return; url = await normalizeInvite(url); if (url === meta?.url) return; if (!known.includes(url)) { known.push(url); set('known', known).catch(() => {}); } } catch { } }
function syncIncomeSerial() { identity.serial = Math.max(identity.serial || 0, archiveStore.summary.serials[identity.actor] || 0); for (const op of Object.values(world.data.ops)) if (op.kind === 'earn' && op.actor === identity.actor) identity.serial = Math.max(identity.serial || 0, op.serial); }
async function requestArchive(id, peer) {
  if (archiveRequests.has(id)) return archiveRequests.get(id);
  const task = (async () => {
    for (const p of [peer, ...network.live().filter(p => p !== peer)].filter(Boolean).slice(0, 3)) {
      try { return await new Promise((resolve, reject) => { const timer = setTimeout(() => { archiveWaiters.delete(id); reject(new Error('历史归档补齐超时')); }, 15000); archiveWaiters.set(id, { peer: p.node, resolve: value => { clearTimeout(timer); archiveWaiters.delete(id); resolve(value); }, reject: error => { clearTimeout(timer); archiveWaiters.delete(id); reject(error); } }); network.direct(p, 'archiveRequest', { id }).catch(error => archiveWaiters.get(id)?.reject(error)); }); } catch { }
    }
    throw new Error('缺少历史归档，等待持有记忆的伙伴重新接入');
  })(); archiveRequests.set(id, task); try { return await task; } finally { archiveRequests.delete(id); }
}
async function verifyArchivedOps(ops, roots, scope = roots) {
  const initial = initialSources(roots);
  for (const [id, op] of Object.entries(ops)) {
    if (op.roots !== undefined && (!Array.isArray(op.roots) || !op.roots.some(root => scope[root] !== undefined))) throw new Error('归档操作不属于这个世界');
    if (op.genesis !== undefined) { if (id !== op.id || !validInitialOp(op, initial)) throw new Error('归档初始鱼凭据无效'); continue; }
    const { proof, ...clean } = op;
    if (id !== op.id || !proof || proof.kind !== 'op' || JSON.stringify(clean) !== JSON.stringify(proof.body) || proof.actor !== op.actor || !await verifyEnvelope(proof) || world.validOp(op) || op.kind === 'referral' && !await verifyReferral(op)) throw new Error('归档操作签名或凭据无效');
  }
}
async function ensureArchives(data, peer, bundle, target = archiveStore) {
  if (!validArchiveState(data.archives)) throw new Error('归档目录无效');
  const chunks = [];
  for (const [id, manifest] of Object.entries(data.archives?.chunks || {})) {
    if (target.manifests[id]) { if (JSON.stringify(target.manifests[id]) !== JSON.stringify(manifest)) throw new Error('已有归档目录不可覆盖'); continue; }
    const encoded = bundle?.[id] || await get('archive:' + id) || (peer ? await requestArchive(id, peer) : null); if (!encoded) throw new Error('备份或本地记忆缺少归档文件');
    const raw = await decodeArchive(encoded, manifest); for (const [root, at] of Object.entries(raw.roots)) if (data.roots[root] !== at) throw new Error('归档不属于这个世界'); chunks.push({ encoded, manifest, raw });
  }
  if (!chunks.length) return;
  await assembleFragments(chunks, data.archives, async id => ({ manifest: target.manifests[id], raw: await target.raw(id) }));
  const pool = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])); for (const chunk of chunks) for (const field of ARCHIVE_FIELDS) Object.assign(pool[field], (chunk.logical || chunk.raw.records)[field]);
  const prior = await target.dependencies({ ...data, ...Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, { ...data[f], ...pool[f] }])) }, world.data);
  const sources = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, { ...prior[f], ...world.data[f], ...pool[f], ...data[f] }]));
  await verifyArchivedOps({ ...pool.ops, ...data.ops }, { ...world.data.roots, ...data.roots }, data.roots);
  for (const record of Object.values(sources.breeding)) if (!validBreedingRecord(record, sources)) throw new Error('归档繁殖凭据无效');
  for (const chunk of chunks) await verifyReplica({ protocol: 1, roots: data.roots, ...(chunk.logical || chunk.raw.records) }, sources, target);
  await putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded]));
  for (const chunk of chunks) await target.ingest(chunk, chooseClaim);
}
async function archiveWorld(now = Date.now()) {
  if (archiveBusy || !amLeader() || now - archiveCheckAt < 60000) return; archiveCheckAt = now;
  const pressure = new TextEncoder().encode(JSON.stringify(world.data)).length >= ARCHIVE.threshold;
  if (now - (world.data.archives?.at || 0) < ARCHIVE.period && !pressure) return;
  archiveBusy = true; const target = world, store = archiveStore;
  try {
    const plan = archivePlan(target.data, now, { pressure }), chunks = await archiveChunks(plan, target.data.roots);
    await putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded])); if (world !== target) return;
    for (const chunk of chunks) { await store.ingest(chunk, chooseClaim); target.data.archives ||= emptyArchiveState(); target.data.archives.chunks[chunk.manifest.id] = chunk.manifest; }
    await compactKnown(target, store); if (world !== target || archiveStore !== store) return;
    target.data.archives.at = now; target.dirty = true; target.foodRevision++; target.attachArchives(store); lastFull = 0;
    await save(); await broadcastWorld(); renderChat();
  } catch (error) { status = '记忆整理稍后重试：' + error.message; } finally { archiveBusy = false; }
}
async function requestHistory(peer) { const ids = (historyQueues.get(peer.id) || []).filter(id => !histories[id]); historyQueues.set(peer.id, ids); if (ids.length) await network.direct(peer, 'historyRequest', { ids: ids.slice(0, 32) }); else historyQueues.delete(peer.id); }
async function verifyChats(messages = {}, store = archiveStore) {
  for (const [id, message] of Object.entries(messages)) {
    if (id !== message.id || !validChatMessage(message)) throw new Error('聊天记录无效');
    const known = world.data.chats[id] || world.data.chatSources[id] || await store.get('chats', id);
    if (known) { if (JSON.stringify(known) !== JSON.stringify(message)) throw new Error('已有聊天记录不可覆盖'); }
    else if (!await verifyEnvelope(message)) throw new Error('聊天签名无效');
  }
}
async function verifyReplica(data, extra = {}, store = archiveStore) {
  if (!data || data.protocol !== 1 || !data.roots || !data.chars || !data.fishes || !data.scenes || !data.ops || Object.keys(data.chars).length > 100000 || Object.keys(data.ops).length > 500000) throw new Error('世界快照不兼容或超出首版规模');
  if (data.terrain && !validTerrain(data.terrain, data.roots)) throw new Error('固定海底地形被修改或无效');
  if (!validEcology(data.ecology) || !validArchiveState(data.archives) || data.archives?.at > Date.now() + 60000) throw new Error('生态或归档时钟无效');
  for (const [root, at] of Object.entries(data.roots)) if (!/^[0-9a-f-]{36}$/i.test(root) || !Number.isFinite(at) || at < 0 || at > Date.now() + 60000) throw new Error('世界起源无效');
  for (const [root, at] of Object.entries(data.roots)) if (world.data.roots[root] !== undefined && world.data.roots[root] !== at) throw new Error('世界起源时间不能修改');
  const genesisSources = initialSources({ ...world.data.roots, ...data.roots });
  for (const [id, op] of Object.entries(data.ops)) {
    if (op.genesis !== undefined) { if (id !== op.id || !validInitialOp(op, genesisSources)) throw new Error('初始鱼记录被修改或无效'); continue; }
    const known = world.data.ops[id] || await store.get('ops', id);
    if (known && JSON.stringify(opBody(known)) === JSON.stringify(opBody(op))) continue;
    if (known && !(op.kind === 'referral' && known.kind === 'referral')) throw new Error('已有消费记录不可覆盖');
    const { proof, ...clean } = op;
    if (id !== op.id || !proof || proof.kind !== 'op' || JSON.stringify(clean) !== JSON.stringify(proof.body) || proof.actor !== op.actor || !await verifyEnvelope(proof) || world.validOp(op) || (op.kind === 'referral' && !await verifyReferral(op))) throw new Error('世界包含无效操作凭据');
  }
  if (data.seaweedHour !== undefined && (!Number.isInteger(data.seaweedHour) || data.seaweedHour < 0 || data.seaweedHour > Math.floor((Date.now() + 60000) / HOUR))) throw new Error('海草生长时钟无效');
  if (data.bubbleMinute !== undefined && (!Number.isInteger(data.bubbleMinute) || data.bubbleMinute < 0 || data.bubbleMinute > Math.floor((Date.now() + 60000) / MINUTE))) throw new Error('气泡生成时钟无效');
  if (data.bubbles !== undefined && (!data.bubbles || typeof data.bubbles !== 'object' || Array.isArray(data.bubbles) || Object.keys(data.bubbles).length > 200000)) throw new Error('气泡记录无效');
  const bubbleSources = { ...extra.chars, ...world.data.chars, ...data.chars };
  // Check branch-local structure here; reconcile the source's final history during merge.
  for (const [id, bubble] of Object.entries(data.bubbles || {})) if (id !== bubble.id || !validBubble(bubble, bubbleSources, false) || bubble.born > Date.now() + 60000) throw new Error('气泡缺少合法海草来源');
  await verifyChats(data.chats, store); await verifyChats(data.chatSources, store);
  const sources = { ops: { ...extra.ops, ...world.data.ops, ...data.ops }, breeding: { ...extra.breeding, ...world.data.breeding, ...data.breeding }, roots: { ...world.data.roots, ...data.roots }, chars: { ...extra.chars, ...world.data.chars, ...data.chars } };
  if (!validateLife(data.life, sources)) throw new Error('鱼生记录无效');
  if (!validLegends(data.legends, sources)) throw new Error('稀有异象记录无效');
  if (data.breeding !== undefined && (!data.breeding || typeof data.breeding !== 'object' || Array.isArray(data.breeding) || Object.keys(data.breeding).length > 500000)) throw new Error('繁殖记录无效');
  for (const [id, record] of Object.entries(data.breeding || {})) if (record.id !== id || !validBreedingRecord(record, sources) || record.at > Date.now() + 60000) throw new Error('繁殖记录缺少合法来源');
  if (data.contacts !== undefined && (!data.contacts || typeof data.contacts !== 'object' || Array.isArray(data.contacts) || Object.keys(data.contacts).length > 500000 || !Number.isFinite(data.contactAt) || data.contactAt > Date.now() + 60000)) throw new Error('接触计时无效');
  for (const [id, contact] of Object.entries(data.contacts || {})) if (id !== `${contact.male}|${contact.female}` || fishOrigin(sources, contact.male)?.gender !== 'male' || fishOrigin(sources, contact.female)?.gender !== 'female' || !Number.isFinite(contact.since) || !Number.isFinite(contact.lastAt) || contact.since < 0 || contact.since > contact.lastAt || contact.lastAt > data.contactAt) throw new Error('接触计时缺少合法来源');
  for (const [id, fish] of Object.entries(data.fishes)) { const source = fishOrigin(sources, id); if (fish.id !== id || !source || fish.actor !== source.actor || fish.created !== source.created || (fish.birth && sources.breeding[fish.birth]?.baby?.id !== id)) throw new Error('鱼的创建者记录无效'); }
  if (data.travel !== undefined && (!data.travel || typeof data.travel !== 'object' || Array.isArray(data.travel))) throw new Error('鱼运动记录无效');
  for (const [id, record] of Object.entries(data.travel || {})) { const source = fishOrigin(sources, id); if (!validTravel(record) || !source || record.since < source.created || record.since > Date.now() + 60000) throw new Error('鱼运动记录缺少合法来源'); }
  const sourceGlyphs = new Map();
  for (const [id, c] of Object.entries(data.chars)) {
    if (id !== c.id) throw new Error('鱼元身份重复或被篡改');
    if (c.ecoGraceAt !== undefined && (!Number.isFinite(c.ecoGraceAt) || c.ecoGraceAt < c.created || c.ecoGraceAt > Date.now() + 60000)) throw new Error('海草更替过渡时间无效');
    if ((!c.chat && !validGlyph(c.ch)) || !/^#[0-9a-f]{6}$/i.test(c.color) || !Number.isInteger(c.x) || !Number.isInteger(c.y) || !Array.isArray(c.path) || c.path.length > 1024 || !['fish', 'scene', 'food', 'burn', 'seaweed'].includes(c.kind)) throw new Error('世界鱼元无效');
    if (c.chat) {
      const message = data.chatSources?.[c.chat] || world.data.chatSources[c.chat] || extra.chatSources?.[c.chat] || extra.chats?.[c.chat], floor = data.scenes[CHAT_FLOOR] || world.data.scenes[CHAT_FLOOR] || extra.scenes?.[CHAT_FLOOR];
      if (message && !sourceGlyphs.has(c.chat)) sourceGlyphs.set(c.chat, new Map(chatGlyphs(message.body.text).map(glyph => [glyph.index, glyph.ch])));
      if (!message || id !== chatCellId(message, c.chatIndex) || sourceGlyphs.get(c.chat).get(c.chatIndex) !== c.ch || c.color !== chatColor(hash(message.actor)) || c.payer !== '' || c.kind !== 'scene' || c.entity !== CHAT_FLOOR || c.path.length || c.x < 0 || c.x >= CONFIG.width || c.y < 0 || c.y >= CONFIG.depth || floor?.x !== 0 || floor?.y !== 0 || !floor.fixed) throw new Error('聊天沉积缺少合法来源或被修改');
      continue;
    }
    if (c.ghost) {
      if (!validGhostCell(c, sources.roots) || !['scene', 'burn'].includes(c.kind) && inheritedGlyph(c, '蛆', sources) !== c.ch || c.created > Date.now() + 60000 || c.kind === 'fish' && (!c.path.some(e => ['eat', 'birth'].includes(e.reason) && e.target === c.entity) || !(data.fishes[c.entity] || world.data.fishes[c.entity] || extra.fishes?.[c.entity]))) throw new Error('船蛆缺少合法幽灵船来源');
      continue;
    }
    if (c.plankton) {
      if (!validPlankton(c, sources.roots) || (!['scene', 'burn'].includes(c.kind) && inheritedGlyph(c, '*', sources) !== c.ch) || c.created > Date.now() + 60000 || (c.kind === 'fish' && (!c.path.some(event => ['eat', 'birth'].includes(event.reason) && event.target === c.entity) || !(data.fishes[c.entity] || world.data.fishes[c.entity] || extra.fishes?.[c.entity])))) throw new Error('浮游食物缺少合法生态来源');
      continue;
    }
    if (c.wild || c.kind === 'seaweed') {
      if (!validWildCell(c, CONFIG, hash, genesisSources) || (!['scene', 'burn'].includes(c.kind) && inheritedGlyph(c, '草', sources) !== c.ch) || c.created > Date.now() + 60000 || (c.kind === 'fish' && (!c.path.some(event => ['eat', 'birth'].includes(event.reason) && event.target === c.entity) || !(data.fishes[c.entity] || world.data.fishes[c.entity] || extra.fishes?.[c.entity])))) throw new Error('海草缺少合法生态来源');
      continue;
    }
    const source = data.ops[c.id.slice(0, 36)] || world.data.ops[c.id.slice(0, 36)] || extra.ops?.[c.id.slice(0, 36)], index = +c.id.slice(37);
    const initial = source?.kind === 'food' && c.id === source.id ? source : ['fish', 'scene'].includes(source?.kind) ? source.cells[index] : source?.kind === 'sceneScale' && source.factor === 2 && Number.isInteger(index) && index >= 0 && index < source.cost * 4 / 3 && index % 4 !== 0 ? c : null;
    if (!initial || source.actor !== c.payer) throw new Error('鱼元缺少合法消费凭据');
    if (c.kind === 'fish' || c.kind === 'food') { if (!['food', 'fish'].includes(source.kind) || inheritedGlyph(c, initial.ch, sources) !== c.ch || initial.color !== c.color) throw new Error('鱼鱼元只能由合法创建与生态流转生成'); if (c.kind === 'fish' && !c.path.length && (c.entity !== source.id || c.x !== initial.x || c.y !== initial.y)) throw new Error('禁止人工重排已投放的鱼'); }
  }
}
async function mergeReplica(data, peer) {
  await ensureArchives(data, peer); const archived = await archiveStore.dependencies(data, world.data);
  await verifyReplica(data, archived); const previousTerrain = world.data.terrain.seed; world.merge(data, archived); world.attachArchives(archiveStore); await compactKnown(world, archiveStore); if (world.data.terrain.seed !== previousTerrain) geometryRepair = true;
  for (const member of active()) world.data.participants[member.actor] = member.nick; if (identity) world.data.participants[identity.actor] = identity.nick;
  // An expired local copy can be restored only after hearing its roots from a live peer.
  const checkpoint = priorCheckpoint; let recovered = false;
  if (checkpoint?.world?.roots && Object.keys(checkpoint.world.roots).some(r => world.roots.includes(r))) {
    await ensureArchives(checkpoint.world, peer); const older = await archiveStore.dependencies(checkpoint.world, world.data); await verifyReplica(checkpoint.world, older); world.merge(checkpoint.world, older); world.attachArchives(archiveStore); if (priorCheckpoint === checkpoint) priorCheckpoint = null;
    recovered = true;
  }
  reconcileHistory(); syncIncomeSerial(); await save(); renderChat();
  if (recovered) await network.broadcast('merge', { world: world.serialize() });
}
function resumeAfterInactivity(now = Date.now()) { if (!resumeTask) resumeTask = resumeWorld(now).finally(() => { resumeTask = null; }); return resumeTask; }
async function resumeWorld(now) {
  const elapsed = now - lastOnlineAt;
  if (elapsed > 120000) {
    const checkpoint = { world: world.serialize(), picture: lastPicture || localPicture(), lastOnlineAt };
    if (now - lastOnlineAt >= CONFIG.offlineLife) checkpoint.world.chats = await archiveStore.chats(Infinity, checkpoint.world.chats, checkpoint.world.archives);
    const restored = restoreCheckpoint(checkpoint, now);
    if (restored.expired) {
      const card = await endedCard(checkpoint, restored.expiresAt); priorCheckpoint = checkpoint; world = restored.world;
      archiveStore = newArchiveStore(); world.attachArchives(archiveStore); olderChats = {}; acceptHistory(card);
      chatLimit = 80; renderChat();
      lastPicture = null; pending.clear(); inbox.clear(); selected = null; trackedFish = null; renderer.selected = null; renderer.observedFish = null; $('inspector').hidden = true; cancelMode();
    } else { world.resolveLegends(now); world.data.tick = now; }
    members.clear(); members.set(network.node, member()); lastHello.clear(); lastLeader = ''; lastFull = 0; sentChars.clear(); sentOps.clear(); sentChats.clear(); sentChatSources.clear(); sentTravel.clear(); lastPictureTime = 0;
  }
  lastOnlineAt = Math.max(lastOnlineAt, now);
  if (elapsed > 120000) { networkChange().catch(() => {}); reconnect().catch(() => {}); }
}
function reconcileHistory() {
  let changed = false; for (const card of Object.values(histories)) if (card.roots.some(r => world.roots.includes(r)) && card.status !== 'corrected') { card.status = 'corrected'; changed = true; } if (changed) set('histories', histories).catch(() => {});
}
function acceptHistory(card) {
  if (!card || !Array.isArray(card.roots) || typeof card.image !== 'string' || card.image.length > 3000000 || !/^data:image\/(webp|png);base64,/.test(card.image)) return;
  let target = clone(card); for (const [id, existing] of Object.entries(histories)) if (existing.roots.some(r => target.roots.includes(r))) { target = { ...(existing.at > target.at ? existing : target), roots: [...new Set([...existing.roots, ...target.roots])], chats: mergeChatRecords(existing.chats, target.chats), archives: mergeArchiveState(existing.archives, target.archives), archiveRoots: { ...existing.archiveRoots, ...target.archiveRoots }, chatCount: Math.max(existing.chatCount || 0, target.chatCount || 0) }; delete histories[id]; }
  target.id = target.roots.slice().sort()[0]; if (target.roots.some(r => world.roots.includes(r))) target.status = 'corrected'; histories[target.id] = target; set('histories', histories).catch(() => {});
  for (const message of orderedChats(target.chats || {})) if (message.body.roots.some(root => world.roots.includes(root))) { const result = world.addChat(message); if (!result.ok) throw new Error(result.error); }
  renderChat();
}
async function onMessage(message, peer) {
  if (message.kind === 'archiveRequest') { const encoded = archiveStore.packs.get(message.body.id) || await get('archive:' + message.body.id); await network.direct(peer, encoded ? 'archiveChunk' : 'archiveMissing', { id: message.body.id, encoded }); return; }
  if (message.kind === 'archiveChunk' || message.kind === 'archiveMissing') { const waiting = archiveWaiters.get(message.body.id); if (waiting?.peer === message.from) { if (message.kind === 'archiveChunk') waiting.resolve(message.body.encoded); else waiting.reject(new Error('伙伴没有这份归档')); } return; }
  await resumeAfterInactivity();
  if (members.has(message.from) && members.get(message.from).actor !== message.actor) return;
  const body = message.body;
  if (message.kind === 'hello') {
    if (!body.world?.terrain || body.rules?.genesis !== 1 || body.rules?.life !== 4 || body.rules?.legends !== 1 || body.rules?.feeding !== 1 || body.rules?.ecology !== 1 || body.rules?.archives !== 1) { status = '对方使用旧版世界规则，请双方刷新游戏页面后再连接'; toast(status); network.close(peer); update(); return; }
    if (message.from !== peer.node || body.member?.id !== message.from || body.member.actor !== message.actor) return;
    const own = body.member; members.set(own.id, { ...own, url: peer.url, at: Date.now() }); remember(peer.url);
    rememberAuthor(message.actor, own.nick);
    for (const m of body.members || []) remember(m.url);
    const newKnowledge = Object.keys(body.world.roots || {}).some(r => !world.data.roots[r]) || Object.keys(body.world.ops || {}).some(id => !world.data.ops[id]) || Object.keys(body.world.chats || {}).some(id => !world.data.chats[id]) || Object.keys(body.world.chatSources || {}).some(id => !world.data.chatSources[id]);
    await mergeReplica(body.world, peer); geometryRepair = true;
    if (newKnowledge) await network.broadcast('merge', { world: body.world });
    reconcileHistory(); syncIncomeSerial(); lastPictureTime = 0;
    for (const card of body.cards || []) { await receiveHistory(card, peer); }
    await save();
    const missing = (body.historyIndex || []).filter(id => !histories[id]); if (missing.length) { historyQueues.set(peer.id, missing); await requestHistory(peer); }
    await completeReferral(peer, message.actor);
    status = ''; toast('已接入伙伴，两个世界正在合流'); update();
  } else if (message.kind === 'beat') {
    if (body.member?.id === message.from && body.member.actor === message.actor) { const direct = network.live().find(p => p.node === message.from); members.set(message.from, { ...body.member, direct: !!direct, url: await normalizeInvite(direct?.url || body.member.url), at: Date.now() }); remember(body.member.url); rememberAuthor(message.actor, body.member.nick); if (Date.now() - lastRepair > 5000 && (body.rootCount > world.roots.length || body.opCount > Object.keys(world.data.ops).length || body.chatCount > Object.keys(world.data.chats).length || body.chatSourceCount > Object.keys(world.data.chatSources).length)) { lastRepair = Date.now(); network.broadcast('replicaRequest', { to: message.from }).catch(() => {}); } }
  } else if (message.kind === 'merge') {
    await mergeReplica(body.world, peer); geometryRepair = true; reconcileHistory(); syncIncomeSerial(); update();
  } else if (message.kind === 'replicaRequest') {
    if (body.to === network.node) await network.broadcast('merge', { world: world.serialize() });
  } else if (message.kind === 'world') {
    if (message.from !== leader()) return; await mergeReplica(body.world, peer); syncIncomeSerial(); for (const id of pending.keys()) if (world.data.ops[id] || archiveStore.ids.ops.has(id)) pending.delete(id); reconcileHistory(); update();
  } else if (message.kind === 'op') {
    if (body.actor !== message.actor || !Array.isArray(body.roots) || !body.roots.some(r => world.roots.includes(r))) return;
    if (rejectedOps.has(body.id)) return;
    if (body.kind === 'referral' && !await verifyReferral(body)) return;
    inbox.set(body.id, clone(message));
    if (amLeader()) { const result = world.apply({ ...clone(body), proof: clone(message) }, await archiveStore.get('ops', body.id)); if (result.ok) await save(); else rejectOperation(body.id); await network.broadcast('ack', { id: body.id, result }); if (result.ok) await broadcastWorld(); }
  } else if (message.kind === 'ack') {
    if (message.from !== leader()) return; if (!body.result.ok) rejectOperation(body.id); const op = pending.get(body.id); if (op && !body.result.ok) { pending.delete(body.id); toast(body.result.error); update(); }
  } else if (message.kind === 'chat') {
    const result = world.addChat(message); if (!result.ok || result.duplicate) return; renderChat(); await save();
  } else if (message.kind === 'picture') {
    if (message.from === leader() && body.roots.some(r => world.roots.includes(r))) lastPicture = body;
  } else if (message.kind === 'historyRequest') {
    const ids = (body.ids || []).slice(0, 32); for (const id of ids) if (histories[id]) await network.direct(peer, 'history', { card: histories[id] });
    await network.direct(peer, 'historyEnd', { ids });
  } else if (message.kind === 'history') { await receiveHistory(body.card, peer); await save(); }
  else if (message.kind === 'historyEnd') { historyQueues.set(peer.id, (historyQueues.get(peer.id) || []).filter(id => !body.ids?.includes(id))); await requestHistory(peer); }
  else if (message.kind === 'lost') probeGone(body.id, body.url);
}
async function completeReferral(peer, peerActor) {
  const registration = identity.registration;
  if (!registration || registration.joined || referralBusy) return;
  if (!peer.entryInvite) { registration.joined = true; await save(); return; }
  // Serialize hellos without saving a consumed registration before its reward exists.
  referralBusy = true;
  try {
    const invitation = peer.entryInvite, details = await inviteDetails(invitation), inviter = details.actor || peerActor;
    if (inviter === identity.actor) { registration.joined = true; await save(); return; }
    const op = { id: `${identity.actor}:referral`, actor: identity.actor, nick: displayNick(identity.nick), t: Date.now(), roots: [world.id], cost: 0, kind: 'referral', inviter, registeredAt: registration.at, invitation };
    const message = await network.makeEnvelope('op', op);
    const result = world.apply({ ...op, proof: message }, await archiveStore.get('ops', op.id)); if (!result.ok) throw new Error(result.error);
    registration.joined = true; registration.referral = message; await save(); await network.broadcastEnvelope(message);
  } finally { referralBusy = false; }
}
async function networkChange(error) {
  if (!started) return; if (error) { status = error; update(); return; }
  const live = network.live();
  for (const p of live) if (!lastHello.has(p.id)) { lastHello.add(p.id); await network.direct(p, 'hello', { rules: { genesis: 1, life: 4, legends: 1, feeding: 1, ecology: 1, archives: 1 }, member: member(), members: active(), world: world.serialize(), cards: Object.values(histories).slice(0, 3), historyIndex: Object.keys(histories) }); }
  const ids = new Set(live.map(p => p.node)); for (const m of active()) if (m.id !== network.node && m.direct && !ids.has(m.id)) { m.direct = false; probeGone(m.id, m.url); } for (const id of ids) if (members.has(id)) members.get(id).direct = true;
  network.presence(active().filter(m => m.id !== network.node).map(m => ({ id: m.id, url: m.url }))).catch(() => {}); update();
}
async function probeGone(id, url) { if (!id || id === network.node || !members.has(id)) return; try { url = await normalizeInvite(url); const s = await network.local('probe', { url }); if (!(s.clients || []).some(c => c.id === id)) { members.delete(id); await network.broadcast('lost', { id, url }); update(); } } catch { /* Membership lease expires if the publishing computer is unreachable. */ } }
async function broadcastWorld() {
  if (snapshotBusy || !amLeader()) return; snapshotBusy = true;
  try {
    const full = Date.now() - lastFull > 30000, data = world.data, chars = {}, ops = {}, chats = {}, chatSources = {}, travel = {}, nextMarks = new Map(), travelMarks = new Map();
    for (const [id, c] of Object.entries(data.chars)) { const mark = `${c.kind}:${c.entity}:${c.x}:${c.y}:${c.ch}:${c.color}:${c.editAt || 0}:${c.moveAt || 0}:${JSON.stringify(c.path)}`; nextMarks.set(id, mark); if (full || sentChars.get(id) !== mark) chars[id] = c; }
    for (const [id, op] of Object.entries(data.ops)) if (full || !sentOps.has(id)) ops[id] = op;
    for (const [id, message] of Object.entries(data.chats)) if (full || !sentChats.has(id)) chats[id] = message;
    for (const [id, message] of Object.entries(data.chatSources)) if (full || !sentChatSources.has(id)) chatSources[id] = message;
    for (const [id, record] of Object.entries(data.travel)) { const mark = JSON.stringify(record); travelMarks.set(id, mark); if (full || sentTravel.get(id) !== mark) travel[id] = record; }
    await network.broadcast('world', { delta: !full, world: { protocol: 1, roots: data.roots, terrain: data.terrain, tick: data.tick, seaweedHour: data.seaweedHour, bubbleMinute: data.bubbleMinute, bubbles: data.bubbles, chars, fishes: data.fishes, breeding: data.breeding, contacts: data.contacts, contactAt: data.contactAt, scenes: data.scenes, participants: data.participants, ops, notices: [], chats, chatSources, travel, life: data.life, legends: data.legends, ecology: data.ecology, archives: data.archives } });
    sentChars = nextMarks; sentOps = new Set(Object.keys(data.ops)); sentChats = new Set(Object.keys(data.chats)); sentChatSources = new Set(Object.keys(data.chatSources)); sentTravel = travelMarks; if (full) lastFull = Date.now();
  } catch (e) { status = e.message; } finally { snapshotBusy = false; }
}
async function submit(payload) {
  if (started) await resumeAfterInactivity();
  if (!identity) return; const op = { id: payload.kind === 'earn' ? `${identity.actor}:hour:${payload.serial}` : crypto.randomUUID(), actor: identity.actor, nick: displayNick(identity.nick), t: Date.now(), roots: [world.id], cost: 0, ...payload };
  if (op.cost > 0 && op.cost > balance()) { toast('鱼元余额不足'); return; } pending.set(op.id, op); update();
  try { const message = await network.broadcast('op', op); if (rejectedOps.has(op.id)) { pending.delete(op.id); update(); return; } inbox.set(op.id, clone(message)); if (amLeader()) { const result = world.apply({ ...clone(op), proof: message }, await archiveStore.get('ops', op.id)); pending.delete(op.id); if (!result.ok) { rejectOperation(op.id); toast(result.error); } else await save(); await broadcastWorld(); } else { setTimeout(() => { if (pending.has(op.id)) toast('这次投放仍在等待确认，连接恢复后同步'); }, 12000); } } catch (e) { pending.delete(op.id); toast(e.message); } update();
}
function cancelMode() { mode = null; renderer.preview = null; $('modeBanner').hidden = true; $('sea').style.cursor = 'grab'; }
function stopObserving() { selected = null; trackedFish = null; renderer.selected = null; renderer.observedFish = null; $('inspector').hidden = true; }
function surfaceCamera() { const size = renderer.cell * renderer.scale; renderer.camera.y = (renderer.height / 2 - renderer.height * .27 + size / 2) / size; }
function placement(kind, cells, gender, name) { trackedFish = null; mode = { kind, cells, ...(kind === 'fish' ? { gender, name } : {}) }; $('modeBanner').textContent = `在空水域点击投放${kind === 'fish' ? '「' + name + '」' : '造景'} · 消耗 ${cells.length} 鱼元 · Esc 取消`; $('modeBanner').hidden = false; $('sea').style.cursor = 'crosshair'; }
function updateFoodBrush() {
  const ch = $('foodGlyphInput').value, valid = validGlyph(ch);
  $('foodGlyphInput').setCustomValidity(valid ? '' : '请输入一个中文、中文标点或 ASCII 鱼元，不能是空格');
  $('foodPreview').textContent = valid ? ch : '';
  $('foodPreview').style.color = $('foodColorInput').value;
  $('foodValidation').textContent = valid ? '从水面投放，吃到的鱼会保留这个字和颜色。' : '请输入一个中文、中文标点或 ASCII 鱼元，不能是空格。';
  $('foodValidation').style.color = valid ? '' : '#e9ac9e';
  $('foodCost').textContent = `每颗 1 鱼元 · 当前余额 ${balance()}`;
  $('placeFood').disabled = !valid || balance() < 1;
}
async function feedMode() { if (!identity) return; await resumeAfterInactivity(); if (balance() < 1) { toast('投食需要 1 鱼元余额'); return; } stopObserving(); cancelMode(); updateFoodBrush(); $('foodDialog').showModal(); }
function observationRect() {
  const tools = document.querySelector('.tools').getBoundingClientRect(), inspector = $('inspector').getBoundingClientRect();
  if (innerWidth <= 700) return { left: tools.right + 12, right: innerWidth - 16, top: Math.max(120, inspector.bottom + 16), bottom: innerHeight - 100 };
  return { left: tools.right + 20, right: Math.max(tools.right + 160, inspector.left - 20), top: 128, bottom: innerHeight - 52 };
}
function moveCameraToFish(fish, body) {
  const rect = observationRect(), size = renderer.cell * renderer.scale, x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
  renderer.camera = { x: nearX(fish.x + fish.facing * (body.minX + body.maxX) / 2, renderer.camera.x) + (renderer.width / 2 - x) / size, y: fish.y + (body.minY + body.maxY) / 2 + (renderer.height / 2 - y) / size };
}
function focusFish(id, follow = false) {
  const fish = world.data.fishes[id]; if (!fish) { toast('这条鱼已不再存活'); renderMyFishes(); return; }
  cancelMode(); trackedFish = null; inspect({ kind: 'fish', id }); trackedFish = follow ? id : null;
  if (innerWidth <= 700) { document.querySelector('.chat').classList.add('collapsed'); $('collapseChat').textContent = '+'; }
  const rect = observationRect(), body = followBounds = bounds(world.fishCells(id));
  renderer.zoom(Math.min(1.25, Math.max(1, renderer.scale), Math.max(80, rect.right - rect.left) / (renderer.cell * (body.width + 4)), Math.max(80, rect.bottom - rect.top) / (renderer.cell * (body.height + 4))));
  moveCameraToFish(fish, body); update();
}
function drawFishThumbnail(canvas, fish, cells) {
  const ctx = canvas.getContext('2d'), body = bounds(cells), size = Math.min(12, 76 / Math.max(1, body.width), 52 / Math.max(1, body.height));
  ctx.clearRect(0, 0, 88, 64); ctx.font = `${size * .85}px 'Microsoft YaHei',Consolas,monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const cell of cells) { const x = fish.facing === 1 ? cell.x - body.minX : body.maxX - cell.x; ctx.fillStyle = cell.color; ctx.fillText(cell.ch, (88 - body.width * size) / 2 + (x + .5) * size, (64 - body.height * size) / 2 + (cell.y - body.minY + .5) * size, size); }
}
function renderFishGender(element, fish) {
  const gender = world.fishOrigin(fish.id)?.gender;
  element.className = `fishGender${gender ? ' ' + gender : ''}`;
  element.textContent = gender === 'male' ? '♂ 公' : gender === 'female' ? '♀ 母' : '性别未记录';
}
function shortFishId(id) { return id.startsWith('born:') ? id.slice(-6) : id.slice(0, 6); }
function renderBreeding(element, fish, now = Date.now()) {
  const record = world.breedingState(fish.id); element.hidden = !record;
  if (record) { const seconds = Math.max(0, Math.ceil((record.ends - now) / 1000)); element.textContent = `繁殖中 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
}
function renderMyFishes() {
  if (!identity) return; const fishes = world.myFishes(identity.actor), catalog = fishCatalog(world.data), groups = world.fishGroups(), now = Date.now(), ids = fishes.map(fish => fish.id), key = ids.join(',');
  const total = [...catalog.values()].filter(entry => entry.actor === identity.actor).length;
  $('myFishCount').textContent = `${fishes.length} 条存活 · ${total - fishes.length} 条已消失`; $('myFishEmpty').hidden = !!fishes.length || myFishView !== 'list';
  for (const id of myFishCards.keys()) if (!ids.includes(id)) myFishCards.delete(id);
  for (const fish of fishes) {
    if (!myFishCards.has(fish.id)) {
      const card = document.createElement('button'), canvas = document.createElement('canvas'), body = document.createElement('span'), title = document.createElement('strong'), gender = document.createElement('span'), health = document.createElement('span'), breeding = document.createElement('span'), info = document.createElement('span'), metrics = document.createElement('span');
      card.type = 'button'; card.className = 'fishCard'; card.dataset.fish = fish.id; canvas.width = 88; canvas.height = 64; canvas.setAttribute('aria-hidden', 'true'); body.className = 'fishCardText'; health.className = 'fishHealth'; info.className = 'fishCardInfo'; metrics.className = 'fishCardMetrics';
      breeding.className = 'fishBreeding'; body.append(title, gender, health, breeding, info, metrics); card.append(canvas, body); card.onclick = () => { $('myFishDialog').close(); focusFish(fish.id); }; myFishCards.set(fish.id, { card, canvas, title, gender, health, breeding, info, metrics });
    }
    const entry = myFishCards.get(fish.id), cells = groups.get(fish.id) || [], status = world.fishStatus(fish.id, now);
    entry.title.textContent = displayFishName(catalog.get(fish.id), identity); renderFishGender(entry.gender, fish); entry.health.textContent = status.hungry ? '饥饿' : '未饥饿'; entry.health.classList.toggle('hungry', status.hungry);
    renderBreeding(entry.breeding, fish, now);
    entry.info.textContent = `${identity.nick} · ${shortFishId(fish.id)} · ${cells.length} 鱼元 · ${fish.birth ? '自然出生于' : '创建于'} ${fishDate.format(fish.created)}`;
    entry.metrics.textContent = `${fishLifeText(world.data, fish.id, now).habit} · 今日运动 ${status.trackedSince === undefined ? '待同步' : status.movement.toFixed(1) + ' 格'} · 近24小时进食 ${status.meals24} 颗`;
    drawFishThumbnail(entry.canvas, fish, cells);
  }
  if (myFishListKey !== key) { $('myFishList').replaceChildren(...fishes.map(fish => myFishCards.get(fish.id).card)); myFishListKey = key; }
  if (myFishView === 'pedigree') renderPedigree(catalog);
}
function setMyFishView(view) {
  $('myFishDialog').classList.toggle('pedigreeView', view === 'pedigree');
  myFishView = view; $('myFishList').hidden = view !== 'list'; $('pedigreePane').hidden = view !== 'pedigree';
  $('myFishIntro').textContent = view === 'list' ? '点击鱼卡即可定位并观察，默认不跟随；可在观察面板手动开启跟随。这里只列出当前世界中属于你的存活鱼。' : '父母在上，后代在下。鱼谱包含血缘相关的其他作者鱼，已消失的亲鱼仍保留在家谱中。';
  for (const [id, selected] of [['myFishListTab', view === 'list'], ['pedigreeTab', view === 'pedigree']]) { $(id).classList.toggle('active', selected); $(id).setAttribute('aria-pressed', String(selected)); }
  renderMyFishes();
}
function renderPedigree(catalog) {
  const owned = [...catalog.values()].filter(entry => entry.actor === identity.actor).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  if (!owned.some(entry => entry.id === pedigreeFish)) pedigreeFish = (owned.find(entry => entry.alive) || owned[0])?.id;
  const heirloom = ancestralGlyph(world.data, pedigreeFish);
  $('pedigreeHeirloom').textContent = ancestralText(heirloom, id => displayFishName(catalog.get(id), identity)); $('pedigreeHeirloom').hidden = !heirloom;
  const key = JSON.stringify([pedigreeFish, [...catalog.values()].map(entry => [entry.id, displayFishName(entry, identity), entry.nick, entry.gender, entry.alive, entry.parents])]);
  if (pedigreeKey === key) return; pedigreeKey = key;
  $('pedigreeRoot').replaceChildren(...owned.map(entry => { const option = document.createElement('option'); option.value = entry.id; option.textContent = `${displayFishName(entry, identity)} · ${shortFishId(entry.id)}${entry.alive ? '' : '（已消失）'}`; return option; }));
  $('pedigreeRoot').disabled = !owned.length; if (pedigreeFish) $('pedigreeRoot').value = pedigreeFish;
  const viewport = $('pedigreeTree'), scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
  const tree = drawPedigree(viewport, catalog, pedigreeFish, identity, id => { $('myFishDialog').close(); focusFish(id); });
  viewport.style.height = `${Math.min(480, tree.height)}px`;
  $('pedigreeCount').textContent = tree.nodes.length ? `${tree.nodes.length} 条鱼 · ${tree.generations} 代` : '暂无鱼谱'; viewport.scrollLeft = scroll.left; viewport.scrollTop = scroll.top;
}
function inspect(hit, show = true) {
  if (show || trackedFish && (hit.kind !== 'fish' || hit.id !== trackedFish)) trackedFish = null;
  selected = hit; if (hit.kind === 'monument') { renderer.observedFish = null; renderer.selected = null; $('inspector').hidden = true; historyDialog(); selected = null; return; }
  if (hit.kind === 'legend') {
    const record = world.data.legends?.events[hit.id], schedule = record && legendSchedule(world.data.roots, record.seed, record.slot); if (!schedule) { stopObserving(); return; }
    const seconds = Math.max(0, Math.ceil((schedule.ends - Date.now()) / 1000));
    renderer.observedFish = renderer.selected = renderer.selectedCell = null; $('fishDetails').hidden = $('chatMemory').hidden = $('sceneActions').hidden = true; $('eventDetails').hidden = false;
    $('objectTitle').textContent = legendTitle(schedule.kind); $('objectInfo').textContent = `稀有异象 · 剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    $('eventText').textContent = schedule.kind === 'cthulhu' ? `八条触须正在深处挥动。\n\n已缠住 ${Object.keys(record.arms).length} 条鱼；这些鱼会随它沉回深海。` : schedule.kind === 'godzilla' ? '背脊亮起之后，原子吐息会沿水域展开。\n\n被照到的鱼身鱼元会消失，造景可以挡住吐息。' : `破帆随水流摇晃，船身已经脱落 ${record.drops.length} 个字。\n\n落水的字会变成「蛆」，沿水域慢慢下沉。`;
    $('objectFootnote').textContent = seconds ? '这次相遇，会留在海的记忆里。' : '异象已经远去。'; if (show) $('inspector').hidden = false; return;
  }
  if (hit.kind === 'event') {
    const record = world.data.life?.events?.[hit.id], schedule = record && eventSchedule(world.data.roots, record.seed, record.slot);
    if (!schedule) { stopObserving(); return; }
    const event = { ...record, ...schedule }, ended = Date.now() >= event.started + event.duration;
    renderer.observedFish = renderer.selected = renderer.selectedCell = null;
    $('fishDetails').hidden = $('chatMemory').hidden = $('sceneActions').hidden = true; $('eventDetails').hidden = false;
    $('objectTitle').textContent = eventTitle(event.kind);
    const letter = event.kind === 'bottle' ? eventLetter(event) : null;
    $('objectInfo').textContent = letter ? `海洋来信 · ${letter.author}` : `一阵路过的海底信号 · ${fishDate.format(event.started)}`;
    $('eventText').textContent = letter ? letter.text : event.kind === 'radio' ? radioTranscript(event, Date.now()).join('\n\n') : eventNarration(event.kind);
    $('objectFootnote').textContent = ended ? event.kind === 'radio' ? '这阵信号已经远去了，听到的文字还在这里。' : '它已经漂向远方，读到的文字还在这里。' : '水流还在继续，可以慢慢读。';
    if (show) $('inspector').hidden = false; return;
  }
  $('eventDetails').hidden = true;
  const object = hit.kind === 'fish' ? world.data.fishes[hit.id] : world.data.scenes[hit.id]; if (!object) { $('inspector').hidden = true; selected = null; renderer.observedFish = null; return; }
  const cells = hit.kind === 'fish' ? world.fishCells(hit.id) : world.sceneCells(hit.id), ownFish = hit.kind === 'fish' && world.fishOrigin(hit.id)?.actor === identity.actor, catalog = hit.kind === 'fish' ? fishCatalog(world.data) : null; $('objectTitle').textContent = hit.kind === 'fish' ? displayFishName(catalog.get(hit.id), identity) : `${authorNick(object.actor, object.nick || '自然沉积')} 的造景`;
  $('fishDetails').hidden = hit.kind !== 'fish'; renderer.observedFish = hit.kind === 'fish' ? hit.id : null;
  const memory = hit.kind === 'scene' ? memoryForCell(world.data, hit.cell) : null;
  $('chatMemory').hidden = !memory; renderer.selectedCell = memory ? hit.cell : null;
  if (memory) {
    $('objectTitle').textContent = `海底的「${memory.ch}」`;
    $('memoryOrigin').textContent = `这句话来自很久以前的一片海。${memory.nick} · ${fishDate.format(memory.at)}`;
    $('memoryText').textContent = memory.text;
    if (show) $('memoryDetails').open = false;
  }
  if (hit.kind === 'fish') {
    const heirloom = ancestralGlyph(world.data, hit.id);
    $('fishHeirloom').textContent = ancestralText(heirloom, id => displayFishName(catalog.get(id), identity)); $('fishHeirloom').hidden = !heirloom;
    renderFishGender($('fishGender'), object);
    renderBreeding($('fishBreeding'), object);
    $('fishParentage').hidden = !object.birth; $('fishParentage').textContent = object.birth ? `自然出生 · 父鱼 ${displayFishName(catalog.get(object.parents[0]), identity)}（${shortFishId(object.parents[0])}） · 母鱼 ${displayFishName(catalog.get(object.parents[1]), identity)}（${shortFishId(object.parents[1])}）` : '';
    const v = world.swimVelocities(hit.id), eyes = cells.filter(c => EYES.has(c.ch)).length, now = Date.now(), status = world.fishStatus(hit.id, now), travel = world.data.travel[hit.id];
    $('objectInfo').textContent = `${authorNick(object.actor, object.nick)} · ${cells.length} 鱼元 · ${eyes ? eyes + ' 个眼睛' : '盲鱼'} · ${world.breedingState(hit.id) ? '合体游速 · ' : ''}水平 ${v.x.toFixed(2)} 格/秒 · 垂直 ${v.y.toFixed(2)} 格/秒`;
    const life = fishLifeText(world.data, hit.id, now);
    $('fishHabit').textContent = `${life.habit}${life.haunt ? '，' + life.haunt : ''}。`;
    $('fishCompany').textContent = life.friend ? `正在和「${displayFishName(fishCatalog(world.data).get(life.friend), identity)}」同游。` : life.company + '。';
    const capture = capturedFish(world.data, hit.id, now); if (capture) $('fishCompany').textContent = `被克苏鲁的第 ${capture.arm + 1} 条触须缠住，将随它在 ${Math.max(0, Math.ceil((capture.schedule.ends - now) / 1000))} 秒后沉回深海。`;
    $('fishMovement').textContent = status.trackedSince === undefined ? '待同步' : `${status.movement.toFixed(1)} 格`; $('fishMeals24').textContent = `${status.meals24} 颗`; $('fishHunger').textContent = status.hungry ? '饥饿' : '未饥饿'; $('fishHunger').classList.toggle('hungry', status.hungry);
    const minutes = Math.floor(status.hoursSinceFed * 60);
    $('fishLastMeal').textContent = `${status.neverFed ? '尚未进食 · 投放已' : '距上次进食'} ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟${status.canEat ? ' · 可以进食' : ' · 已吃饱，约 ' + Math.ceil((status.nextMealAt - now) / 60000) + ' 分钟后可再进食'}`;
    if (capture) $('fishLastMeal').textContent = '被触须缠住，暂不进食；饥饿时钟仍在继续。';
    $('followFish').textContent = trackedFish === hit.id ? '停止跟随' : '跟随观察'; if (trackedFish === hit.id) followBounds = bounds(cells);
    $('fishTrackingNote').textContent = !travel ? '运动记录尚未同步。' : status.partialMovement ? `旧版运动量未记录，从 ${fishDate.format(status.trackedSince)} 起累计。` : '';
    const rows = []; for (let index = 0; index < 7; index++) { const day = shanghaiDay(now - index * DAY), row = document.createElement('p'); row.textContent = `${day} · ${travel && day >= shanghaiDay(travel.since) ? (travel.days[day] || 0).toFixed(1) + ' 格' : '未记录'}`; rows.push(row); } $('fishDailyRows').replaceChildren(...rows);
    $('objectFootnote').textContent = `连续 24 小时未进食即饥饿。距下一次饥饿退化约 ${Math.max(0, (object.hungerAt - now) / 3600000).toFixed(1)} 小时。`; $('sceneActions').hidden = true; renderer.selected = null;
  }
  else { const fixed = hit.id === CHAT_FLOOR; $('objectInfo').textContent = `${cells.length} 鱼元 · 八方向地形 · ${fixed ? '海底聊天记忆' : '共享摆放'}`; $('objectFootnote').textContent = fixed ? '旧世界聊天已固化在海底，不能编辑、搬动或删除。' : '移除、缩小不返鱼元；放大产生的新鱼元需要支付配额。'; $('sceneActions').hidden = fixed; renderer.selected = hit.id; }
  if (show) $('inspector').hidden = false;
}
function chatLine(message) {
  const p = document.createElement('p'); p.className = 'message'; const n = document.createElement('span'); n.className = 'name'; n.textContent = authorNick(message.actor, message.body.nick); n.style.color = chatColor(hash(message.actor)); p.append(n, document.createTextNode(message.body.text)); return p;
}
function ownStories() { const catalog = fishCatalog(world.data); return { catalog, stories: storiesFor(world.data, catalog, identity.actor) }; }
function renderLife() {
  if (!identity) return;
  $('weatherLabel').textContent = weatherAt(world.data, Date.now()).label;
  const myth = activeLegend(world.data, Date.now()), occasion = activeEvent(world.data, Date.now());
  $('ambientPeek').hidden = !myth && !occasion || !!selected || !!mode || !!document.querySelector('dialog[open]');
  if (myth) $('ambientPeek').textContent = `${Date.now() - myth.started < 20000 && myth.kind !== 'ship' ? '海床传来异动' : legendTitle(myth.kind)} · 看看 ›`;
  else if (occasion) $('ambientPeek').textContent = `${eventTitle(occasion.kind)} · 看看 ›`;
  const { catalog, stories } = ownStories(), latest = returnStory(stories, lifeSince);
  if (latest) lifeMessage = latest;
  if (lifeMessage && !world.data.life?.stories[lifeMessage.id]) lifeMessage = null;
  $('lifeNote').hidden = !lifeMessage || !!selected || !!mode || !!document.querySelector('dialog[open]');
  if (lifeMessage) {
    $('lifeHeading').textContent = returnVisit ? '你不在的时候，海里发生了…' : '海里的小故事';
    $('lifeText').textContent = storyText(lifeMessage, id => displayFishName(catalog.get(id), identity));
  }
  // Seen time is local to this identity, without acknowledgements or unread counts.
  if (!document.hidden) identity.lifeSeenAt = Math.max(identity.lifeSeenAt || 0, Date.now());
}
function lifeDialog() {
  const { catalog, stories } = ownStories(), list = $('lifeStories'); list.replaceChildren();
  if (!stories.length) { const empty = document.createElement('p'); empty.className = 'quiet'; empty.textContent = '鱼正在慢慢认识这片海。以后的小故事会留在这里。'; list.append(empty); }
  for (const story of stories.slice(0, 40)) {
    const row = document.createElement('article'), time = document.createElement('small'), text = document.createElement('p');
    row.className = 'lifeStory'; time.textContent = fishDate.format(story.at); text.textContent = storyText(story, id => displayFishName(catalog.get(id), identity)); row.append(time, text);
    if (world.data.fishes[story.fish]) { const watch = document.createElement('button'); watch.type = 'button'; watch.textContent = '看看它'; watch.onclick = () => { $('lifeDialog').close(); focusFish(story.fish); }; row.append(watch); }
    list.append(row);
  }
  $('lifeDialog').showModal(); $('lifeNote').hidden = true;
}
function renderChat(earlier = false) {
  const count = Object.keys(world.data.chats).length + archiveStore.ids.chats.size;
  if (!earlier && renderedChatWorld === world && renderedChatCount === count && renderedChatLimit === chatLimit) return;
  renderedChatWorld = world; renderedChatCount = count; renderedChatLimit = chatLimit;
  const log = $('chatMessages'), messages = orderedChats({ ...olderChats, ...world.data.chats }), oldHeight = log.scrollHeight, oldTop = log.scrollTop, atBottom = oldHeight - oldTop - log.clientHeight < 24;
  $('loadEarlierChat').hidden = count <= chatLimit; log.replaceChildren();
  for (const message of messages.slice(-chatLimit)) log.append(chatLine(message));
  log.scrollTop = earlier ? oldTop + log.scrollHeight - oldHeight : atBottom ? log.scrollHeight : oldTop;
}
function historyDialog() {
  const container = $('historyCards'); container.replaceChildren(); const cards = Object.values(histories).filter(c => c.status !== 'corrected').sort((a, b) => b.at - a.at);
  if (!cards.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '海还年轻，暂时没有湮灭的记忆。'; container.append(p); }
  for (const card of cards) {
    const article = document.createElement('article'); article.className = 'historyCard'; const img = document.createElement('img'); img.src = card.image; img.alt = '旧世界全景合影';
    img.onclick = () => { const a = document.createElement('a'); a.href = card.image; a.download = '鱼来-世界合影.webp'; a.click(); };
    const div = document.createElement('div'), title = document.createElement('h3'), info = document.createElement('p'); title.textContent = `海 ${card.id.slice(0, 6)} · ${new Date(card.at).toLocaleString('zh-CN')}`;
    info.textContent = `${card.counts?.fish || 0} 条鱼 · ${card.counts?.scene || 0} 处造景 · ${card.participants || 1} 位参与者${card.status === 'pending' ? ' · 暂定湮灭，重逢后校正' : ''}`;
    div.append(title, info); article.append(img, div);
    if (card.archives && Object.keys(card.archives.chunks).length) { const past = document.createElement('button'); past.type = 'button'; past.textContent = '过去的作品与收支'; past.className = 'archiveOpen'; past.onclick = () => { $('historyDialog').close(); archiveViewer(card); }; div.append(past); }
    const messages = orderedChats(card.chats || {});
    if (messages.length || card.chatCount) {
      const details = document.createElement('details'), summary = document.createElement('summary'), log = document.createElement('div'); summary.textContent = `查看当时的聊天 · ${Math.max(messages.length, card.chatCount || 0)} 条`; log.className = 'archivedChat';
      details.ontoggle = async () => { if (!details.open || log.childElementCount) return; try { const store = await historyArchiveStore(card); const all = orderedChats(await store.chats(Infinity, card.chats || {}, card.archives)); for (const message of all) log.append(chatLine(message)); } catch (error) { toast('旧聊天读取失败：' + error.message); } };
      details.append(summary, log); article.append(details);
    }
    container.append(article);
  }
  $('historyDialog').showModal();
}
async function archiveViewer(card) {
  $('archiveDialog').showModal(); $('archiveWorks').textContent = '正在翻开记忆…'; $('archiveLedger').replaceChildren(); $('archiveMore').hidden = true;
  try {
    const store = card ? await historyArchiveStore(card) : archiveStore, hot = card ? null : world.data;
    const ops = { ...store.summary.ops, ...hot?.ops }, catalog = card ? new Map(Object.entries(store.summary.catalog)) : fishCatalog(world.data);
    const works = [...catalog.values()].map(entry => ({ id: entry.id, t: entry.created, type: entry.parents?.length ? 'born' : 'fish', entry }));
    for (const op of Object.values(ops)) if (op.kind === 'scene') works.push({ id: op.id, t: op.t, type: 'scene' });
    const ledger = Object.values(ops).filter(op => op.actor === identity.actor || op.kind === 'referral' && op.inviter === identity.actor);
    archiveView = { store, hot, works: works.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id)), ledger: ledger.sort((a, b) => b.t - a.t || a.id.localeCompare(b.id)), catalog, limit: 40 };
    $('archiveTitle').textContent = card ? '旧海的作品与收支' : '这片海的作品与收支'; await renderArchives();
  } catch (error) { $('archiveWorks').textContent = '这份记忆暂时没有读到，请稍后再看。'; toast(error.message); }
}
async function renderArchives() {
  const view = archiveView; if (!view) return; const works = $('archiveWorks'), ledger = $('archiveLedger'); works.replaceChildren(); ledger.replaceChildren();
  const record = (field, id) => view.hot?.[field]?.[id] || view.store.get(field, id);
  for (const entry of view.works.slice(0, view.limit)) {
    const birth = entry.type === 'born' ? await record('breeding', entry.id.slice(5)) : null, op = birth ? null : await record('ops', entry.id); if (!birth && !op) continue;
    const body = birth?.baby || op, cells = birth ? body.cells.map(c => ({ x: c.x, y: c.y, ch: c.after, color: c.color })) : body.cells;
    const row = document.createElement('article'), canvas = document.createElement('canvas'), title = document.createElement('strong'), info = document.createElement('p'); canvas.width = 88; canvas.height = 64; row.className = 'archiveWork'; drawFishThumbnail(canvas, { facing: 1 }, cells);
    title.textContent = entry.type === 'scene' ? '一处造景' : displayFishName(view.catalog.get(entry.id), identity);
    info.textContent = `${authorNick(body.actor, body.nick)} · ${fishDate.format(entry.t)} · ${entry.type === 'born' ? '出生时' : '投放时'}的模样`;
    row.append(canvas, title, info); works.append(row);
  }
  const names = { fish: '造鱼', scene: '造景', food: '投食', sceneMove: '搬动造景', sceneDelete: '移除造景', sceneRotate: '旋转造景', sceneScale: '缩放造景', sceneEdit: '改字', earn: '在线奖励', referral: '邀请推广' };
  for (const item of view.ledger.slice(0, view.limit)) {
    const op = await record('ops', item.id); if (!op) continue; const row = document.createElement('p');
    const amount = op.kind === 'earn' ? '+1 鱼元' : op.kind === 'referral' && op.inviter === identity.actor ? '+10 鱼元' : op.cost ? `花费 ${op.cost} 鱼元` : '无花费';
    row.textContent = `${fishDate.format(op.t)} · ${names[op.kind] || '作品变化'} · ${amount}`; ledger.append(row);
  }
  if (!works.childElementCount) works.textContent = '这片海还没有留下这一类作品。'; if (!ledger.childElementCount) ledger.textContent = '你在这片海还没有消费或奖励记录。';
  $('archiveMore').hidden = view.limit >= Math.max(view.works.length, view.ledger.length);
}
function localPicture() { return { id: world.id, roots: world.roots, image: renderer.snapshot(world), at: Date.now(), counts: world.counts(), participants: Object.keys(world.data.participants).length || 1 }; }
async function endedCard(checkpoint, endedAt) {
  const roots = Object.keys(checkpoint.world.roots).sort(), chunks = await archiveChunks(Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, checkpoint.world[f] || {}])), checkpoint.world.roots);
  await putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded]));
  let archives = checkpoint.world.archives || emptyArchiveState(); for (const chunk of chunks) { await archiveStore.ingest(chunk, chooseClaim); archives = mergeArchiveState(archives, { version: 1, at: endedAt, chunks: { [chunk.manifest.id]: chunk.manifest } }); }
  const remainingChats = Object.fromEntries(Object.entries(checkpoint.world.chats || {}).filter(([id]) => !archiveStore.ids.chats.has(id)));
  return { ...checkpoint.picture, counts: { ...checkpoint.picture?.counts, scene: sceneryCount(checkpoint.world) }, id: roots[0], roots, chats: remainingChats, chatCount: Object.keys(checkpoint.world.chats || {}).length, archives, archiveRoots: checkpoint.world.roots, status: 'ended', endedAt };
}
async function historyArchiveStore(card, peer, bundle) {
  const key = Object.keys(card.archives?.chunks || {}).sort().join(',') + JSON.stringify(Object.entries(card.archiveRoots || {}).sort(([a], [b]) => a.localeCompare(b))); if (historyArchiveStores.has(key)) { const store = historyArchiveStores.get(key); historyArchiveStores.delete(key); historyArchiveStores.set(key, store); return store; }
  const store = newArchiveStore(); await ensureArchives({ protocol: 1, roots: card.archiveRoots || {}, archives: card.archives, ...Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])) }, peer, bundle, store); historyArchiveStores.set(key, store); while (historyArchiveStores.size > 2) historyArchiveStores.delete(historyArchiveStores.keys().next().value); return store;
}
async function receiveHistory(card, peer, bundle) {
  const store = await historyArchiveStore(card, peer, bundle); await verifyChats(card.chats, store); acceptHistory(card);
  if (card.roots.some(root => world.roots.includes(root))) for (const message of Object.values(await store.chats(Infinity, card.chats || {}, card.archives))) { const result = world.addChat(message); if (!result.ok) throw new Error(result.error); }
  renderChat();
}
function currentCheckpoint() { return { world: world.serialize(), picture: lastPicture || localPicture(), at: Date.now(), lastOnlineAt }; }
async function save() { if (!identity) return; if (!lastPicture || JSON.stringify(lastPicture.counts) !== JSON.stringify(world.counts()) || lastPicture.roots.length !== world.roots.length || !world.roots.every(root => lastPicture.roots.includes(root)) || lastPicture.participants !== (Object.keys(world.data.participants).length || 1)) lastPicture = localPicture(); await putMany([['identity', identity], ['histories', histories], ['known', known], ['checkpoint', currentCheckpoint()]]); }
async function takePicture() { if (!amLeader()) return; lastPicture = localPicture(); await network.broadcast('picture', lastPicture); }
async function reconnect() { const params = new URLSearchParams(location.search), input = params.get('join') || meta.joinUrl; if (params.has('join')) { params.delete('join'); history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : '') + location.hash); } const urls = [...new Set([input, ...known].filter(Boolean))]; for (const url of urls.slice(0, 12)) { if (network.live().length) break; try { await network.connectInvite(url); remember(url); } catch { } } }
async function start() {
  meta = await (await fetch('/local/meta')).json(); if (!meta.token) throw new Error('请运行自己的启动器，从固定本地地址进入');
  meta.url = await normalizeInvite(meta.url);
  identity = await get('identity'); if (!identity) { $('welcomeDialog').showModal(); await new Promise(resolve => $('welcomeForm').onsubmit = async e => { e.preventDefault(); const nick = $('nickInput').value.trim(); if (!nick) return; identity = await newIdentity(nick); $('welcomeDialog').close(); resolve(); }); }
  lifeSince = Number.isFinite(identity.lifeSeenAt) ? identity.lifeSeenAt : Date.now(); returnVisit = Date.now() - lifeSince > 60000;
  meta.url = await encodeInvite(await decodeInvite(meta.url), identity.actor);
  $('downloadPackage').href = '/download.zip?invite=' + encodeURIComponent(meta.url);
  histories = await get('histories') || {}; known = await get('known') || []; const previous = await get('checkpoint'), now = Date.now();
  const migrated = await Promise.allSettled((Array.isArray(known) ? known : []).map(normalizeInvite)); known = [...new Set(migrated.filter(result => result.status === 'fulfilled').map(result => result.value))]; await set('known', known);
  if (previous?.world) await ensureArchives(previous.world);
  await verifyChats(previous?.world?.chats);
  const expires = previous?.world && now - (previous.lastOnlineAt ?? previous.at ?? previous.world.tick) >= CONFIG.offlineLife;
  if (expires) previous.world.chats = await archiveStore.chats(Infinity, previous.world.chats, previous.world.archives);
  const restored = restoreCheckpoint(previous, now);
  if (previous?.world && !restored.expired) await verifyReplica(previous.world, await archiveStore.dependencies(previous.world, world.data));
  world = restored.world; world.data.participants[identity.actor] = identity.nick; lastOnlineAt = now; lastMeter = now;
  if (restored.expired) { const card = previous.picture ? await endedCard(previous, restored.expiresAt) : null; priorCheckpoint = previous; archiveStore = newArchiveStore(); if (card) acceptHistory(card); }
  else reconcileHistory();
  world.attachArchives(archiveStore);
  network = new Network(identity, meta, onMessage, networkChange); await network.start(displayNick(identity.nick)); started = true; members.set(network.node, member());
  $('myUrl').value = meta.url; creator = new Creator(placement, balance, size => defaultFishName(identity.nick, world.myFishes(identity.actor).length + 1, size));
  syncIncomeSerial(); renderChat(); await save();
  reconnect().catch(() => {}); update(); lastPictureTime = Date.now(); takePicture().catch(() => {});
  setInterval(tick, CONFIG.step); setInterval(() => { network.presence(active().filter(m => m.id !== network.node).map(m => ({ id: m.id, url: m.url }))).catch(() => {}); if (network.connections.size < 6) { const candidate = active().filter(m => m.id !== network.node && !network.has(m.id)).sort((a, b) => hash(`${network.node}:${a.id}`) - hash(`${network.node}:${b.id}`))[0]; if (candidate) network.connect(candidate.url, candidate.id).catch(() => {}); } }, 6000);
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { lifeSince = identity.lifeSeenAt || Date.now(); returnVisit = Date.now() - lifeSince > 60000; lifeMessage = null; } await resumeAfterInactivity(); network.broadcast('beat', { member: member() }).catch(() => {}); save().catch(() => {}); });
  window.addEventListener('pagehide', () => { const blob = new Blob([JSON.stringify({ node: network.node, token: meta.token })], { type: 'application/json' }); navigator.sendBeacon('/local/unregister', blob); lastPicture = localPicture(); save().catch(() => {}); });
  // Exposes read-only diagnostics for the project's automated browser checks.
  window.tide = { get world() { return { data: world.serialize(), counts: world.counts() }; }, get network() { return { node: network.node, leader: leader(), peers: network.live().map(p => ({ node: p.node, url: p.url })), stats: clone(network.stats) }; }, get identity() { return { actor: identity.actor, nick: displayNick(identity.nick) }; }, get histories() { return clone(histories); }, get view() { return { camera: clone(renderer.camera), scale: renderer.scale, followingFish: trackedFish, selected: clone(selected) }; }, balance };
}
async function tick() {
  const now = Date.now(), elapsed = now - lastMeter; lastMeter = now;
  if (elapsed < 90000) identity.remainder = (identity.remainder || 0) + elapsed / 1000;
  await resumeAfterInactivity(now);
  if (identity.remainder >= 3600) { identity.remainder -= 3600; identity.serial = (identity.serial || 0) + 1; await submit({ kind: 'earn', cost: 0, serial: identity.serial }); }
  members.set(network.node, member());
  if (now - selfBeat >= 3000) { selfBeat = now; network.broadcast('beat', { member: member(), rootCount: world.roots.length, opCount: Object.keys(world.data.ops).length, chatCount: Object.keys(world.data.chats).length, chatSourceCount: Object.keys(world.data.chatSources).length }).catch(() => {}); }
  const currentLeader = leader(); if (currentLeader !== lastLeader) { lastLeader = currentLeader; lastFull = 0; sentChars.clear(); sentOps.clear(); sentChats.clear(); sentChatSources.clear(); sentTravel.clear(); if (amLeader()) { geometryRepair = true; world.data.tick = Math.max(world.data.tick, now - 2000); for (const envelope of [...inbox.values()].sort((a, b) => a.body.t - b.body.t || a.body.id.localeCompare(b.body.id))) { if (!world.data.ops[envelope.body.id]) { const result = world.apply({ ...clone(envelope.body), proof: clone(envelope) }); if (!result.ok) rejectOperation(envelope.body.id); network.broadcast('ack', { id: envelope.body.id, result }).catch(() => {}); } } for (const id of pending.keys()) if (world.data.ops[id]) pending.delete(id); } }
  if (amLeader() && fishRepairWaiting && now - lastSave > 5000) geometryRepair = true;
  if (amLeader() && geometryRepair) { const result = world.reconcileGeometry(now); geometryRepair = false; fishRepairWaiting = result.fishWaiting; if (result.fishWaiting) toast('世界空间不足，部分重叠鱼仍在等待空位'); else if (result.waiting) toast('世界空间不足，部分合流造景仍待安置'); }
  if (amLeader() && world.data.pendingChatGlyphs && now - lastSave > 5000) world.reconcileChatFloor(now);
  if (amLeader()) { let loops = 0; while (world.data.tick + CONFIG.step <= now && loops++ < 20) world.step(world.data.tick + CONFIG.step); if (now - lastSnapshot >= 1000) { lastSnapshot = now; broadcastWorld(); } }
  if (now - lastSave > 5000) { lastSave = now; save().catch(e => toast('本地保存失败：' + e.message)); }
  if (amLeader() && now - lastPictureTime > 30000) { lastPictureTime = now; takePicture().catch(() => {}); }
  update();
  archiveWorld(now).catch(() => {});
}
$('lifePeek').onclick = lifeDialog;
$('ambientPeek').onclick = () => {
  const myth = activeLegend(world.data, Date.now()); if (myth) { cancelMode(); stopObserving(); const p = legendPosition(world.data.roots, myth, Date.now()); renderer.camera.x = p.x; renderer.camera.y = myth.kind === 'ship' ? 5 : Math.max(0, world.floorAt(p.x) - 13); inspect({ kind: 'legend', id: myth.id }); update(); return; }
  const event = activeEvent(world.data, Date.now()); if (!event) return;
  cancelMode(); stopObserving(); const p = eventPosition(event, Date.now());
  renderer.camera.x = p.x; renderer.camera.y = Math.max(0, Math.min(CONFIG.depth, p.y));
  if (event.kind === 'bottle' || event.kind === 'radio') inspect({ kind: 'event', id: event.id });
  update();
};
$('closeLife').onclick = () => $('lifeDialog').close();
$('closeArchive').onclick = () => { $('archiveDialog').close(); archiveView = null; };
$('openArchives').onclick = () => { $('myFishDialog').close(); archiveViewer(); };
$('archiveMore').onclick = async () => { if (archiveView) { archiveView.limit += 40; await renderArchives(); } };
$('myFishStories').onclick = () => { $('myFishDialog').close(); lifeDialog(); };

$('makeFish').onclick = () => { stopObserving(); cancelMode(); creator?.open('fish'); }; $('makeScene').onclick = () => { stopObserving(); cancelMode(); creator?.open('scene'); }; $('feed').onclick = () => feedMode();
$('myFish').onclick = () => { if (!identity) return; setMyFishView('list'); $('myFishDialog').showModal(); };
$('myFishListTab').onclick = () => setMyFishView('list'); $('pedigreeTab').onclick = () => setMyFishView('pedigree');
$('pedigreeRoot').onchange = () => { pedigreeFish = $('pedigreeRoot').value; pedigreeKey = ''; renderPedigree(fishCatalog(world.data)); };
$('closeMyFish').onclick = () => $('myFishDialog').close(); $('createFromMyFish').onclick = () => { $('myFishDialog').close(); $('makeFish').click(); };
$('followFish').onclick = () => { if (selected?.kind !== 'fish') return; if (trackedFish === selected.id) { trackedFish = null; update(); } else focusFish(selected.id, true); };
$('closeFood').onclick = () => $('foodDialog').close();
$('foodGlyphInput').oninput = updateFoodBrush; $('foodColorInput').oninput = updateFoodBrush;
$('foodForm').onsubmit = e => {
  e.preventDefault(); updateFoodBrush(); if ($('placeFood').disabled) return;
  mode = { kind: 'food', ch: $('foodGlyphInput').value, color: $('foodColorInput').value };
  $('foodDialog').close(); surfaceCamera();
  $('modeBanner').textContent = `选择水面上的位置投食「${mode.ch}」 · 每颗 1 鱼元 · Esc 取消`;
  $('modeBanner').hidden = false; $('sea').style.cursor = 'crosshair'; update();
};
$('surface').onclick = () => { trackedFish = null; surfaceCamera(); update(); }; $('seabed').onclick = () => { trackedFish = null; renderer.camera = { x: world.monument.x + 4, y: world.floorAt(world.monument.x + 4) - 15 }; update(); };
$('zoomIn').onclick = () => { renderer.zoom(renderer.scale + .15); update(); }; $('zoomOut').onclick = () => { renderer.zoom(renderer.scale - .15); update(); };
const scene3dToggle = $('scene3dToggle'), scene3dPreference = 'tide.scene3d';
function applyScene3d(scene) {
  renderer.scene3d = scene;
  scene3dToggle.setAttribute('aria-pressed', String(Boolean(scene)));
  try { if (scene) localStorage.setItem(scene3dPreference, '1'); else localStorage.removeItem(scene3dPreference); } catch {}
}
async function setScene3d(enabled) {
  if (scene3dToggle.getAttribute('aria-busy') === 'true') return;
  if (!enabled) { applyScene3d(null); return; }
  scene3dToggle.setAttribute('aria-busy', 'true');
  try {
    const { Scene3D } = await import('./scene-3d.js');
    applyScene3d(new Scene3D());
  } catch {
    applyScene3d(null);
    toast('立体海景加载失败，当前使用平面海景');
  } finally {
    scene3dToggle.removeAttribute('aria-busy');
  }
}
scene3dToggle.onclick = () => setScene3d(!renderer.scene3d);
try { if (localStorage.getItem(scene3dPreference) === '1') setScene3d(true); } catch {}
$('connect').onclick = () => $('connectionDialog').showModal(); $('closeConnection').onclick = () => $('connectionDialog').close();
$('connectionForm').onsubmit = async e => { e.preventDefault(); status = '正在自动配对…'; update(); try { const code = await normalizeInvite($('peerUrl').value); $('peerUrl').value = code; await network.connectInvite(code); await remember(code); $('connectionDialog').close(); } catch (e) { status = e.message; toast(e.message); } update(); };
$('copyUrl').onclick = async () => { await navigator.clipboard.writeText(meta.url); toast('邀请码已复制'); };
$('backup').onclick = async () => { try { await resumeAfterInactivity(); const manifests = { ...world.data.archives?.chunks }; for (const card of Object.values(histories)) Object.assign(manifests, card.archives?.chunks); const archiveChunks = {}; for (const id of Object.keys(manifests)) { archiveChunks[id] = archiveStore.packs.get(id) || await get('archive:' + id); if (!archiveChunks[id]) throw new Error('备份缺少历史归档'); } download('鱼来-身份与记忆备份.json', { format: 'tide-backup-1', identity, histories, known, checkpoint: currentCheckpoint(), archiveChunks }); } catch (error) { toast(error.message); } };
$('importBackup').onchange = async e => { try { const data = JSON.parse(await e.target.files[0].text()); if (data.format !== 'tide-backup-1' || !data.identity?.secret || await actorId(data.identity.pub) !== data.identity.actor) throw new Error('备份无效'); const entries = [['identity', data.identity], ['histories', data.histories || {}], ['known', data.known || []]]; if (data.checkpoint) { const restoredArchives = newArchiveStore(); await ensureArchives(data.checkpoint.world, null, data.archiveChunks, restoredArchives); await verifyReplica(data.checkpoint.world, await restoredArchives.dependencies(data.checkpoint.world, world.data), restoredArchives); entries.push(['checkpoint', data.checkpoint]); } for (const card of Object.values(data.histories || {})) await historyArchiveStore(card, null, data.archiveChunks); await putMany(entries); await network.stop(); location.reload(); } catch (e) { toast(e.message); } };
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = () => $('helpDialog').close(); $('closeHistory').onclick = () => $('historyDialog').close();
$('collapseChat').onclick = () => { document.querySelector('.chat').classList.toggle('collapsed'); $('collapseChat').textContent = document.querySelector('.chat').classList.contains('collapsed') ? '+' : '−'; };
$('loadEarlierChat').onclick = async () => { chatLimit += 80; try { olderChats = await archiveStore.chats(chatLimit, world.data.chats, world.data.archives); renderChat(true); } catch (error) { toast('旧聊天读取失败：' + error.message); } };
$('chatForm').onsubmit = async e => {
  e.preventDefault(); const text = $('chatInput').value.trim(); if (!identity || !text || text.length > 160 || Date.now() - lastChat < 1500) return;
  await resumeAfterInactivity(); lastChat = Date.now();
  try { const message = await network.makeEnvelope('chat', { nick: displayNick(identity.nick), text, t: Date.now(), roots: [world.id] }); const result = world.addChat(message); if (!result.ok) throw new Error(result.error); renderChat(); $('chatInput').value = ''; await save(); await network.broadcastEnvelope(message); }
  catch (error) { toast('聊天保存或发送失败：' + error.message); }
};
$('closeInspector').onclick = stopObserving;
$('moveScene').onclick = () => { if (!selected) return; mode = { kind: 'sceneMove', scene: selected.id, cells: world.sceneCells(selected.id) }; $('modeBanner').textContent = '选择造景的新位置 · 不返还或消耗现有鱼元 · Esc 取消'; $('modeBanner').hidden = false; };
$('rotateScene').onclick = () => selected && submit({ kind: 'sceneRotate', scene: selected.id, cost: 0 });
$('scaleScene').onclick = () => selected && submit({ kind: 'sceneScale', scene: selected.id, factor: 2, cost: world.sceneCells(selected.id).length * 3 });
$('shrinkScene').onclick = () => selected && submit({ kind: 'sceneScale', scene: selected.id, factor: .5, cost: 0 });
$('deleteScene').onclick = () => { if (!selected) return; submit({ kind: 'sceneDelete', scene: selected.id, cost: 0 }); selected = null; renderer.selected = null; $('inspector').hidden = true; };
$('sea').oncontextmenu = e => { e.preventDefault(); cancelMode(); };
$('sea').addEventListener('pointerdown', e => { if (e.button !== 0) return; if (mode) { const p = renderer.point(e.clientX, e.clientY); if (mode.kind === 'food') { if (p.y !== 0) { toast('请在亮蓝色水面行点击投食'); return; } submit({ kind: 'food', ch: mode.ch, color: mode.color, x: p.x, y: 0, cost: 1 }); } else { const b = bounds(mode.cells), x = wrapX(p.x - b.minX), y = p.y - b.minY; submit({ kind: mode.kind, cells: mode.cells, ...(mode.kind === 'fish' ? { gender: mode.gender, name: mode.name } : {}), scene: mode.scene, x, y, cost: mode.kind === 'sceneMove' ? 0 : mode.cells.length }); cancelMode(); } return; } dragging = { startX: e.clientX, startY: e.clientY, x: renderer.camera.x, y: renderer.camera.y, moved: false }; $('sea').setPointerCapture(e.pointerId); });
$('sea').addEventListener('pointermove', e => { if (mode) { const p = renderer.point(e.clientX, e.clientY), b = bounds(mode.cells || []); renderer.preview = { ...mode, x: mode.kind === 'food' ? p.x : wrapX(p.x - b.minX), y: mode.kind === 'food' ? 0 : p.y - b.minY }; if (mode.kind === 'fish') renderer.preview.valid = world.canOccupy({ id: '', x: renderer.preview.x, y: renderer.preview.y, facing: 1 }, mode.cells); } else if (dragging) { const s = renderer.cell * renderer.scale; renderer.camera.x = wrapX(dragging.x - (e.clientX - dragging.startX) / s); renderer.camera.y = Math.min(CONFIG.depth, Math.max(0, dragging.y - (e.clientY - dragging.startY) / s)); dragging.moved ||= Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 4; if (dragging.moved) trackedFish = null; update(); } });
$('sea').addEventListener('pointerup', e => { if (dragging && !dragging.moved) { const hit = renderer.hit(e.clientX, e.clientY); if (hit) inspect(hit); else { selected = null; renderer.selected = null; $('inspector').hidden = true; } } dragging = null; });
$('sea').addEventListener('wheel', e => { e.preventDefault(); renderer.zoom(renderer.scale * (e.deltaY < 0 ? 1.1 : .9)); update(); }, { passive: false });
const shortcutButtons = { f: 'makeFish', s: 'makeScene', e: 'feed', m: 'seabed', p: 'myFish', o: 'surface', l: 'connect', h: 'help' }, heldShortcuts = new Set();
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase(), heldKey = e.code || key;
  if (heldShortcuts.has(heldKey)) { e.preventDefault(); return; }
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') { cancelMode(); return; }
  const editing = (e.target.matches('input,textarea,select') || e.target.isContentEditable) && e.target.getClientRects().length > 0;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || editing || document.querySelector('dialog[open]')) return;
  const button = shortcutButtons[key]; if (!button) return;
  // Cancel text insertion before the click transfers focus into the new editor.
  e.preventDefault(); heldShortcuts.add(heldKey); $(button).click();
});
document.addEventListener('keyup', e => heldShortcuts.delete(e.code || e.key.toLowerCase()));
window.addEventListener('blur', () => heldShortcuts.clear());
function render(now) {
  if (trackedFish) {
    const fish = world.data.fishes[trackedFish];
    if (fish && followBounds) moveCameraToFish(fish, followBounds);
    else { trackedFish = null; toast('这条鱼已不再存活'); }
  }
  try { renderer.draw(world, now); }
  catch (error) {
    if (!renderer.scene3d) throw error;
    applyScene3d(null);
    renderer.resize();
    toast('立体海景绘制失败，当前使用平面海景');
    renderer.draw(world, now);
  }
  requestAnimationFrame(render);
}
render(); start().catch(e => { toast(e.message); status = e.message; const label = $('networkStatus'); if (label) label.textContent = e.message; });
