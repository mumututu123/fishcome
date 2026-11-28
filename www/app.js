import { World, CONFIG, clone, EYES, bounds, validGlyph, displayNick, hash, sceneryCount, chooseClaim } from './engine.js';
import { SimulationClient, startSimulationClock, subscribeSimulationChanges } from './simulation-client.js';
import { setParticipantName, subscribeBeforeSimulationPatch, worldEdited } from './simulation-changes.js';
import { atCheckpointBoundary, get, getMany, readCheckpointVersion, sameStoredCheckpoint, putMany, readHandoffCheckpoint, replaceFromBackup, getOldBranch, LEGACY_NOTICE_SEEN, claimLegacyNotice, newIdentity, signer, verifyEnvelope, actorId, download } from './storage.js';
import { beforeCheckpointPatch, noteCheckpointChanges, noteCheckpointMerge } from './checkpoint-pages.js';
import { CheckpointPictures } from './checkpoint-picture.js';
import { Network } from './network.js';
import { OrderedSession } from './ordered-session.js';
import { prepareOrderedArchive } from './ordered-archive.js';
import { ReplicaInventory, ReplicaRecovery, ReplicaSwims, WorldBroadcast } from './world-broadcast.js';
import { DiagnosticLog, inspectFishOrigins, repairFishOriginIssues, diagnosticSummary } from './diagnostics.js';
import { loadReplicaArchives, verifyChats, verifyLocalCheckpoint, verifyReplica } from './replica.js';
import { Renderer } from './renderer.js';
import { Creator } from './creator.js';
import { restoreCheckpoint } from './lifecycle.js';
import { CHAT_FLOOR, orderedChats, chatColor, mergeChatRecords } from './chat.js';
import { DAY, shanghaiDay } from './fish-status.js';
import { fishOrigin } from './breeding.js';
import { defaultFishName, displayFishName, fishCatalog } from './fish-profile.js';
import { drawPedigree, setupPedigreeViewport } from './pedigree.js';
import { normalizeInvite, encodeInvite, decodeInvite, inviteDetails } from './invite.js';
import { verifyReferral } from './referral.js';
import { wrapX, nearX } from './geography.js';
import { weatherAt, fishLifeText, storiesFor, storyText, returnStory, mergeBonds, newLife, validateLife } from './life.js';
import { memoryForCell, ancestralGlyph, ancestralText } from './easter-eggs.js';
import { activeEvent, eventSchedule, eventTitle, eventPosition, eventLetter, radioTranscript, eventNarration } from './random-events.js';
import { activeLegend, legendSchedule, legendTitle, legendPosition, capturedFish } from './legends.js';
import { POPULATION, illnessOf } from './population.js';
import { ARCHIVE, ARCHIVE_FIELDS, ArchiveStore, archivePlanAsync, reachesArchiveThreshold, archiveChunks, emptyArchiveState, mergeArchiveState, prepareCompaction, compactKnown, observeArchiveDependencies } from './archive.js';
import { WORLD_RULES, rulesCompatible } from './rules.js';
import { assetPlatformLabel, classifyPeerCompatibility, detectUpdateSource, formatUpdateBytes, normalizeAssetSuffix, pickHigherVersionPeers } from './update.js';
const $ = id => document.getElementById(id);
const renderer = new Renderer($('sea'));
const simulation = new SimulationClient();
let displayedWorld, displayedFish, displayedScenes;
subscribeSimulationChanges((target, patch, origin) => renderer.worldChanged(target, patch, origin));
subscribeSimulationChanges((target, patch) => {
  if (target !== displayedWorld) return;
  if (!patch) { displayedWorld = null; return; }
  const { fishes, scenes, ops } = patch.tables;
  if (fishes) displayedFish += fishes.addedCount - fishes.removedCount;
  if (scenes) displayedScenes = undefined;
  if (ops) {
    const newFood = ops.addedCount === ops.set.length && !ops.removedCount && ops.set.every(([, op]) => op.kind === 'food');
    if (!newFood) displayedScenes = undefined;
  }
});
let world = new World(undefined, undefined, { populate: false }), identity, network, meta, creator, mode = null, selected = null, dragging, histories = {}, known = [], members = new Map(), pending = new Map(), inbox = new Map(), priorCheckpoint = null;
let chatLimit = 80, renderedChatWorld, renderedChatCount = -1, renderedChatLimit = -1;
let trackedFish = null, followBounds = null, myFishListKey = '';
let referralBusy = false;
const myFishCards = new Map();
let lifeSince = Date.now(), returnVisit = false, lifeMessage = null;
let myFishView = 'list', pedigreeFish = null, pedigreeKey = '';
const fishDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
let lastHello = new Set(), lastMeter = Date.now(), lastSave = 0, lastPictureTime = 0, lastChat = 0, selfBeat = 0, lastLeader = '', status = '', started = false, lastRepair = 0;
const worldBroadcast = new WorldBroadcast(subscribeSimulationChanges);
const replicaSwims = new ReplicaSwims();
const replicaRecovery = new ReplicaRecovery();
const replicaInventory = new ReplicaInventory();
subscribeSimulationChanges((target, patch) => {
  if (target === world && started && !updateFrozen && !replacingCheckpoint && Number.isFinite(patch?.values?.tick)) {
    if (!ordered.current?.running) {
      broadcastWorld(patch.swims);
      if (amLeader()) queueMicrotask(() => runOrdered(() => ordered.probe()));
    }
  }
});
async function captureReplica() {
  if (!started) throw new Error('世界尚未启动，暂时无法同步');
  return (await saveInternal({ capture: true })).world;
}
let geometryRepair = false, fishRepairWaiting = 0;
let updateFrozen = false, updateRestarting = false, activeRestartTaskId = '', activeSavePromise = null, preparedUpdate = null, peerUpdateCandidate = '', activeUpdateTaskId = '', updatePollTimer = null, peerProbeBusy = false, updateStateSeq = 0;
let updateForcePendingAck = false, updateForceDraftAck = false, updateForceReason = '';
const availablePeerUpdates = new Map();
const tabInstanceId = crypto.randomUUID();
const updateChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fishcome-update') : null;
const updatePeerWaiters = new Map();
function newArchiveStore(bundle) { return new ArchiveStore({ load: id => bundle ? bundle[id] : get('archive:' + id) }); }
let archiveStore = newArchiveStore(), archiveBusy = false, archiveScanning = false, archiveCheckAt = 0, olderChats = {};
const archiveWaiters = new Map(), archiveRequests = new Map(), historyArchiveStores = new Map();
let archiveImports = 0;
let resumeTask;
let archiveView;
const rejectedOps = new Set();
function rejectOperation(id) { rejectedOps.add(id); inbox.delete(id); }
let lastOnlineAt = Date.now();
const diagnostics = new DiagnosticLog();
let diagScanResult = null, scanSequence = 0, replacingCheckpoint = false;
let repairWrite;
function invalidateRepairWrite() {
  repairWrite?.abort(new Error('运行中的世界已更新，请重新扫描'));
}
const saveGeneration = get('saveGeneration').then(value => value ?? 0);
async function saveItems(entries) {
  invalidateRepairWrite();
  if (!started || replacingCheckpoint) return;
  return putMany(entries, { generation: await saveGeneration });
}
const historyQueues = new Map();
function authorNick(actor, fallback) { return actor === identity?.actor ? identity.nick : active().find(member => member.actor === actor)?.nick || world.data.participants[actor] || displayNick(fallback) || '匿名'; }
function rememberAuthor(actor, nick) { if (setParticipantName(world, actor, nick)) { renderedChatCount = -1; renderChat(); } }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000); }
function member() { return { replicaPages: 1, orderedSteps: 1, build: meta.version, id: network.node, actor: identity.actor, nick: displayNick(identity.nick), url: meta.url, at: Date.now(), visible: !document.hidden, peers: network.live().length }; }
function active() { return [...members.values()].filter(m => Date.now() - m.at < 120000); }
function leader() { return active().sort((a, b) => +b.visible - +a.visible || a.id.localeCompare(b.id))[0]?.id || network.node; }
function amLeader() { return !!network && leader() === network.node; }
let resumingInputs;
function orderedPeer() {
  if (resumingInputs || !started || updateFrozen || replacingCheckpoint || archiveImports || archiveBusy || !meta.version || !network) return;
  const peers = network.live(), people = active();
  if (peers.length !== 1 || people.length !== 2 || network.hasRelayedWorldPeer(peers)) return;
  const peer = peers[0], other = members.get(peer.node);
  if (other?.orderedSteps === 1 && other.build === meta.version && peer.replicaLive && peer.sentHello && peer.confirmedReplica && other.peers <= 1 &&
      !peer.replicaCatchingUp && (!amLeader() || !geometryRepair && !world.data.pendingChatGlyphs)) return peer;
}
function mayRetainWorker() {
  const peers = network.live(), winner = leader(), other = members.get(winner);
  return peers.length === 1 && active().length === 2 && peers[0].node === winner && peers[0].replicaLive &&
    other?.orderedSteps === 1 && other.build === meta.version && other.peers <= 1;
}
function orderedInputs(limit = 64) {
  return [...inbox.values()].filter(op => !rejectedOps.has(op.body.id) && (op.body.kind === 'referral' || !world.data.ops[op.body.id] && !archiveStore.ids.ops.has(op.body.id)))
    .sort((a, b) => a.body.t - b.body.t || a.body.id.localeCompare(b.body.id)).slice(0, limit);
}
function resumeOrderedInputs() {
  if (resumingInputs) return resumingInputs;
  const ops = orderedInputs(Infinity);
  if (!ops.length) return Promise.resolve();
  const target = world;
  resumingInputs = (async () => {
    const receipts = [];
    for (const op of ops) {
      if (!amLeader() || world !== target || ordered.current) break;
      const result = await applyAtBoundary(op, true);
      if (!result) break;
      if (!result.ok) rejectOperation(op.body.id);
      if (inbox.get(op.body.id)?.id === op.id) inbox.delete(op.body.id);
      if (pending.delete(op.body.id) && !result.ok) toast(result.error);
      receipts.push({ id: op.body.id, result });
    }
    if (receipts.some(({ result }) => result.ok)) await save({ reusePicture: true });
    if (world === target && amLeader()) {
      for (const receipt of receipts) await network.broadcast('ack', receipt);
    }
  })().finally(() => { resumingInputs = undefined; });
  return resumingInputs;
}
const ordered = new OrderedSession({
  world: () => world, store: () => archiveStore, peer: orderedPeer, leader, isLeader: amLeader, inputs: orderedInputs,
  send: (peer, body) => network.directControl(peer, 'orderedStep', body),
  validOp: async (target, op) => op.body.roots?.some(root => Object.hasOwn(target.data.roots, root)) &&
    !target.validOp(op.body) && (op.body.kind !== 'referral' || await verifyReferral(op.body)),
  async bondHistory(s, bonds) {
    const life = { ...newLife(s.base), bonds };
    const prior = await s.store.dependencies({ life }, s.world.data);
    const sources = { ops: { ...prior.ops, ...s.world.data.ops }, breeding: { ...prior.breeding, ...s.world.data.breeding }, roots: s.world.data.roots };
    if (!validateLife(life, sources)) throw new Error('伙伴历史缺少有效来源');
    const records = mergeBonds(s.world.data.life.bonds, bonds);
    return JSON.stringify(records) === JSON.stringify(s.world.data.life.bonds) ? s.world.data.life.bonds : records;
  },
  install: (target, changes, valid, apply) => atCheckpointBoundary(target.data, () => simulation.atStepBoundary(() => {
    if (valid()) apply(() => {
      if (changes.life && Object.keys(changes).length === 1) simulation.installLifeHistory(target, changes.life);
      else { worldEdited(target); Object.assign(target.data, changes); target.dirty = true; }
    });
  })),
  apply(target, op, archived) {
    const result = target.apply({ ...clone(op.body), proof: clone(op) }, archived);
    inbox.delete(op.body.id);
    if (!result.ok) rejectOperation(op.body.id);
    if (pending.delete(op.body.id) && !result.ok) toast(result.error);
    return result;
  },
  async inputsCommitted(ops, outcomes, owner) {
    if (outcomes.some(result => result.ok)) await save({ reusePicture: true });
    if (owner && amLeader()) for (const [i, op] of ops.entries()) await network.broadcast('ack', { id: op.body.id, result: outcomes[i] });
  },
  prepareArchive: (s, boundary) => prepareOrderedArchive(s.world, s.store, boundary,
    async id => await get('archive:' + id) || await requestArchive(id, s.peer),
    async chunks => putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded]), { generation: await saveGeneration }),
    diagnostics),
  archiveBoundary: (target, commit) => atCheckpointBoundary(target.data, () => simulation.archiveAtStepBoundary(target, commit)),
  archiveConfirmed: () => { renderChat(); save({ reusePicture: true }).catch(error => diagnostics.record('warn', 'archive', error.message)); },
  firstCommit: () => worldBroadcast.reset(),
  checkRetained: target => simulation.checkRetained(target, () => target === world && mayRetainWorker()),
  hasSavedCharacters: target => simulation.hasSavedCharacters(target),
  prepare: (target, valid, pages) => simulation.prepareAgreed(target, valid, pages),
  advance: (target, nextTick, valid, handle) => simulation.advanceAgreed(target, nextTick, valid, handle),
  stopped(session, reason) {
    diagnostics.record('info', 'ordered-steps', reason);
    if (session.executed && amLeader()) worldBroadcast.reset();
    if (amLeader()) resumeOrderedInputs().catch(error => diagnostics.record('warn', 'ordered-steps', error.message));
  }
});
subscribeSimulationChanges((target, patch) => ordered.changed(target, patch));
function runOrdered(action) {
  const task = action(), session = ordered.current;
  return task.catch(error => {
    if (ordered.current === session) ordered.stop(error.message);
    diagnostics.record('warn', 'ordered-steps', error.message);
  });
}
function pendingCost() {
  let total = 0;
  for (const [id, operation] of pending) if (!world.data.ops[id] && !archiveStore.ids.ops.has(id)) total += operation.cost || 0;
  return total;
}
function refreshDisplayedWorld() {
  if (displayedWorld !== world) {
    displayedWorld = world;
    displayedFish = Object.keys(world.data.fishes).length;
    displayedScenes = undefined;
  }
}
function balance() {
  if (!identity) return 20;
  refreshDisplayedWorld();
  return world.wallet(identity.actor) - pendingCost();
}
function updateCameraLabels() {
  $('depthLabel').textContent = `水深 ${Math.max(0, Math.round(renderer.camera.y))} 格 · ${renderer.camera.y < CONFIG.shallow ? '浅水区' : '深水区'}`;
  $('zoomLabel').textContent = Math.round(renderer.scale * 100) + '%';
  if (selected?.kind === 'fish') $('followFish').textContent = trackedFish === selected.id ? '停止跟随' : '跟随观察';
}
function update() {
  if (!identity) return;
  refreshDisplayedWorld();
  displayedScenes ??= sceneryCount(world.data);
  $('online').textContent = new Set(active().map(m => m.actor)).size || 1; $('fishCount').textContent = displayedFish; $('sceneCount').textContent = displayedScenes; $('balance').textContent = balance();
  const remain = Math.max(0, 3600 - Math.floor(identity.remainder || 0)); $('hourProgress').textContent = `下一鱼元 ${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
  $('worldLabel').textContent = world.roots.length > 1 ? `合流之海 · ${world.roots.length} 个起源` : '新生的海'; $('networkStatus').textContent = status || (network.live().length ? `伙伴已接入 · 世界由浏览器共同维持` : '独自在线，也可以开始创作');
  if (world.data.pendingChatGlyphs) $('networkStatus').textContent += ` · ${world.data.pendingChatGlyphs} 个聊天鱼元等待海底空位`;
  updateCameraLabels();
  $('networkDetails').textContent = `直连邻居 ${network.live().length}/8 · 已收 ${(network.stats.received / 1024).toFixed(0)} KB · 已发 ${(network.stats.sent / 1024).toFixed(0)} KB`;
  if ($('foodDialog').open) updateFoodBrush();
  if ($('creatorDialog').open) creator?.render();
  if ($('myFishDialog').open) renderMyFishes();
  if (selected) inspect(selected, false);
  renderLife();
}
async function remember(url) { try { if (!url) return; url = await normalizeInvite(url); if (url === meta?.url) return; if (!known.includes(url)) { known.push(url); saveItems([['known', known]]).catch(() => {}); } } catch { } }
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
async function ensureArchives(data, peer, bundle, target = archiveStore, current = {}, beforeIngest, archivePacks) {
  const load = async id => bundle ? bundle[id] : await get('archive:' + id) || (peer && await requestArchive(id, peer));
  const persist = peer && (chunks => putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded])));
  const ingest = async chunks => {
    const live = target === archiveStore, revision = target.revision;
    if (live) archiveImports++;
    try { for (const chunk of chunks) await target.ingest(chunk, chooseClaim); }
    finally {
      if (live) {
        archiveImports--;
        if (target === archiveStore && revision !== target.revision) worldEdited(world, 'archive');
      }
    }
  };
  return loadReplicaArchives(data, target, load, { current, persist, diagnostics, beforeIngest, ingest, archivePacks });
}
async function archiveWorld(now = Date.now()) {
  if (updateFrozen || archiveScanning || replacingCheckpoint || !amLeader() || now - archiveCheckAt < 60000) return;
  archiveCheckAt = now; archiveScanning = true;
  const target = world, store = archiveStore;
  const initialRevision = store.revision;
  const dependencies = observeArchiveDependencies(target);
  let committed = false;
  const isCurrent = () => target === world && store === archiveStore;
  const canArchive = () => isCurrent() && !updateFrozen && !replacingCheckpoint && amLeader();
  try {
    const pressure = await reachesArchiveThreshold(target.data);
    if (now - (target.data.archives?.at || 0) < ARCHIVE.period && !pressure) return;
    const plan = await archivePlanAsync(target.data, now, { pressure, dependencies });
    if (!canArchive()) return;
    const hasNewRecords = Object.values(plan).some(table => Object.keys(table).length);
    const chunks = hasNewRecords ? await archiveChunks(plan, target.data.roots) : [];
    if (!canArchive()) return;
    if (chunks.length) await putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded]), { generation: await saveGeneration });
    if (!canArchive()) return;
    const session = ordered.current;
    if (session && await ordered.whenJoined(session)) {
      const boundary = { version: 1, at: now, chunks: Object.fromEntries(chunks.map(({ manifest }) => [manifest.id, manifest])) };
      if (await ordered.proposeArchive(boundary)) return;
      if (!canArchive()) return;
    }
    const mealTargets = new Set();
    if (hasNewRecords) {
      ordered.stop('历史归档发生变化');
      archiveBusy = true;
      for (const chunk of chunks) await store.ingest(chunk, chooseClaim, mealTargets);
      target.data.archives ||= emptyArchiveState();
      for (const { manifest } of chunks) target.data.archives.chunks[manifest.id] = manifest;
    }
    const compact = await prepareCompaction(target, store, dependencies);
    const changed = await simulation.archiveAtStepBoundary(target, () => {
      if (!isCurrent() || (!hasNewRecords && !canArchive())) return;
      ordered.stop('历史归档时刻已更新');
      const removed = compact();
      (target.data.archives ||= emptyArchiveState()).at = now;
      if (!hasNewRecords && !removed) return;
      const meals = Array.from(mealTargets, id => [id, store.summary.lastMeals.get(id), store.summary.grassMeals.has(id)]);
      committed = true;
      return { removed: removed || {}, meals };
    });
    if (!changed) return;
    archiveBusy = true;
    await save({ reusePicture: true }); await broadcastWorld(); renderChat();
  } catch (error) {
    if (!committed && isCurrent() && store.revision !== initialRevision) worldEdited(target);
    status = '记忆整理稍后重试：' + error.message;
  } finally { dependencies.close(); archiveBusy = false; archiveScanning = false; }
}
async function requestHistory(peer) { const ids = (historyQueues.get(peer.id) || []).filter(id => !histories[id]); historyQueues.set(peer.id, ids); if (ids.length) await network.direct(peer, 'historyRequest', { ids: ids.slice(0, 32) }); else historyQueues.delete(peer.id); }
function needsReplicaSave(incoming, current, store) {
  if (['ops', 'scenes', 'chats', 'chatSources'].some(field => Object.keys(incoming[field] || {}).length)) return true;
  if (Object.keys(incoming.roots).some(root => !Object.hasOwn(current.roots, root))) return true;
  if (incoming.terrain && (incoming.terrain.seed !== current.terrain?.seed || incoming.terrain.createdAt !== current.terrain?.createdAt)) return true;
  if (Object.keys(incoming.archives?.chunks || {}).some(id => !Object.hasOwn(current.archives?.chunks || {}, id))) return true;
  if (Object.values(incoming.breeding || {}).some(record => record.status !== 'active' && current.breeding?.[record.id]?.status !== record.status)) return true;
  if (['chars', 'travel'].some(field => store.ids[field].size && Object.keys(incoming[field] || {}).some(id => store.ids[field].has(id)))) return true;
  return Object.keys(priorCheckpoint?.world?.roots || {}).some(root => Object.hasOwn(current.roots, root));
}
async function mergeVerifiedWorld(data, peer, context, { local = false, worldMessage } = {}) {
  const target = world, store = archiveStore, revision = store.revision;
  const delta = context === 'world-delta';
  let incoming = data, archived, checkedRules;
  await ensureArchives(data, peer, null, store, target.data, async (sources, current) => {
    archived = sources;
    const options = { context, current, diagnostics };
    if (local) incoming = await verifyLocalCheckpoint(data, sources, store, options);
    else checkedRules = await verifyReplica(data, sources, store, { ...options, mergeCut: delta && current === target.data });
  }, worldMessage?.body.archivePacks);
  // Overlapping archive rows have a canonical winner after ingestion.
  if (revision !== store.revision) archived = await store.dependencies(incoming, target.data);
  const commit = () => {
    if (target !== world || store !== archiveStore) throw new Error('运行世界已更换，请重新同步');
    if (worldMessage && (worldMessage.from !== leader() || replacingCheckpoint || updateRestarting)) {
      replicaRecovery.ignore(worldMessage);
      return { ignored: true };
    }
    const rootCount = target.roots.length;
    const routine = delta && !needsReplicaSave(incoming, target.data, store);
    const apply = () => {
      const index = delta && renderer.currentIndex(target);
      let changes;
      try { changes = target.merge(incoming, archived, delta ? 'replica' : undefined, delta, checkedRules); }
      finally { if (delta) noteCheckpointMerge(target.data, changes, incoming, archived); }
      if (delta) pictures.merged(target, changes);
      if (index) renderer.applyMerge(target, index, changes);
    };
    let movement;
    if (worldMessage && worldMessage.from !== network.node) movement = replicaSwims.merge(target.data, worldMessage, apply);
    else { apply(); replicaSwims.reset(); }
    if (worldMessage && !delta) {
      const orderedRepair = peer?.replicaLive && peer.node === worldMessage.from && worldMessage.body.repairFor === network.node;
      replicaRecovery.covered(worldMessage, orderedRepair ? worldMessage.body.request : undefined, orderedRepair);
    }
    if (target.archives !== store) target.attachArchives(store);
    return { joinedWorld: target.roots.length > rootCount, movement, routine };
  };
  return delta ? atCheckpointBoundary(target.data, commit) : commit();
}
function presentReplicaMovement(movement) {
  if (movement && movement === replicaSwims.latest && movement.data === world.data && movement.tick === world.data.tick && movement.from === leader()) {
    renderer.presentSwims(world, movement.directions, movement.startedAt);
  }
}
async function mergeReplica(data, peer, context = 'merge', worldMessage) {
  const previousTerrain = world.data.terrain?.seed;
  const { joinedWorld, movement, routine, ignored } = await mergeVerifiedWorld(data, peer, context, { worldMessage });
  if (ignored) return;
  presentReplicaMovement(movement);
  if (context === 'world-delta' && worldMessage) {
    const repair = replicaRecovery.request(worldMessage);
    if (repair) network.broadcast('replicaRequest', repair).catch(() => {});
  }
  if (!routine) {
    await compactKnown(world, archiveStore);
    if (world.data.terrain?.seed !== previousTerrain) geometryRepair = true;
  }
  for (const member of active()) setParticipantName(world, member.actor, member.nick);
  if (identity) setParticipantName(world, identity.actor, identity.nick);
  if (routine) return false;
  // An expired local copy can be restored only after hearing its roots from a live peer.
  const checkpoint = priorCheckpoint; let recovered = false;
  if (checkpoint?.world?.roots && Object.keys(checkpoint.world.roots).some(r => world.roots.includes(r))) {
    const checkpointStore = newArchiveStore();
    await ensureArchives(checkpoint.world, peer, null, checkpointStore);
    const older = await checkpointStore.dependencies(checkpoint.world);
    const local = await verifyLocalCheckpoint(checkpoint.world, older, checkpointStore, { diagnostics });
    await mergeVerifiedWorld(local, peer, 'checkpoint');
    if (priorCheckpoint === checkpoint) priorCheckpoint = null;
    recovered = true;
  }
  for (const id of pending.keys()) if (world.data.ops[id] || archiveStore.ids.ops.has(id)) pending.delete(id);
  reconcileHistory(); syncIncomeSerial();
  const saved = save({ reusePicture: true });
  // A live receipt confirms the verified in-memory base for the next delta.
  // Its archive chunks are already durable. The local checkpoint owns its cut.
  if (worldMessage && context === 'world-delta' && !joinedWorld && !recovered) saved.catch(reportSaveError);
  else await saved;
  renderChat();
  if (joinedWorld) toast('两片海合流了');
  if (recovered) await network.broadcast('merge', { world: await captureReplica() }, { capturedWorld: true });
  return true;
}
function resumeAfterInactivity(now = Date.now()) { if (!resumeTask) resumeTask = resumeWorld(now).finally(() => { resumeTask = null; }); return resumeTask; }
async function resumeWorld(now) {
  const elapsed = now - lastOnlineAt;
  if (elapsed > 120000) {
    simulation.close();
    const checkpoint = await captureLocalCheckpoint();
    if (now - lastOnlineAt >= CONFIG.offlineLife) checkpoint.world.chats = await archiveStore.chats(Infinity, checkpoint.world.chats, checkpoint.world.archives);
    const restored = restoreCheckpoint(checkpoint, now);
    if (restored.expired) {
      const card = await endedCard(checkpoint, restored.expiresAt); priorCheckpoint = checkpoint; world = restored.world;
      archiveStore = newArchiveStore(); world.attachArchives(archiveStore); olderChats = {}; acceptHistory(card);
      chatLimit = 80; renderChat();
      pictures.latest = null; pending.clear(); inbox.clear(); selected = null; trackedFish = null; renderer.selected = null; renderer.observedFish = null; $('inspector').hidden = true; cancelMode();
    } else { world.resolveLegends(now); world.resolvePopulation(now); world.data.tick = now; }
    members.clear(); members.set(network.node, member()); lastHello.clear(); lastLeader = ''; worldBroadcast.reset(); replicaSwims.reset(); replicaRecovery.clear(); lastPictureTime = 0;
  }
  lastOnlineAt = Math.max(lastOnlineAt, now);
  if (elapsed > 120000) { networkChange().catch(() => {}); reconnect().catch(() => {}); }
}
function reconcileHistory() {
  let changed = false; for (const card of Object.values(histories)) if (card.roots.some(r => world.roots.includes(r)) && card.status !== 'corrected') { card.status = 'corrected'; changed = true; } if (changed) saveItems([['histories', histories]]).catch(() => {});
}
function validHistoryCard(card) {
  if (!Array.isArray(card?.roots) || !card.roots.length || !card.roots.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) ||
      typeof card.image !== 'string' || card.image.length > 3000000 || !/^data:image\/(webp|png);base64,/.test(card.image)) return false;
  const roots = new Set(card.roots);
  return Object.keys(card.archiveRoots || {}).every(root => roots.has(root)) &&
    Object.values(card.chats || {}).every(message => Array.isArray(message?.body?.roots) && message.body.roots.some(root => roots.has(root)));
}
function acceptHistory(card, persist = true) {
  if (!validHistoryCard(card)) return;
  let target = clone(card);
  const replaced = [];
  for (const [id, existing] of Object.entries(histories)) if (existing.roots.some(r => target.roots.includes(r))) {
    target = { ...(existing.at > target.at ? existing : target), roots: [...new Set([...existing.roots, ...target.roots])],
      chats: mergeChatRecords(existing.chats, target.chats), archives: mergeArchiveState(existing.archives, target.archives),
      archiveRoots: { ...existing.archiveRoots, ...target.archiveRoots }, chatCount: Math.max(existing.chatCount || 0, target.chatCount || 0) };
    replaced.push(id);
  }
  for (const id of replaced) delete histories[id];
  target.id = target.roots.slice().sort()[0]; if (target.roots.some(r => world.roots.includes(r))) target.status = 'corrected'; histories[target.id] = target; if (persist) saveItems([['histories', histories]]).catch(() => {});
  for (const message of orderedChats(target.chats || {})) if (message.body.roots.some(root => world.roots.includes(root))) { const result = world.addChat(message); if (!result.ok) throw new Error(result.error); }
  renderChat();
}
async function onMessage(message, peer) {
  if (message.kind === 'archiveRequest') { const encoded = archiveStore.packs.get(message.body.id) || await get('archive:' + message.body.id); await network.direct(peer, encoded ? 'archiveChunk' : 'archiveMissing', { id: message.body.id, encoded }); return; }
  if (message.kind === 'archiveChunk' || message.kind === 'archiveMissing') { const waiting = archiveWaiters.get(message.body.id); if (waiting?.peer === message.from) { if (message.kind === 'archiveChunk') waiting.resolve(message.body.encoded); else waiting.reject(new Error('伙伴没有这份归档')); } return; }
  await resumeAfterInactivity();
  if (members.has(message.from) && members.get(message.from).actor !== message.actor) return false;
  const body = message.body;
  if (message.kind === 'orderedStep') {
    if (peer.node !== message.from || members.get(message.from)?.actor !== message.actor) return;
    await runOrdered(() => ordered.receive(peer, body));
    return;
  }
  if (message.kind === 'hello') {
    if (!body.world?.terrain || !rulesCompatible(body.rules)) {
      if (!peer.silent) { status = '对方使用不兼容的世界规则，请双方更新后再连接'; toast(status); }
      network.close(peer); update(); return;
    }
    if (message.from !== peer.node || body.member?.id !== message.from || body.member.actor !== message.actor) return;
    const newKnowledge = Object.keys(body.world.roots || {}).some(r => !world.data.roots[r]) || Object.keys(body.world.ops || {}).some(id => !world.data.ops[id]) || Object.keys(body.world.chats || {}).some(id => !world.data.chats[id]) || Object.keys(body.world.chatSources || {}).some(id => !world.data.chatSources[id]);
    await mergeReplica(body.world, peer, 'hello'); geometryRepair = true;
    replicaRecovery.covered(message);
    const own = body.member; members.set(own.id, { ...own, url: peer.url, at: Date.now() }); remember(peer.url);
    rememberAuthor(message.actor, own.nick);
    for (const m of body.members || []) remember(m.url);
    if (newKnowledge) await network.broadcast('merge', { world: body.world }, { capturedWorld: true });
    reconcileHistory(); syncIncomeSerial(); lastPictureTime = 0;
    for (const card of body.cards || []) { await receiveHistory(card, peer); }
    await save();
    const missing = (body.historyIndex || []).filter(id => !histories[id]); if (missing.length) { historyQueues.set(peer.id, missing); await requestHistory(peer); }
    await completeReferral(peer, message.actor);
    status = ''; update();
  } else if (message.kind === 'beat') {
    if (body.member?.id === message.from && body.member.actor === message.actor) {
      const direct = network.live().find(p => p.node === message.from);
      members.set(message.from, { ...body.member, direct: !!direct, url: await normalizeInvite(direct?.url || body.member.url), at: Date.now() });
      remember(body.member.url); rememberAuthor(message.actor, body.member.nick);
      // The ordered world stream checks these counts after the matching data commits.
      // Legacy and indirect peers still audit history through their heartbeat.
      if (!(body.inventoryOnWorld === true && direct?.replicaLive && direct.confirmedReplica && message.from === leader())) {
        checkReplicaInventory(body, message.from, false);
      }
    }
  } else if (message.kind === 'merge') {
    await mergeReplica(body.world, peer, 'merge'); geometryRepair = true; reconcileHistory(); syncIncomeSerial(); update();
    if (!body.base && body.repairFor === network.node && typeof body.request === 'string') replicaRecovery.covered(message, body.request);
  } else if (message.kind === 'replicaRequest') {
    if (body.to === network.node) {
      const repair = typeof body.request === 'string' && body.request.length === 36 ? { repairFor: message.from, request: body.request } : {};
      if (repair.request && amLeader() && peer?.node === message.from && peer.replicaLive && peer.sentHello && peer.confirmedReplica) {
        network.replicas.repairLive(peer, async () => ({ ...repair, delta: false, world: await captureReplica() }));
      } else await network.broadcast('merge', { ...repair, world: await captureReplica() }, { capturedWorld: true });
    }
  } else if (message.kind === 'world') {
    if (message.from !== leader()) { replicaRecovery.ignore(message); return false; }
    if (replicaRecovery.gap(message, world.data.tick)) {
      const repair = replicaRecovery.request(message);
      if (repair) await network.broadcast('replicaRequest', repair);
      return false;
    }
    try {
      const changed = await mergeReplica(body.world, peer, body.delta ? 'world-delta' : 'world-full', message);
      if (changed !== undefined) runOrdered(() => ordered.afterReplica());
      if (changed) update();
      if (changed !== undefined && body.settledRecords && peer?.replicaLive && peer.node === message.from && message.from === leader()) {
        checkReplicaInventory(body, message.from, true);
      }
      return changed !== undefined;
    }
    catch (error) {
      if (body.delta && Date.now() - lastRepair > 5000) {
        lastRepair = Date.now();
        await network.broadcast('replicaRequest', { to: message.from });
      }
      throw error;
    }
  } else if (message.kind === 'op') {
    if (body.actor !== message.actor || !Array.isArray(body.roots) || !body.roots.some(r => world.roots.includes(r))) return;
    if (rejectedOps.has(body.id)) return;
    if (body.kind === 'referral' && !await verifyReferral(body)) return;
    inbox.set(body.id, clone(message));
    if (amLeader() && !ordered.current) {
      const result = await applyAtBoundary(message, true);
      if (!result) return;
      if (result.ok) await save({ reusePicture: true }); else rejectOperation(body.id);
      await network.broadcast('ack', { id: body.id, result });
      if (result.ok) await broadcastWorld();
    }
  } else if (message.kind === 'ack') {
    if (message.from !== leader()) return; if (!body.result.ok) rejectOperation(body.id); const op = pending.get(body.id); if (op && !body.result.ok) { pending.delete(body.id); toast(body.result.error); update(); }
  } else if (message.kind === 'chat') {
    const result = world.addChat(message); if (!result.ok || result.duplicate) return; renderChat(); await save({ reusePicture: true });
  } else if (message.kind === 'picture') {
    if (message.from === leader() && body.roots.some(r => world.roots.includes(r))) pictures.latest = body;
  } else if (message.kind === 'historyRequest') {
    const ids = (body.ids || []).slice(0, 32); for (const id of ids) if (histories[id]) await network.direct(peer, 'history', { card: histories[id] });
    await network.direct(peer, 'historyEnd', { ids });
  } else if (message.kind === 'history') { await receiveHistory(body.card, peer); await save({ reusePicture: true }); }
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
    const result = await applyAtBoundary(message, false);
    if (!result) return;
    if (!result.ok) throw new Error(result.error);
    registration.joined = true; registration.referral = message; await save({ reusePicture: true }); await network.broadcastEnvelope(message);
  } finally { referralBusy = false; }
}
async function networkChange(error) {
  if (!started) return; if (error) { status = error; update(); return; }
  const live = network.live();
  for (const p of live) if (!lastHello.has(p.id)) {
    lastHello.add(p.id);
    try {
      await network.direct(p, 'hello', { rules: WORLD_RULES, member: member(), members: active(), world: await captureReplica(), cards: Object.values(histories).slice(0, 3), historyIndex: Object.keys(histories) },
        () => worldBroadcast.captureJoined(world.data, captureReplica), { capturedWorld: true });
      if (!p.replicaPages) worldBroadcast.reset();
    } catch (error) {
      network.close(p, error);
      if (!p.silent) { status = error.message; update(); }
    }
  }
  const ids = new Set(live.map(p => p.node)); for (const m of active()) if (m.id !== network.node && m.direct && !ids.has(m.id)) { m.direct = false; probeGone(m.id, m.url); } for (const id of ids) if (members.has(id)) members.get(id).direct = true;
  network.presence(active().filter(m => m.id !== network.node).map(m => ({ id: m.id, url: m.url }))).catch(() => {}); update();
}
async function probeGone(id, url) { if (!id || id === network.node || !members.has(id)) return; try { url = await normalizeInvite(url); const s = await network.local('probe', { url }); if (!(s.clients || []).some(c => c.id === id)) { members.delete(id); await network.broadcast('lost', { id, url }); update(); } } catch { /* Membership lease expires if the publishing computer is unreachable. */ } }
async function broadcastWorld(directions) {
  if (!amLeader()) return;
  const now = Date.now();
  try { await worldBroadcast.send(network, world.data, now, captureReplica, directions,
    () => replicaInventory.atPublication(world.data, archiveStore, now)); }
  catch (error) { status = error.message; }
}
function checkReplicaInventory(body, from, ordered) {
  const now = Date.now();
  if (now - lastRepair <= 5000 || !replicaInventory.missing(body, world.data, archiveStore)) return;
  lastRepair = now;
  network.broadcast('replicaRequest', { to: from, ...(ordered && { request: crypto.randomUUID() }) }).catch(() => {});
}
async function applyAtBoundary(message, requiresLeader) {
  const target = world, store = archiveStore;
  const archived = await store.get('ops', message.body.id);
  return simulation.atStepBoundary(() => {
    if (target !== world || store !== archiveStore || replacingCheckpoint || updateFrozen || (requiresLeader && !amLeader())) return null;
    return target.apply({ ...clone(message.body), proof: clone(message) }, archived);
  });
}
async function submit(payload) {
  if (updateFrozen) { toast('正在更新并重启，请稍候'); return; }
  if (started) await resumeAfterInactivity();
  if (updateFrozen) { toast('正在更新并重启，请稍候'); return; }
  if (!identity) return; const op = { id: payload.kind === 'earn' ? `${identity.actor}:hour:${payload.serial}` : crypto.randomUUID(), actor: identity.actor, nick: displayNick(identity.nick), t: Date.now(), roots: [world.id], cost: 0, ...payload };
  if (op.cost > 0 && op.cost > balance()) { toast('鱼元余额不足'); return; } pending.set(op.id, op); update();
  try {
    const message = await network.broadcast('op', op);
    if (rejectedOps.has(op.id)) { pending.delete(op.id); update(); return; }
    inbox.set(op.id, clone(message));
    const result = amLeader() && !ordered.current && await applyAtBoundary(message, true);
    if (result) {
      pending.delete(op.id);
      if (!result.ok) { rejectOperation(op.id); toast(result.error); }
      else await save({ reusePicture: true });
      await broadcastWorld();
    } else {
      setTimeout(() => { if (pending.has(op.id)) toast('这次投放仍在等待确认，连接恢复后同步'); }, 12000);
    }
  } catch (e) { pending.delete(op.id); toast(e.message); }
  update();
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
  moveCameraToFish(renderer.fishPose(world, id, performance.now()), body); update();
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
    const illness = illnessOf(world.data, fish.id);
    entry.title.textContent = displayFishName(catalog.get(fish.id), identity); renderFishGender(entry.gender, fish); entry.health.textContent = illness ? `抑郁 · 约${Math.max(0, ((illness.nextLossAt ?? illness.at + POPULATION.dissolveEvery) - now) / 60000).toFixed(0)}分钟后消散1字 · 需「乐」` : status.hungry ? '饥饿' : '未饥饿'; entry.health.classList.toggle('hungry', !!illness || status.hungry);
    renderBreeding(entry.breeding, fish, now);
    entry.info.textContent = `${identity.nick} · ${shortFishId(fish.id)} · ${cells.length} 鱼元 · ${fish.birth ? '自然出生于' : '创建于'} ${fishDate.format(fish.created)}`;
    entry.metrics.textContent = `${fishLifeText(world.data, fish.id, now).habit} · 今日运动 ${status.trackedSince === undefined ? '待同步' : status.movement.toFixed(1) + ' 格'} · 近24小时进食 ${status.meals24} 颗`;
    drawFishThumbnail(entry.canvas, fish, cells);
  }
  if (myFishListKey !== key) { $('myFishList').replaceChildren(...fishes.map(fish => myFishCards.get(fish.id).card)); myFishListKey = key; }
  if (myFishView === 'pedigree') renderPedigree(catalog);
}
function setMyFishView(view) {
  $('myFishTitle').textContent = view === 'pedigree' ? '鱼谱' : '我的鱼';
  $('myFishDialog').classList.toggle('pedigreeView', view === 'pedigree');
  myFishView = view; $('myFishList').hidden = view !== 'list'; $('pedigreePane').hidden = view !== 'pedigree';
  $('myFishIntro').textContent = view === 'list' ? '点击鱼卡即可定位并观察，默认不跟随；可在观察面板手动开启跟随。这里只列出当前世界中属于你的存活鱼。' : '父母在上，后代在下。鱼谱包含血缘相关的其他作者鱼，已消失的亲鱼仍保留在家谱中。';
  for (const [id, selected] of [['myFishListTab', view === 'list'], ['pedigreeTab', view === 'pedigree']]) { $(id).classList.toggle('active', selected); $(id).setAttribute('aria-pressed', String(selected)); }
  renderMyFishes();
}
function renderPedigree(catalog) {
  const owned = [...catalog.values()].filter(entry => entry.actor === identity.actor).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  if (!catalog.has(pedigreeFish)) pedigreeFish = (owned.find(entry => entry.alive) || owned[0])?.id;
  const choices = owned.some(entry => entry.id === pedigreeFish) || !catalog.has(pedigreeFish) ? owned : [catalog.get(pedigreeFish), ...owned];
  const heirloom = ancestralGlyph(world.data, pedigreeFish);
  $('pedigreeHeirloom').textContent = ancestralText(heirloom, id => displayFishName(catalog.get(id), identity)); $('pedigreeHeirloom').hidden = !heirloom;
  const key = JSON.stringify([pedigreeFish, [...catalog.values()].map(entry => [entry.id, displayFishName(entry, identity), entry.nick, entry.gender, entry.alive, entry.parents])]);
  if (pedigreeKey === key) return; pedigreeKey = key;
  $('pedigreeRoot').replaceChildren(...choices.map(entry => { const option = document.createElement('option'); option.value = entry.id; option.textContent = `${displayFishName(entry, identity)} · ${shortFishId(entry.id)}${entry.actor === identity.actor ? '' : ` · ${entry.nick || '自然鱼'}`}${entry.alive ? '' : '（已消失）'}`; return option; }));
  $('pedigreeRoot').disabled = !choices.length; if (pedigreeFish) $('pedigreeRoot').value = pedigreeFish;
  const viewport = $('pedigreeTree'), scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
  const tree = drawPedigree(viewport, catalog, pedigreeFish, identity, id => { $('myFishDialog').close(); focusFish(id); });
  viewport.style.height = `${Math.min(480, tree.height)}px`;
  $('pedigreeCount').textContent = tree.nodes.length ? `${tree.nodes.length} 条鱼 · ${tree.generations} 代` : '暂无鱼谱'; viewport.scrollLeft = scroll.left; viewport.scrollTop = scroll.top;
}
function inspect(hit, show = true) {
  if (show || trackedFish && (hit.kind !== 'fish' || hit.id !== trackedFish)) trackedFish = null;
  selected = hit; if (hit.kind === 'monument') { renderer.observedFish = null; renderer.selected = null; $('inspector').hidden = true; historyDialog(); selected = null; return; }
  if (hit.kind === 'ecosystem') {
    renderer.observedFish = renderer.selected = null; $('fishDetails').hidden = $('chatMemory').hidden = $('sceneActions').hidden = true; $('eventDetails').hidden = false;
    $('objectTitle').textContent = { predator: '海洋食肉鱼', volcano: '海底火山', rock: '冷却的火山岩' }[hit.id];
    $('objectInfo').textContent = '自然生态 · 无需鱼元';
    $('eventText').textContent = hit.id === 'predator' ? '鱼群超过200条时出现，最多4条。优先追逐视野内的患病鱼，只捕食不超过8字且出生已满两小时的鱼；造景可阻挡，每条至少30分钟吃一次，全海至少间隔10分钟。' : hit.id === 'volcano' ? '喷发前预警30秒，最多喷出32个红色「浆」。岩浆先上升再慢慢落下，真实碰到的鱼会死亡；每个字出生10分钟后冷却为灰色「岩」。远离喷口与落点。' : '「浆」冷却成「岩」，堆积在海底形成新的障碍与地貌。天然岩石不能搬动或删除，全海最多保留2000块。';
    $('objectFootnote').textContent = '自然生态随存档与联机保存。'; if (show) $('inspector').hidden = false; return;
  }
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
    const illness = illnessOf(world.data, hit.id);
    if (illness) { $('fishHunger').textContent = '抑郁'; $('fishHunger').classList.add('hungry'); $('objectFootnote').textContent = `拥挤导致抑郁，每小时随机消散一块鱼元，约 ${Math.max(0, Math.ceil(((illness.nextLossAt ?? illness.at + POPULATION.dissolveEvery) - now) / 60000))} 分钟后发生下一次。消散的字不会变成鱼食；鱼身不足两个相连鱼元时自然结束。存活期间吃到「${POPULATION.remedy}」字鱼食即可康复，普通食物不能治愈。治愈后24小时内不再患病；进食仍遵守60分钟间隔。`; }
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
  const eruption = world.data.population?.eruption, volcanic = eruption && (Date.now() < eruption.at + POPULATION.warning || Object.keys(eruption.particles).length);
  $('ambientPeek').hidden = !myth && !occasion && !volcanic || !!selected || !!mode || !!document.querySelector('dialog[open]');
  if (volcanic) $('ambientPeek').textContent = `${Date.now() < eruption.at + POPULATION.warning ? '海底火山即将喷发' : '火山岩浆正在冷却'} · 看看 ›`;
  else if (myth) $('ambientPeek').textContent = `${Date.now() - myth.started < 20000 && myth.kind !== 'ship' ? '海床传来异动' : legendTitle(myth.kind)} · 看看 ›`;
  else if (occasion) $('ambientPeek').textContent = `${eventTitle(occasion.kind)} · 看看 ›`;
  const stories = storiesFor(world.data, { get: id => world.fishOrigin(id) }, identity.actor);
  const latest = returnStory(stories, lifeSince);
  if (latest) lifeMessage = latest;
  if (lifeMessage && !world.data.life?.stories[lifeMessage.id]) lifeMessage = null;
  $('lifeNote').hidden = !lifeMessage || !!selected || !!mode || !!document.querySelector('dialog[open]');
  if (lifeMessage) {
    $('lifeHeading').textContent = returnVisit ? '你不在的时候，海里发生了…' : '海里的小故事';
    const catalog = fishCatalog(world.data);
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
const pictures = new CheckpointPictures(() => world, target => renderer.snapshotAsync(target));
subscribeSimulationChanges((target, patch, source, merge) => pictures.changed(target, patch, source, merge));
async function captureLocalCheckpoint() {
  for (;;) {
    const picture = pictures.atCut(await pictures.prepare());
    if (picture) return { world: world.serialize(), picture, at: Date.now(), lastOnlineAt };
  }
}
async function endedCard(checkpoint, endedAt) {
  const roots = Object.keys(checkpoint.world.roots).sort(), chunks = await archiveChunks(Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, checkpoint.world[f] || {}])), checkpoint.world.roots);
  await putMany(chunks.map(chunk => ['archive:' + chunk.manifest.id, chunk.encoded]));
  let archives = checkpoint.world.archives || emptyArchiveState(); for (const chunk of chunks) { await archiveStore.ingest(chunk, chooseClaim); archives = mergeArchiveState(archives, { version: 1, at: endedAt, chunks: { [chunk.manifest.id]: chunk.manifest } }); }
  const remainingChats = Object.fromEntries(Object.entries(checkpoint.world.chats || {}).filter(([id]) => !archiveStore.ids.chats.has(id)));
  return { ...checkpoint.picture, counts: { ...checkpoint.picture?.counts, scene: sceneryCount(checkpoint.world) }, id: roots[0], roots, chats: remainingChats, chatCount: Object.keys(checkpoint.world.chats || {}).length, archives, archiveRoots: checkpoint.world.roots, status: 'ended', endedAt };
}
async function historyArchiveStore(card, peer, bundle) {
  const roots = card.archiveRoots || {};
  const key = Object.keys(card.archives?.chunks || {}).sort().join(',') + JSON.stringify(Object.entries(roots).sort(([a], [b]) => a.localeCompare(b)));
  const store = (!bundle && historyArchiveStores.get(key)) || newArchiveStore(bundle);
  const records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  await ensureArchives({ protocol: 1, roots, archives: card.archives, ...records }, peer, bundle, store);
  if (!bundle) {
    historyArchiveStores.delete(key);
    historyArchiveStores.set(key, store);
    if (historyArchiveStores.size > 2) historyArchiveStores.delete(historyArchiveStores.keys().next().value);
  }
  return store;
}
async function receiveHistory(card, peer) {
  if (!validHistoryCard(card)) throw new Error('历史世界无效');
  const store = await historyArchiveStore(card, peer);
  await verifyChats(card.chats, store, world.data);
  const sharesRoots = card.roots.some(root => world.roots.includes(root));
  const chats = sharesRoots ? await store.chats(Infinity, card.chats || {}, card.archives) : {};
  const joining = Object.values(chats).filter(message => message.body.roots.some(root => Object.hasOwn(world.data.roots, root)));
  const existing = joining.filter(({ id }) => world.data.chats[id] || world.data.chatSources[id] || archiveStore.ids.chats.has(id) || archiveStore.ids.chatSources.has(id));
  await verifyChats(Object.fromEntries(existing.map(message => [message.id, message])), archiveStore, world.data);
  acceptHistory(card);
  for (const message of joining) { const result = world.addChat(message); if (!result.ok) throw new Error(result.error); }
  renderChat();
}
subscribeSimulationChanges((current, patch, origin, merge) => {
  // Importing a verified archive updates the cold index. The checkpoint head
  // always captures its manifest. Compaction publishes the exact live deletions.
  if (origin !== 'archive') noteCheckpointChanges(current.data, patch, merge);
});
subscribeBeforeSimulationPatch((current, patch) => beforeCheckpointPatch(current.data, patch));
async function saveInternal({ capture = false, mirrorLegacy = false, reconciledRevision, reusePicture = false } = {}) {
  if (replacingCheckpoint) throw new Error('正在更换存档');
  const changedPictureWorld = Symbol();
  const task = (async () => {
    const generation = await saveGeneration;
    for (;;) {
      const useRecent = reusePicture && pictures.hasRecent();
      const prepared = useRecent ? null : await pictures.prepare();
      try {
        return await putMany(() => {
          const picture = useRecent ? pictures.recent() : pictures.atCut(prepared);
          if (!picture) throw changedPictureWorld;
          const checkpoint = { world: world.data, picture, at: Date.now(), lastOnlineAt };
          return [['identity', identity], ['histories', histories], ['known', known], ['checkpoint', checkpoint]];
        }, { simulationChanges: true, captureCheckpoint: capture, mirrorLegacy, reconciledRevision, generation });
      } catch (error) {
        if (error !== changedPictureWorld) throw error;
      }
    }
  })();
  activeSavePromise = task;
  try { return await task; } finally { if (activeSavePromise === task) activeSavePromise = null; }
}
async function save(options) { if (!started || updateFrozen || replacingCheckpoint) return; return saveInternal(options); }
function reportSaveError(error) { toast('本地保存失败：' + error.message); }
async function saveHandoff({ mirrorLegacy = false, startup = false } = {}) {
  if (!started && !startup) throw new Error('世界尚未启动，暂时无法交接进度');
  let revision;
  if (activeSavePromise) {
    try { await activeSavePromise; }
    catch (error) { if (error.name !== 'CheckpointConflictError') throw error; }
  }
  for (;;) {
    try { return await saveInternal({ mirrorLegacy, reconciledRevision: revision }); }
    catch (error) { if (error.name !== 'CheckpointConflictError') throw error; }
    const saved = await readHandoffCheckpoint(), other = saved.identity, data = saved.checkpoint.world;
    if (saved.generation !== await saveGeneration) throw new Error('存档已在其他页面更换，请刷新后再试');
    if (other?.actor !== identity.actor || !world.roots.some(id => Object.hasOwn(data.roots, id))) {
      throw new Error('两个页面打开了不同的身份或世界。请先分别导出进度，再从最新页面继续。');
    }
    await mergeVerifiedWorld(data, null, 'handoff', { local: true });
    await compactKnown(world, archiveStore);
    for (const card of Object.values(saved.histories || {})) acceptHistory(card, false);
    known = [...new Set([...known, ...(saved.known || [])])];
    if (other.serial > identity.serial) {
      identity.serial = other.serial;
      identity.remainder = other.remainder;
    } else if (other.serial === identity.serial) identity.remainder = Math.max(identity.remainder || 0, other.remainder || 0);
    identity.lifeSeenAt = Math.max(identity.lifeSeenAt || 0, other.lifeSeenAt || 0);
    if (other.registration?.joined && !identity.registration?.joined) identity.registration = other.registration;
    lastOnlineAt = Math.max(lastOnlineAt, saved.checkpoint.lastOnlineAt || 0);
    syncIncomeSerial();
    revision = saved.revision;
  }
}
async function takePicture() {
  if (!amLeader()) return;
  let picture;
  do { picture = pictures.atCut(await pictures.prepare(true)); } while (!picture && amLeader());
  if (picture && amLeader() && network.live().length) await network.broadcast('picture', picture);
}
async function reconnect() {
  const params = new URLSearchParams(location.search), input = params.get('join') || meta.joinUrl;
  if (params.has('join')) { params.delete('join'); history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : '') + location.hash); }
  const urls = [...new Set([input, ...known].filter(Boolean))];
  for (const url of urls.slice(0, 12)) { if (network.live().length) break; try { await network.connectInvite(url, { silent: true }); remember(url); } catch { } }
}
async function start() {
  const generation = await saveGeneration;
  meta = await (await fetch('/local/meta')).json(); if (!meta.token) throw new Error('请运行自己的启动器，从固定本地地址进入');
  meta.assetSuffix = normalizeAssetSuffix(meta.assetSuffix);
  meta.url = await normalizeInvite(meta.url);
  $('currentVersion').textContent = `当前版本 ${meta.version || '未知'}`;
  const [owner, cards, invites, previous, storedGeneration, sawLegacyNotice] = await getMany(['identity', 'histories', 'known', 'checkpoint', 'saveGeneration', LEGACY_NOTICE_SEEN]);
  if ((storedGeneration ?? 0) !== generation) throw new Error('存档已在其他页面更换，请刷新后再试');
  identity = owner;
  histories = cards || {};
  if (!identity) {
    $('startupNotice').hidden = true;
    const showDiagnostics = $('diagnosticsDialog').open;
    if (showDiagnostics) $('diagnosticsDialog').close();
    $('welcomeDialog').showModal();
    if (showDiagnostics) $('diagnosticsDialog').showModal();
    await new Promise(resolve => {
      $('welcomeForm').onsubmit = async e => {
        e.preventDefault();
        const nick = $('nickInput').value.trim();
        if (!nick) return;
        try { identity = await newIdentity(nick, generation); }
        catch (error) { toast(error.message); return; }
        $('welcomeDialog').close();
        $('startupNotice').hidden = false;
        resolve();
      };
    });
  }
  lifeSince = Number.isFinite(identity.lifeSeenAt) ? identity.lifeSeenAt : Date.now(); returnVisit = Date.now() - lifeSince > 60000;
  meta.url = await encodeInvite(await decodeInvite(meta.url), identity.actor);
  $('downloadPackage').href = '/download.zip?invite=' + encodeURIComponent(meta.url);
  const now = Date.now();
  const migrated = await Promise.allSettled((Array.isArray(invites) ? invites : []).map(normalizeInvite)); known = [...new Set(migrated.filter(result => result.status === 'fulfilled').map(result => result.value))];
  if (previous?.world) await ensureArchives(previous.world);
  const expires = previous?.world && now - (previous.lastOnlineAt ?? previous.at ?? previous.world.tick) >= CONFIG.offlineLife;
  const savedWorld = previous?.world;
  if (savedWorld) previous.world = await verifyLocalCheckpoint(savedWorld, await archiveStore.dependencies(savedWorld), archiveStore, { context: 'start', diagnostics });
  if (expires) previous.world.chats = await archiveStore.chats(Infinity, previous.world.chats, previous.world.archives);
  const restored = restoreCheckpoint(previous, now);
  world = restored.world; world.data.participants[identity.actor] = identity.nick; lastOnlineAt = now; lastMeter = now;
  if (restored.expired) { const card = previous.picture ? await endedCard(previous, restored.expiresAt) : null; priorCheckpoint = previous; archiveStore = newArchiveStore(); if (card) acceptHistory(card); }
  else {
    reconcileHistory();
    if (previous?.world === savedWorld && previous?.picture) pictures.reuse(previous.picture);
  }
  world.attachArchives(archiveStore);
  network = new Network(identity, meta, onMessage, networkChange, (error, peer) => {
    diagnostics.record('warn', 'network', `已拒绝来自 ${peer?.node || 'unknown'} 的消息：${error?.message || error}`);
    if ($('diagnosticsDialog').open) renderDiagnosticsLogs();
  }, () => archiveStore.packs); await network.start(displayNick(identity.nick)); members.set(network.node, member());
  $('myUrl').value = meta.url;
  creator = new Creator(placement, balance, size => defaultFishName(identity.nick, world.myFishes(identity.actor).length + 1, size));
  syncIncomeSerial(); renderChat(); await saveHandoff({ startup: true });
  lastSave = lastPictureTime = Date.now();
  started = true;
  $('startupNotice').hidden = true;
  if (network.live().length) networkChange().catch(error => { status = error.message; });
  syncUpdateStatus(); refreshPeerUpdates().catch(() => {});
  reconnect().catch(() => {}); update();
  startSimulationClock(() => world.data.tick, tick);
  startSimulationClock(() => world.data.tick + CONFIG.step / 2, maintainWorld);
  setInterval(() => { network.presence(active().filter(m => m.id !== network.node).map(m => ({ id: m.id, url: m.url }))).catch(() => {}); if (network.connections.size < 6) { const candidate = active().filter(m => m.id !== network.node && !network.has(m.id)).sort((a, b) => hash(`${network.node}:${a.id}`) - hash(`${network.node}:${b.id}`))[0]; if (candidate) network.connect(candidate.url, candidate.id).catch(() => {}); } }, 6000);
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { lifeSince = identity.lifeSeenAt || Date.now(); returnVisit = Date.now() - lifeSince > 60000; lifeMessage = null; } await resumeAfterInactivity(); if (network.live().length) network.broadcast('beat', { member: member() }).catch(() => {}); save().catch(() => {}); });
  window.addEventListener('pagehide', () => { simulation.close(); const blob = new Blob([JSON.stringify({ node: network.node, token: meta.token })], { type: 'application/json' }); navigator.sendBeacon('/local/unregister', blob); if (updateFrozen || updateRestarting || replacingCheckpoint) return; save({ reusePicture: true }).catch(() => {}); });
  if (!sawLegacyNotice) refreshOldBackups(true);
  // Exposes read-only diagnostics for the project's automated browser checks.
  window.tide = { get world() { return { data: world.serialize(), counts: world.counts() }; }, get network() { return { node: network.node, leader: leader(), peers: network.live().map(p => ({ node: p.node, url: p.url })), stats: clone(network.stats) }; }, get identity() { return { actor: identity.actor, nick: displayNick(identity.nick) }; }, get histories() { return clone(histories); }, get view() { return { camera: clone(renderer.camera), scale: renderer.scale, followingFish: trackedFish, selected: clone(selected) }; }, balance };
}
async function tick() {
  if (replacingCheckpoint) return;
  const now = Date.now(), elapsed = now - lastMeter; lastMeter = now;
  if (!updateFrozen && elapsed < 90000) identity.remainder = (identity.remainder || 0) + elapsed / 1000;
  await resumeAfterInactivity(now);
  if (replacingCheckpoint) return;
  if (!updateFrozen && identity.remainder >= 3600) { identity.remainder -= 3600; identity.serial = (identity.serial || 0) + 1; await submit({ kind: 'earn', cost: 0, serial: identity.serial }); }
  members.set(network.node, member());
  const currentLeader = leader();
  if (currentLeader !== lastLeader) {
    ordered.stop('权威成员已更换');
    if (!mayRetainWorker()) simulation.close();
    lastLeader = currentLeader;
    worldBroadcast.reset(); replicaSwims.reset(); renderer.presentSwims(world);
    if (amLeader()) {
      geometryRepair = true;
      world.data.tick = Math.max(world.data.tick, now - 2000);
      await resumeOrderedInputs();
      for (const id of pending.keys()) if (world.data.ops[id] || archiveStore.ids.ops.has(id)) pending.delete(id);
    }
  }
  if (amLeader() && fishRepairWaiting && now - lastSave > 5000) geometryRepair = true;
  if (ordered.run(now)) return;
  if (amLeader() && !updateFrozen && !replacingCheckpoint) {
    const target = world;
    simulation.advance(target, now, () => target === world && amLeader() && !updateFrozen && !replacingCheckpoint && !archiveImports, {
      geometry: geometryRepair, chat: world.data.pendingChatGlyphs && now - lastSave > 5000,
      done(result) {
        geometryRepair = false; fishRepairWaiting = result.fishWaiting;
        if (result.fishWaiting) toast('世界空间不足，部分重叠鱼仍在等待空位');
        else if (result.waiting) toast('世界空间不足，部分合流造景仍待安置');
      }
    })
      .catch(error => {
        status = '后台模拟已暂停，刷新页面可重试。' + error.message;
        toast(status);
      });
  } else if (!ordered.current && !mayRetainWorker()) simulation.close();
}
// Start periodic storage, presence and HUD work between ecology deadlines.
// Foreground edits, pagehide and explicit archive requests keep their own cuts.
async function maintainWorld() {
  if (replacingCheckpoint) return;
  const now = Date.now();
  await resumeAfterInactivity(now);
  if (replacingCheckpoint) return;
  if (now - selfBeat >= 3000 && network.live().length) {
    selfBeat = now;
    network.broadcast('beat', { member: member(), ...replicaInventory.heartbeat(world.data, archiveStore, amLeader()) }).catch(() => {});
  }
  if (!activeSavePromise && now - lastSave > 5000) { lastSave = now; save().catch(reportSaveError); }
  if (amLeader() && now - lastPictureTime > 30000) { lastPictureTime = now; takePicture().catch(() => {}); }
  update();
  archiveWorld(now).catch(() => {});
}
$('lifePeek').onclick = lifeDialog;
$('ambientPeek').onclick = () => {
  const eruption = world.data.population?.eruption;
  if (eruption && (Date.now() < eruption.at + POPULATION.warning || Object.keys(eruption.particles).length)) { cancelMode(); stopObserving(); renderer.camera.x = eruption.x; renderer.camera.y = world.floorAt(eruption.x) - 10; inspect({ kind: 'ecosystem', id: 'volcano' }); update(); return; }
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
const pedigreeViewport = setupPedigreeViewport($('pedigreeTree'), scale => {
  $('pedigreeZoomLevel').textContent = `${Math.round(scale * 100)}%`;
  $('pedigreeZoomOut').disabled = scale <= .25; $('pedigreeZoomIn').disabled = scale >= 2;
});
$('pedigreeZoomIn').onclick = pedigreeViewport.zoomIn; $('pedigreeZoomOut').onclick = pedigreeViewport.zoomOut; $('pedigreeZoomReset').onclick = pedigreeViewport.reset;
$('fishPedigree').onclick = () => {
  if (selected?.kind !== 'fish') return;
  pedigreeFish = selected.id; pedigreeKey = ''; setMyFishView('pedigree'); $('myFishDialog').showModal();
};
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
$('surface').onclick = () => { trackedFish = null; surfaceCamera(); updateCameraLabels(); }; $('seabed').onclick = () => { trackedFish = null; renderer.camera = { x: world.monument.x + 4, y: world.floorAt(world.monument.x + 4) - 15 }; updateCameraLabels(); };
$('zoomIn').onclick = () => { renderer.zoom(renderer.scale + .15); updateCameraLabels(); }; $('zoomOut').onclick = () => { renderer.zoom(renderer.scale - .15); updateCameraLabels(); };
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
$('connect').onclick = () => {
  $('peerCompatBanner').hidden = true;
  $('connectionDialog').showModal();
  refreshOldBackups();
  syncUpdateStatus();
  refreshPeerUpdates().catch(() => {});
};
$('closeConnection').onclick = () => $('connectionDialog').close();
function hasUnsavedCreatorDraft() {
  const openDraft = Boolean($('creatorDialog')?.open && ((creator?.cells?.size || 0) > 0 || (creator?.strokes?.length || 0) > 0));
  const placingDraft = mode?.kind === 'fish' || mode?.kind === 'scene';
  return openDraft || placingDraft;
}
function resetUpdateForceAcks() {
  updateForcePendingAck = false;
  updateForceDraftAck = false;
  updateForceReason = '';
}
function renderUpdateBadge() {
  const badge = $('updateBadgeDot');
  if (!badge) return;
  if (preparedUpdate && preparedUpdate.phase === 'ready') {
    badge.textContent = '待重启';
    badge.classList.add('ready');
    badge.hidden = false;
    return;
  }
  const higherPeers = pickHigherVersionPeers(meta?.version, [...availablePeerUpdates.values()], meta?.assetSuffix);
  if (higherPeers.length > 0) {
    badge.textContent = '新版';
    badge.classList.remove('ready');
    badge.hidden = false;
    return;
  }
  badge.hidden = true;
}
function renderPeerUpdates() {
  const box = $('peerUpdatesBox'), list = $('peerUpdatesList');
  if (!box || !list) return;
  const peers = pickHigherVersionPeers(meta?.version, [...availablePeerUpdates.values()], meta?.assetSuffix);
  const busy = !$('updateProgressWrap').hidden || updateFrozen || updateRestarting;
  list.replaceChildren();
  if (!peers.length) {
    box.hidden = true;
    renderUpdateBadge();
    return;
  }
  for (const peer of peers) {
    const row = document.createElement('div');
    row.className = 'peerUpdateItem';
    const info = document.createElement('div');
    info.className = 'peerUpdateItemInfo';
    const nameEl = document.createElement('strong');
    nameEl.textContent = peer.nick;
    const verEl = document.createElement('span');
    verEl.className = 'quiet';
    verEl.textContent = `v${peer.version}`;
    info.append(nameEl, verEl);
    if (peer.prerelease) {
      const pre = document.createElement('span');
      pre.className = 'updateBadge';
      pre.textContent = '测试版';
      info.append(pre);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = '立即更新';
    btn.disabled = busy;
    btn.onclick = () => startUpdatePrepareFromInput(peer.invite, true);
    row.append(info, btn);
    list.append(row);
  }
  box.hidden = false;
  renderUpdateBadge();
}
function recordPeerVersion(invite, probe, fallbackNick = '') {
  if (!invite || !meta?.version || !probe) return;
  const compat = classifyPeerCompatibility(meta.version, probe, meta.assetSuffix);
  if (compat.canPeerUpdate && compat.peerVersion) {
    const nick = (Array.isArray(probe.clients) && probe.clients.find(c => c?.nick)?.nick) || fallbackNick || '在线同事';
    availablePeerUpdates.set(invite, { invite, nick, version: compat.peerVersion, assetSuffix: compat.peerAssetSuffix, compatible: compat.compatible, checkedAt: Date.now() });
  } else {
    availablePeerUpdates.delete(invite);
  }
  renderPeerUpdates();
}
async function refreshPeerUpdates() {
  if (peerProbeBusy || !network || !meta?.version) return;
  peerProbeBusy = true;
  try {
    const candidates = new Map();
    for (const [invite, info] of availablePeerUpdates.entries()) {
      if (invite && invite !== meta.url) candidates.set(invite, info.nick || '');
    }
    for (const m of active()) {
      if (m.id !== network.node && m.url && m.url !== meta.url) candidates.set(m.url, m.nick || '');
    }
    for (const url of known) {
      if (candidates.size >= 6) break;
      if (url && url !== meta.url && !candidates.has(url)) candidates.set(url, '');
    }
    await Promise.allSettled([...candidates.entries()].map(async ([invite, nick]) => {
      try {
        const probe = await network.local('probe', { url: invite });
        recordPeerVersion(invite, probe, nick);
      } catch {
        availablePeerUpdates.delete(invite);
      }
    }));
  } finally {
    peerProbeBusy = false;
    renderPeerUpdates();
  }
}
function stopUpdatePolling() {
  if (updatePollTimer) { clearInterval(updatePollTimer); updatePollTimer = null; }
}
function startUpdatePolling() {
  if (updatePollTimer) return;
  updatePollTimer = setInterval(() => { syncUpdateStatus(); }, 300);
}
async function syncUpdateStatus() {
  if (!network) return;
  const seq = ++updateStateSeq;
  try {
    const res = await network.local('update/status');
    if (seq !== updateStateSeq) return;
    if (res?.update) renderUpdateState(res.update);
  } catch { }
}
function renderUpdateState(state) {
  const statusEl = $('updateStatus'), confirmEl = $('updateConfirmCard'), progressWrap = $('updateProgressWrap');
  const progressBar = $('updateProgressBar'), progressLabel = $('updateProgressLabel'), progressMeta = $('updateProgressMeta');
  if (!state || state.phase === 'idle') {
    stopUpdatePolling();
    resetUpdateForceAcks();
    preparedUpdate = null; activeUpdateTaskId = '';
    confirmEl.hidden = true; progressWrap.hidden = true;
    $('updatePendingWarn').hidden = true; $('forceApplyUpdateBtn').hidden = true;
    statusEl.hidden = true; $('checkUpdateBtn').disabled = false; $('cancelDownloadingBtn').disabled = false;
    renderPeerUpdates(); return;
  }
  if (state.phase === 'checking' || state.phase === 'downloading') {
    if (state.id) activeUpdateTaskId = state.id;
    resetUpdateForceAcks();
    confirmEl.hidden = true; statusEl.hidden = true; progressWrap.hidden = false;
    $('checkUpdateBtn').disabled = true; $('cancelDownloadingBtn').disabled = false;
    if (state.phase === 'checking') {
      progressLabel.textContent = '正在连接来源并核对版本…';
      progressBar.removeAttribute('value');
      progressMeta.textContent = '你可以关闭窗口继续游玩，下载完成后会提醒你';
    } else {
      progressLabel.textContent = state.targetVersion ? `正在下载新版本 ${state.targetVersion}…` : '正在下载更新包…';
      const done = Number(state.downloadedBytes || 0), total = Number(state.totalBytes ?? -1);
      if (total > 0) progressBar.value = Math.min(100, Math.round((done / total) * 100));
      else progressBar.removeAttribute('value');
      const sizeText = formatUpdateBytes(done, total);
      progressMeta.textContent = sizeText ? `${sizeText} · 你可以关闭窗口继续游玩` : '你可以关闭窗口继续游玩，完成后会提醒你';
    }
    startUpdatePolling();
    renderPeerUpdates(); return;
  }
  if (state.phase === 'ready') {
    stopUpdatePolling();
    if (preparedUpdate?.id !== state.id) resetUpdateForceAcks();
    preparedUpdate = state; activeUpdateTaskId = state.id || '';
    progressWrap.hidden = true;
    statusEl.hidden = false; statusEl.textContent = '更新包已下载并校验完成，确认后将保存进度并重启。';
    $('updateConfirmSource').textContent = state.sourceLabel || state.sourceInput;
    $('updateConfirmVersions').textContent = `${state.currentVersion} → ${state.targetVersion}`;
    $('updatePrereleaseBadge').hidden = !state.prerelease;
    $('updatePendingWarn').hidden = true; $('forceApplyUpdateBtn').hidden = true; $('applyUpdateBtn').hidden = false; $('applyUpdateBtn').disabled = false;
    confirmEl.hidden = false; $('checkUpdateBtn').disabled = false;
    renderPeerUpdates(); return;
  }
  if (state.phase === 'failed') {
    stopUpdatePolling();
    resetUpdateForceAcks();
    preparedUpdate = null; activeUpdateTaskId = '';
    progressWrap.hidden = true; confirmEl.hidden = true;
    statusEl.hidden = false; statusEl.textContent = state.error || '更新检查或安装失败，当前版本继续运行。';
    $('checkUpdateBtn').disabled = false;
    renderPeerUpdates();
  }
}
async function startUpdatePrepareFromInput(rawInput, scrollIntoView = false) {
  if (updateFrozen || updateRestarting) { toast('正在保存进度并重启，请稍候'); return; }
  let detected, kind, input;
  try {
    detected = detectUpdateSource(rawInput, meta?.assetSuffix);
    kind = detected.kind;
    input = kind === 'peer' ? await normalizeInvite(detected.input) : detected.input;
  } catch (error) {
    renderUpdateState({ phase: 'failed', error: error.message }); toast(error.message); return;
  }
  $('peerCompatBanner').hidden = true;
  $('updateSourceInput').value = input;
  if (scrollIntoView) $('updateSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const seq = ++updateStateSeq;
  renderUpdateState({ phase: 'checking' });
  updateChannel?.postMessage({ type: 'status-changed' });
  try {
    const result = await network.local('update/prepare', { kind, input });
    if (seq !== updateStateSeq) { syncUpdateStatus(); return; }
    renderUpdateState(result.update);
    updateChannel?.postMessage({ type: 'status-changed' });
    if ($('connectionDialog').open) toast(`新版本 ${result.update.targetVersion} 已准备好`);
    else toast(`新版本 ${result.update.targetVersion} 已准备好，点「连接同事」即可重启更新`);
  } catch (error) {
    if (kind === 'peer' && availablePeerUpdates.has(input)) {
      availablePeerUpdates.delete(input);
      renderPeerUpdates();
    }
    if (seq !== updateStateSeq) { syncUpdateStatus(); return; }
    if (error.message === '更新已取消') {
      syncUpdateStatus();
      updateChannel?.postMessage({ type: 'status-changed' });
      return;
    }
    renderUpdateState({ phase: 'failed', error: error.message }); toast(error.message);
    updateChannel?.postMessage({ type: 'status-changed' });
  }
}
function showUpdateOverlay(text, showActions = false) {
  $('updateOverlayText').textContent = text;
  $('updateOverlayActions').hidden = !showActions;
  for (const dialog of document.querySelectorAll('dialog[open]')) { if (dialog.id !== 'updateOverlay') dialog.close(); }
  if (!$('updateOverlay').open) $('updateOverlay').showModal();
}
function hideUpdateOverlay() {
  $('updateOverlayActions').hidden = true;
  if ($('updateOverlay').open) $('updateOverlay').close();
}
$('updateOverlay').addEventListener('cancel', e => e.preventDefault());
$('reloadAfterUpdateBtn').onclick = () => location.reload();
$('dismissUpdateOverlayBtn').onclick = () => {
  hideUpdateOverlay();
  updateFrozen = false; updateRestarting = false; activeRestartTaskId = '';
  renderPeerUpdates();
  syncUpdateStatus();
};
async function waitForRestart(targetVersion, previousVersion, taskId) {
  updateRestarting = true; activeRestartTaskId = taskId || '';
  renderPeerUpdates();
  showUpdateOverlay(`正在启动新版本 ${targetVersion}，完成后自动刷新页面…`, false);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && updateRestarting && activeRestartTaskId === (taskId || '')) {
    await new Promise(resolve => setTimeout(resolve, 400));
    if (!updateRestarting || activeRestartTaskId !== (taskId || '')) return;
    try {
      const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok && health.version === targetVersion && health.handoffReady === true) { location.reload(); return; }
        if (health.ok && health.version === targetVersion && health.handoffFailed) {
          hideUpdateOverlay(); updateFrozen = false; updateRestarting = false; activeRestartTaskId = '';
          renderUpdateState({ phase: 'failed', error: '新版本文件替换失败，请关闭占用程序后重试' });
          toast('新版本文件替换失败'); return;
        }
        if (health.ok && health.version === previousVersion) {
          if (health.handoffFailed && health.handoffReady === true) { location.reload(); return; }
          try {
            const st = await network.local('update/status');
            if (st?.update?.phase === 'failed' && (!taskId || st.update.id === taskId)) {
              hideUpdateOverlay(); updateFrozen = false; updateRestarting = false; activeRestartTaskId = '';
              const reason = st.update.error || '新版本启动失败，已恢复旧版本继续运行';
              renderUpdateState({ phase: 'failed', error: reason }); toast(reason); return;
            }
          } catch { }
        }
      }
    } catch { }
  }
  if (!updateRestarting || activeRestartTaskId !== (taskId || '')) return;
  showUpdateOverlay('等待新版本重启超时。新版本可能已完成切换，你可以直接刷新页面，或返回当前页面查看。', true);
  toast('等待新版本重启超时');
}
async function coordinateOtherTabsFreeze(taskId, { allowDraft = false } = {}) {
  if (!updateChannel) return { ok: true };
  const discovered = new Map();
  const acked = new Map();
  updatePeerWaiters.set(taskId, msg => {
    if (msg.type === 'pong' && msg.tabId && msg.tabId !== tabInstanceId) discovered.set(msg.tabId, { hasDraft: !!msg.hasDraft });
    if (msg.type === 'frozen' && msg.tabId && msg.tabId !== tabInstanceId) acked.set(msg.tabId, msg);
  });
  try {
    updateChannel.postMessage({ type: 'ping', taskId, from: tabInstanceId });
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!discovered.size) return { ok: true };
    if (!allowDraft && [...discovered.values()].some(info => info.hasDraft)) {
      return { ok: false, draftConflict: true };
    }
    updateChannel.postMessage({ type: 'freeze-tab', taskId, from: tabInstanceId });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ([...discovered.keys()].every(id => acked.has(id))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const id of discovered.keys()) {
      const reply = acked.get(id);
      if (!reply || !reply.ok) {
        updateChannel.postMessage({ type: 'abort-restart', taskId });
        return { ok: false, error: reply?.error || '其他游戏标签页正在保存进度，请稍后再试' };
      }
    }
    return { ok: true };
  } finally {
    updatePeerWaiters.delete(taskId);
  }
}
function keepReadyWithWarn(warnText, { allowForce = false, forceReason = '' } = {}) {
  updateFrozen = false;
  updateForceReason = allowForce ? forceReason : '';
  $('checkUpdateBtn').disabled = false;
  $('updateConfirmCard').hidden = false;
  $('updatePendingWarn').textContent = warnText;
  $('updatePendingWarn').hidden = false;
  $('applyUpdateBtn').hidden = allowForce;
  $('applyUpdateBtn').disabled = false;
  $('forceApplyUpdateBtn').hidden = !allowForce;
  $('forceApplyUpdateBtn').disabled = false;
  $('updateStatus').hidden = false;
  $('updateStatus').textContent = allowForce ? '请确认是否继续更新并重启。' : '当前版本继续运行，更新包已保留，可随时重试。';
  renderPeerUpdates();
}
async function applyPreparedUpdate(confirmForce = false) {
  const task = preparedUpdate ? { ...preparedUpdate } : null;
  if (!task?.id) return;
  if (confirmForce) {
    if (updateForceReason === 'pending') updateForcePendingAck = true;
    else if (updateForceReason === 'draft') updateForceDraftAck = true;
    updateForceReason = '';
  } else {
    resetUpdateForceAcks();
  }
  updateStateSeq++;
  updateFrozen = true; simulation.close();
  renderPeerUpdates();
  $('updatePendingWarn').hidden = true;
  $('applyUpdateBtn').disabled = true; $('forceApplyUpdateBtn').disabled = true; $('checkUpdateBtn').disabled = true;
  $('updateStatus').hidden = false; $('updateStatus').textContent = '正在等待待确认操作完成并保存游戏进度…';
  if (!updateForcePendingAck && pending.size > 0) {
    const waitUntil = Date.now() + 8000;
    while (pending.size > 0 && Date.now() < waitUntil && preparedUpdate?.id === task.id) await new Promise(resolve => setTimeout(resolve, 200));
    if (preparedUpdate?.id !== task.id) { updateFrozen = false; $('checkUpdateBtn').disabled = false; renderPeerUpdates(); return; }
    if (pending.size > 0) {
      keepReadyWithWarn(`还有 ${pending.size} 项刚发出的操作等待伙伴确认。你可以稍等同步完成，或选择仍要更新并重启。`, { allowForce: true, forceReason: 'pending' });
      return;
    }
  }
  const archiveWaitUntil = Date.now() + 5000;
  while (archiveBusy && Date.now() < archiveWaitUntil) await new Promise(resolve => setTimeout(resolve, 100));
  if (archiveBusy) {
    keepReadyWithWarn('历史记忆正在整理中，请稍等片刻再点「更新并重启」。');
    toast('历史记忆正在整理，已暂停更新');
    return;
  }
  const tabsResult = await coordinateOtherTabsFreeze(task.id, { allowDraft: updateForceDraftAck });
  if (!tabsResult.ok) {
    if (tabsResult.draftConflict) {
      keepReadyWithWarn('另一个游戏标签页还有正在画的鱼或造景尚未投放。你可以先去投放或关闭画板，也可以选择仍要更新并重启。', { allowForce: true, forceReason: 'draft' });
      toast('检测到其他标签页有未投放的画板草稿');
      return;
    }
    keepReadyWithWarn('其他游戏标签页暂未准备好：' + tabsResult.error);
    toast('其他标签页暂未准备好，当前版本继续运行');
    return;
  }
  try {
    await saveHandoff({ mirrorLegacy: true });
  } catch (error) {
    updateChannel?.postMessage({ type: 'abort-restart', taskId: task.id });
    keepReadyWithWarn('本地进度保存失败：' + error.message + '。请重试，当前版本继续运行。');
    toast('本地进度保存失败，当前版本继续运行');
    return;
  }
  const targetVersion = task.targetVersion, previousVersion = meta.version;
  updateChannel?.postMessage({ type: 'prepare-restart', taskId: task.id, targetVersion, previousVersion });
  try {
    await network.local('update/apply', { id: task.id });
    await waitForRestart(targetVersion, previousVersion, task.id);
  } catch (error) {
    updateChannel?.postMessage({ type: 'abort-restart', taskId: task.id });
    updateFrozen = false; updateRestarting = false; activeRestartTaskId = '';
    if (/未就绪|已过期/.test(error.message || '')) {
      renderUpdateState({ phase: 'failed', error: error.message });
    } else {
      keepReadyWithWarn('触发重启失败：' + error.message + '。请稍后重试。');
    }
    toast(error.message);
  }
}
if (updateChannel) {
  updateChannel.onmessage = async event => {
    const data = event.data;
    if (!data?.type) return;
    if (data.type === 'status-changed') { syncUpdateStatus(); return; }
    if (data.type === 'ping') { updateChannel.postMessage({ type: 'pong', taskId: data.taskId, tabId: tabInstanceId, hasDraft: hasUnsavedCreatorDraft() }); return; }
    if (data.type === 'pong' || data.type === 'frozen') { updatePeerWaiters.get(data.taskId)?.(data); return; }
    if (data.type === 'freeze-tab') {
      updateFrozen = true; simulation.close();
      try {
        await saveHandoff();
        updateChannel.postMessage({ type: 'frozen', taskId: data.taskId, tabId: tabInstanceId, ok: true });
      } catch (error) {
        updateChannel.postMessage({ type: 'frozen', taskId: data.taskId, tabId: tabInstanceId, ok: false, error: error.message });
      }
      return;
    }
    if (data.type === 'abort-restart') {
      if (!activeRestartTaskId || !data.taskId || activeRestartTaskId === data.taskId) {
        updateFrozen = false; updateRestarting = false; activeRestartTaskId = ''; hideUpdateOverlay(); renderPeerUpdates();
      }
      return;
    }
    if (data.type === 'prepare-restart') {
      updateFrozen = true; simulation.close();
      waitForRestart(data.targetVersion, data.previousVersion, data.taskId);
    }
  };
}
async function cancelActiveUpdate(targetId, successToast = '') {
  const seq = ++updateStateSeq;
  try {
    const res = await network.local('update/cancel', { id: targetId || '' });
    if (seq !== updateStateSeq) return;
    const nextState = res?.update || { phase: 'idle' };
    updateFrozen = false;
    renderUpdateState(nextState);
    updateChannel?.postMessage({ type: 'status-changed' });
    if (nextState.phase === 'idle') {
      if (successToast) toast(successToast);
    } else {
      toast('当前更新任务已变化，已同步最新状态');
    }
  } catch (error) {
    if (seq !== updateStateSeq) return;
    toast(error.message || '取消更新失败');
    syncUpdateStatus();
  }
}
$('updateForm').onsubmit = async e => { e.preventDefault(); await startUpdatePrepareFromInput($('updateSourceInput').value, false); };
$('updateFromPeerNow').onclick = async () => { if (peerUpdateCandidate) await startUpdatePrepareFromInput(peerUpdateCandidate, true); };
$('applyUpdateBtn').onclick = () => applyPreparedUpdate(false);
$('forceApplyUpdateBtn').onclick = () => applyPreparedUpdate(true);
$('cancelDownloadingBtn').onclick = async () => {
  $('cancelDownloadingBtn').disabled = true;
  await cancelActiveUpdate(activeUpdateTaskId, '已取消下载');
};
$('cancelUpdateBtn').onclick = async () => {
  await cancelActiveUpdate(preparedUpdate?.id || '', '');
};
$('connectionForm').onsubmit = async e => {
  e.preventDefault(); $('peerCompatBanner').hidden = true; peerUpdateCandidate = ''; status = '正在自动配对…'; update();
  try {
    const code = await normalizeInvite($('peerUrl').value); $('peerUrl').value = code;
    const probe = await network.local('probe', { url: code });
    recordPeerVersion(code, probe);
    const compat = classifyPeerCompatibility(meta.version, probe, meta.assetSuffix);
    if (compat.action === 'block_update_self') {
      if (compat.canPeerUpdate) {
        peerUpdateCandidate = code;
        $('peerCompatText').textContent = `同事正在运行新版本 ${compat.peerVersion}，联机规则已变更，需先更新后再连接。`;
        $('updateFromPeerNow').hidden = false; $('peerCompatBanner').hidden = false;
      } else {
        peerUpdateCandidate = '';
        $('peerCompatText').textContent = `同事正在运行新版本 ${compat.peerVersion}（${assetPlatformLabel(compat.peerAssetSuffix)}），联机规则已变更。对方启动包不适用于当前系统（${assetPlatformLabel(compat.localAssetSuffix)}），请通过 GitHub Release 或同系统同事更新后再连接。`;
        $('updateFromPeerNow').hidden = true; $('peerCompatBanner').hidden = false;
      }
      status = '同事联机规则较新，请先更新'; toast(status); update(); return;
    }
    if (compat.action === 'block_update_peer') {
      $('peerCompatText').textContent = `同事正在运行旧版本 ${compat.peerVersion || '未知'}，联机规则不兼容，请先请对方更新后再连接。`;
      $('updateFromPeerNow').hidden = true; $('peerCompatBanner').hidden = false;
      status = '同事版本较旧且规则不兼容'; toast(status); update(); return;
    }
    if (compat.action === 'block_incompatible') {
      $('peerCompatText').textContent = `双方版本号相同（${compat.peerVersion || meta.version}），但联机规则不一致，暂停连接。`;
      $('updateFromPeerNow').hidden = true; $('peerCompatBanner').hidden = false;
      status = '双方版本相同但联机规则不一致'; toast(status); update(); return;
    }
    await network.connectInvite(code); await remember(code); $('connectionDialog').close();
    if (compat.action === 'connect_with_hint') {
      if (compat.canPeerUpdate) toast(`已连接同事。对方版本较新（${compat.peerVersion}），可随时点「连接同事」一键更新`);
      else toast(`已连接同事。对方版本较新（${compat.peerVersion}，${assetPlatformLabel(compat.peerAssetSuffix)}），可通过 GitHub Release 或同系统同事更新`);
    }
  } catch (e) { status = e.message; toast(e.message); } update();
};
$('copyUrl').onclick = async () => { await navigator.clipboard.writeText(meta.url); toast('邀请码已复制'); };
async function downloadBackup(name, backup) {
  if (!backup?.identity?.secret || !backup.checkpoint?.world) throw new Error('本地没有可导出的完整身份与记忆');
  const manifests = { ...backup.checkpoint.world.archives?.chunks };
  for (const card of Object.values(backup.histories || {})) Object.assign(manifests, card.archives?.chunks);
  const archiveChunks = {};
  for (const id of Object.keys(manifests)) {
    archiveChunks[id] = archiveStore.packs.get(id) || await get('archive:' + id);
    if (!archiveChunks[id]) throw new Error('备份缺少历史归档');
  }
  download(name, { ...backup, archiveChunks });
}
$('backup').onclick = async () => {
  try {
    if (started) await resumeAfterInactivity();
    const [checkpoint, owner, cards = {}, invites = []] = started
      ? [await captureLocalCheckpoint(), clone(identity), clone(histories), [...known]]
      : await getMany(['checkpoint', 'identity', 'histories', 'known'], { observeCheckpoint: false });
    await downloadBackup('鱼来-身份与记忆备份.json', { format: 'tide-backup-1', identity: owner, histories: cards, known: invites, checkpoint });
  } catch (error) { diagnostics.record('error', 'backup', error.message); toast(error.message); }
};
let legacyInspector;
function refreshOldBackups(notify = false) {
  if (legacyInspector) return;
  const worker = legacyInspector = new Worker(new URL('./legacy-backups-worker.js', import.meta.url), { type: 'module' });
  const finish = () => { worker.terminate(); legacyInspector = null; };
  worker.onerror = finish;
  worker.onmessage = ({ data }) => {
    finish();
    if (data.error) { toast(data.error); return; }
    const row = $('backup').parentElement;
    for (const button of row.querySelectorAll('[data-legacy-backup]')) button.remove();
    if (notify && data.branches.length) claimLegacyNotice().then(first => {
      if (first) toast('留着一份旧版进度，可在「连接同事」里导出。');
    }).catch(() => {});
    for (const { id, at } of data.branches) {
      const button = document.createElement('button');
      button.dataset.legacyBackup = id;
      button.textContent = '导出旧版进度' + (Number.isFinite(at) ? '（' + new Date(at).toLocaleString('zh-CN') + '）' : '');
      button.onclick = async () => {
        try {
          const backup = await getOldBranch(id);
          if (!backup) { refreshOldBackups(); toast('旧版进度列表已更新，请重新选择。'); return; }
          await downloadBackup('鱼来-旧版进度.json', backup);
        }
        catch (error) { toast(error.message); }
      };
      row.append(button);
    }
  };
}
$('importBackup').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || replacingCheckpoint) return;
  if (updateFrozen) { toast('正在更新并重启，请稍候'); return; }
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'tide-backup-1' || !data.identity?.secret || (Object.hasOwn(data, 'checkpoint') && !data.checkpoint?.world) ||
        await actorId(data.identity.pub) !== data.identity.actor) throw new Error('备份无效');
    // Import the key before committing an identity that will be needed at the next start.
    const sign = await signer(data.identity);
    const challenge = { id: crypto.randomUUID(), from: data.identity.actor.slice(0, 16), actor: data.identity.actor, key: data.identity.pub };
    if (!await verifyEnvelope({ ...challenge, signature: await sign(challenge) })) throw new Error('备份身份凭据不匹配');
    const bundle = data.archiveChunks || {}, store = newArchiveStore(bundle);
    const checkpoint = data.checkpoint;
    if (checkpoint) {
      await ensureArchives(checkpoint.world, null, bundle, store);
      checkpoint.world = await verifyLocalCheckpoint(checkpoint.world, await store.dependencies(checkpoint.world), store, { context: 'import', diagnostics });
    }
    if (data.known != null && (!Array.isArray(data.known) || !data.known.every(invite => typeof invite === 'string'))) throw new Error('备份中的接入记录无效');
    const chunks = new Set(Object.keys(store.manifests));
    if (data.histories != null && (typeof data.histories !== 'object' || Array.isArray(data.histories))) throw new Error('备份中的历史世界无效');
    for (const [id, card] of Object.entries(data.histories || {})) {
      if (!validHistoryCard(card) || card.id !== id) throw new Error('备份中的历史世界无效');
      const history = await historyArchiveStore(card, null, bundle);
      await verifyChats(card.chats, history);
      for (const id of Object.keys(history.manifests)) chunks.add(id);
    }
    if (replacingCheckpoint || updateFrozen) return;
    replacingCheckpoint = true;
    try {
      // Early backups contained only the identity and account metadata.
      // Keep the durable world at the same revision when updating its legacy mirror.
      const retained = checkpoint ? undefined : (await get('checkpoint', { observeCheckpoint: false })) ?? null;
      await replaceFromBackup([['identity', data.identity], ['histories', data.histories || {}], ['known', data.known || []],
        ['checkpoint', checkpoint ?? retained], ...Array.from(chunks, id => ['archive:' + id, bundle[id]])],
        { generation: await saveGeneration, replace: true, checkpoint: retained });
    } catch (error) { replacingCheckpoint = false; throw error; }
    try { await network?.stop(); } finally { location.reload(); }
  } catch (error) { diagnostics.record('error', 'import', error.message); toast(error.message); }
};
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = () => $('helpDialog').close(); $('closeHistory').onclick = () => $('historyDialog').close();
$('collapseChat').onclick = () => { document.querySelector('.chat').classList.toggle('collapsed'); $('collapseChat').textContent = document.querySelector('.chat').classList.contains('collapsed') ? '+' : '−'; };
$('loadEarlierChat').onclick = async () => { chatLimit += 80; try { olderChats = await archiveStore.chats(chatLimit, world.data.chats, world.data.archives); renderChat(true); } catch (error) { toast('旧聊天读取失败：' + error.message); } };
$('chatForm').onsubmit = async e => {
  e.preventDefault(); if (updateFrozen) { toast('正在更新并重启，请稍候'); return; } const text = $('chatInput').value.trim(); if (!identity || !text || text.length > 160 || Date.now() - lastChat < 1500) return;
  await resumeAfterInactivity(); if (updateFrozen) { toast('正在更新并重启，请稍候'); return; } lastChat = Date.now();
  try { const message = await network.makeEnvelope('chat', { nick: displayNick(identity.nick), text, t: Date.now(), roots: [world.id] }); const result = world.addChat(message); if (!result.ok) throw new Error(result.error); renderChat(); $('chatInput').value = ''; await save({ reusePicture: true }); await network.broadcastEnvelope(message); }
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
$('sea').addEventListener('pointermove', e => { if (mode) { const p = renderer.point(e.clientX, e.clientY), b = bounds(mode.cells || []); renderer.preview = { ...mode, x: mode.kind === 'food' ? p.x : wrapX(p.x - b.minX), y: mode.kind === 'food' ? 0 : p.y - b.minY }; if (mode.kind === 'fish') renderer.preview.valid = world.canOccupy({ id: '', x: renderer.preview.x, y: renderer.preview.y, facing: 1 }, mode.cells); } else if (dragging) { const s = renderer.cell * renderer.scale; renderer.camera.x = wrapX(dragging.x - (e.clientX - dragging.startX) / s); renderer.camera.y = Math.min(CONFIG.depth, Math.max(0, dragging.y - (e.clientY - dragging.startY) / s)); dragging.moved ||= Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 4; if (dragging.moved) trackedFish = null; updateCameraLabels(); } });
$('sea').addEventListener('pointerup', e => { if (dragging && !dragging.moved) { const hit = renderer.hit(e.clientX, e.clientY); if (hit) inspect(hit); else { selected = null; renderer.selected = null; $('inspector').hidden = true; } } dragging = null; });
$('sea').addEventListener('wheel', e => { e.preventDefault(); renderer.zoom(renderer.scale * (e.deltaY < 0 ? 1.1 : .9)); updateCameraLabels(); }, { passive: false });
function renderDiagnosticsLogs() {
  $('diagLogs').textContent = diagnostics.format();
  $('diagLogs').scrollTop = $('diagLogs').scrollHeight;
}
async function diagnosticTarget() {
  const live = started;
  const stored = live ? await readCheckpointVersion() : (await get('checkpoint', { observeCheckpoint: false })) ?? null;
  const checkpoint = live ? await captureLocalCheckpoint() : stored;
  const target = checkpoint?.world, store = newArchiveStore();
  if (checkpoint && !target) throw new Error('本地存档缺少世界数据');
  if (target) await ensureArchives(target, null, null, store);
  return { target, targetKind: live ? 'memory' : 'checkpoint', checkpoint, stored, store,
    extra: target ? await store.dependencies(target) : {} };
}
async function scanDiagnostics() {
  if (replacingCheckpoint) return;
  const sequence = ++scanSequence;
  diagScanResult = null;
  $('diagRepairResult').hidden = true;
  $('diagSummary').textContent = '正在读取存档和归档凭据…';
  $('diagIssues').replaceChildren();
  $('diagAlignBtn').disabled = $('diagPruneBtn').disabled = true;
  $('diagExportBtn').disabled = true;
  try {
    await showDiagnosticScan(sequence);
  } catch (error) {
    if (sequence !== scanSequence) return;
    diagScanResult = { state: error.code === 'archive_missing' ? 'archive_missing' : 'failed' };
    $('diagSummary').textContent = '无法完成扫描：' + error.message;
    diagnostics.record('warn', 'diagnostics', error.message);
    renderDiagnosticsLogs();
  } finally {
    if (sequence === scanSequence) $('diagExportBtn').disabled = false;
  }
}
async function showDiagnosticScan(sequence) {
  const loaded = await diagnosticTarget();
  const { target, targetKind } = loaded;
  if (sequence !== scanSequence) return;
  if (!target) {
    diagScanResult = { state: 'empty' };
    $('diagSummary').textContent = '未检测到本地存档或已启动世界。';
    $('diagIssues').replaceChildren(Object.assign(document.createElement('p'), { className: 'quiet', textContent: '无异常记录。' }));
    renderDiagnosticsLogs();
    return;
  }
  const report = inspectFishOrigins(target, loaded.extra, null);
  let verifyError = '';
  try {
    await verifyReplica(target, loaded.extra, loaded.store, { diagnostics, context: 'diag-scan' });
  } catch (error) {
    verifyError = error.message;
  }
  if (sequence !== scanSequence) return;
  diagScanResult = { targetKind, report, stored: loaded.stored, verifyError };
  const statusNotes = [];
  statusNotes.push(`已扫描${targetKind === 'checkpoint' ? '本地存档（IndexedDB）' : '当前运行世界'}：共 ${report.totalFishes} 条鱼，正常 ${report.okCount} 条，创建者异常 ${report.issues.length} 条（可无损对齐 ${report.safeRepairable} 条，无来源孤儿 ${report.orphanCount} 条）`);
  if (verifyError && !report.issues.length) statusNotes.push(`其他校验失败：${verifyError}`);
  if (report.issues.length > 200) statusNotes.push('下方显示前 200 条异常');
  $('diagSummary').textContent = statusNotes.join('。') + '。';
  diagnostics.record('info', 'diagnostics', `扫描完成：fishes=${report.totalFishes} issues=${report.issues.length} safe=${report.safeRepairable} orphan=${report.orphanCount}${verifyError ? ' verifyError=' + verifyError : ''}`);
  if (!report.issues.length) {
    $('diagIssues').replaceChildren(Object.assign(document.createElement('p'), { className: 'quiet', textContent: verifyError ? `鱼创建者记录全部正常，但全量校验提示：${verifyError}` : '未发现鱼的创建者异常。' }));
  } else {
    $('diagIssues').replaceChildren(...report.issues.slice(0, 200).map(issue => {
      const card = document.createElement('div'); card.className = 'diagIssue';
      const title = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = issue.id;
      const tag = document.createElement('span'); tag.className = 'diagTag' + (issue.repairable === 'safe' ? '' : ' orphan'); tag.textContent = issue.repairable === 'safe' ? '可无损对齐' : issue.repairable === 'blocked' ? '需核对原始凭据' : '缺少来源凭据';
      title.append(strong, tag);
      const desc = document.createElement('div'); desc.textContent = issue.summary;
      card.append(title, desc);
      return card;
    }));
  }
  setRepairButtons(report);
  renderDiagnosticsLogs();
}
function setRepairButtons(report) {
  const blocked = !report || report.issues.some(issue => issue.repairable === 'blocked');
  $('diagAlignBtn').disabled = blocked || !report.safeRepairable || report.orphanCount > 0;
  $('diagPruneBtn').disabled = !report?.orphanCount;
}
async function applyDiagnosticRepair(mode) {
  const scan = diagScanResult;
  if (!scan?.report || updateFrozen || replacingCheckpoint) return;
  replacingCheckpoint = true;
  const sequence = ++scanSequence;
  setRepairButtons(null);
  $('diagScanBtn').disabled = true;
  $('diagRepairResult').hidden = false;
  $('diagRepairResult').textContent = '正在核对修复后的存档…';
  let committed = false;
  let failed = false;
  let unsubscribe;
  try {
    if (activeSavePromise) await activeSavePromise;
    const loaded = await diagnosticTarget();
    if (!loaded.target || scan.targetKind !== loaded.targetKind || !sameStoredCheckpoint(loaded.stored, scan.stored) ||
        (started && JSON.stringify(inspectFishOrigins(loaded.target, loaded.extra).issues) !== JSON.stringify(scan.report.issues))) {
      throw new Error('存档已更新，请重新扫描');
    }
    const repaired = repairFishOriginIssues(loaded.target, loaded.extra, { mode });
    if (!repaired.changed) throw new Error('没有可应用的修复项');
    const repairedStore = newArchiveStore();
    await ensureArchives(repaired.data, null, null, repairedStore);
    const extra = await repairedStore.dependencies(repaired.data);
    await verifyReplica(repaired.data, extra, repairedStore, { diagnostics, context: 'diag-repair' });
    if (sequence !== scanSequence || !$('diagnosticsDialog').open) return;
    const removed = repaired.actions.filter(action => action.action.startsWith('prune_')).length;
    if (removed && !confirm(`将清理 ${removed} 条缺少来源的鱼及其关联记录。可先在连接面板导出身份与记忆备份。确认继续？`)) {
      $('diagRepairResult').textContent = '已取消清理。';
      return;
    }
    const checkpoint = { ...loaded.checkpoint, world: repaired.data };
    repairWrite = new AbortController();
    if (started) unsubscribe = subscribeSimulationChanges((changed) => {
      if (changed === world) invalidateRepairWrite();
    });
    await replaceFromBackup(() => {
      if (sequence !== scanSequence || !$('diagnosticsDialog').open || updateFrozen ||
          started !== (loaded.targetKind === 'memory') || (started && JSON.stringify(world.data) !== JSON.stringify(loaded.target))) {
        throw new Error('运行中的世界已更新，请重新扫描');
      }
      const entries = [['checkpoint', checkpoint]];
      if (started) entries.push(['identity', identity], ['histories', histories], ['known', known]);
      return entries;
    }, { checkpoint: loaded.stored, generation: await saveGeneration, replace: true, requireObservedRevision: started, signal: repairWrite.signal });
    committed = true;
    location.reload();
  } catch (error) {
    failed = true;
    diagnostics.record('error', 'diag-repair', error.message);
    $('diagRepairResult').textContent = '修复未写入：' + error.message;
    $('diagRepairResult').hidden = false;
    renderDiagnosticsLogs();
  } finally {
    unsubscribe?.();
    repairWrite = undefined;
    if (!committed) {
      replacingCheckpoint = false;
      $('diagScanBtn').disabled = false;
      if (!diagScanResult && $('diagnosticsDialog').open) await scanDiagnostics();
      else if (!failed) setRepairButtons(scan.report);
    }
  }
}
async function openDiagnostics() {
  if (!$('diagnosticsDialog').open) $('diagnosticsDialog').showModal();
  await scanDiagnostics();
}
function bindSecretTap(el, threshold = 5, windowMs = 2000) {
  let taps = 0, first = 0;
  el.addEventListener('click', () => {
    const now = performance.now();
    if (!taps || now - first > windowMs) { first = now; taps = 0; }
    taps++;
    if (taps >= threshold) { taps = 0; openDiagnostics(); return; }
  });
}
$('currentVersion').textContent = '当前版本未知';
bindSecretTap($('currentVersion'));
bindSecretTap($('networkStatus'));
for (const title of document.querySelectorAll('dialog:not(#diagnosticsDialog) h2')) bindSecretTap(title);
$('closeDiagnostics').onclick = () => $('diagnosticsDialog').close();
$('diagnosticsDialog').addEventListener('close', () => {
  if (!$('diagnosticsDialog').open) { invalidateRepairWrite(); ++scanSequence; diagScanResult = null; }
});
$('diagScanBtn').onclick = () => scanDiagnostics();
$('diagAlignBtn').onclick = () => applyDiagnosticRepair('align');
$('diagPruneBtn').onclick = () => applyDiagnosticRepair('align_and_prune');
$('diagCopyLogBtn').onclick = async () => { try { await navigator.clipboard.writeText(diagnostics.format()); toast('定位日志已复制'); } catch { toast('复制失败，请手动选中复制'); } };
$('diagClearLogBtn').onclick = () => { diagnostics.clear(); renderDiagnosticsLogs(); };
$('diagExportBtn').onclick = async () => {
  try {
    download(`鱼来-诊断包-${Date.now()}.json`, diagnosticSummary(diagScanResult, diagnostics.list()));
    toast('诊断摘要已导出');
  } catch (error) {
    toast('导出诊断包失败：' + error.message);
  }
};
const shortcutButtons = { f: 'makeFish', s: 'makeScene', e: 'feed', m: 'seabed', p: 'myFish', o: 'surface', l: 'connect', h: 'help' }, heldShortcuts = new Set();
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase(), heldKey = e.code || key;
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'd') { e.preventDefault(); if (!e.repeat) openDiagnostics(); return; }
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
    const fish = renderer.fishPose(world, trackedFish, now);
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
render();
if (new URLSearchParams(location.search).get('debug') === '1') openDiagnostics();
start().catch(e => {
  $('startupNotice').hidden = true;
  if (network && !started) network.stop().catch(() => {});
  diagnostics.record('error', 'start', e.message);
  toast(e.message);
  status = e.message;
  $('networkStatus').textContent = status;
}).then(() => { if ($('diagnosticsDialog').open) scanDiagnostics(); });
