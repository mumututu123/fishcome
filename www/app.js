import { World, CONFIG, clone, EYES, bounds, velocities, validGlyph, maskNick, hash } from './engine.js';
import { get, set, putMany, newIdentity, verifyEnvelope, actorId, download } from './storage.js';
import { Network } from './network.js';
import { Renderer, MONUMENT } from './renderer.js';
import { Creator } from './creator.js';
import { restoreCheckpoint } from './lifecycle.js';
const $ = id => document.getElementById(id);
const renderer = new Renderer($('sea'));
let world = new World(), identity, network, meta, creator, mode = null, selected = null, dragging, chats = [], histories = {}, known = [], members = new Map(), pending = new Map(), inbox = new Map(), lastPicture = null, priorCheckpoint = null;
let lastSnapshot = 0, snapshotBusy = false, lastHello = new Set(), lastMeter = Date.now(), lastSave = 0, lastPictureTime = 0, lastChat = 0, selfBeat = 0, lastLeader = '', status = '', started = false, lastRepair = 0;
let lastFull = 0, sentOps = new Set(), sentChars = new Map();
let geometryRepair = false;
let lastOnlineAt = Date.now();
const historyQueues = new Map();
const opBody = op => { const { proof, ...body } = op; return body; };
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000); }
function member() { return { id: network.node, actor: identity.actor, nick: maskNick(identity.nick), url: meta.url, at: Date.now(), visible: !document.hidden, peers: network.live().length }; }
function active() { return [...members.values()].filter(m => Date.now() - m.at < 120000); }
function leader() { return active().sort((a, b) => +b.visible - +a.visible || a.id.localeCompare(b.id))[0]?.id || network.node; }
function amLeader() { return !!network && leader() === network.node; }
function pendingCost() { return [...pending.values()].reduce((n, p) => n + (p.cost || 0), 0); }
function balance() { return identity ? world.wallet(identity.actor) - pendingCost() : 20; }
function update() {
  if (!identity) return; const count = world.counts(); $('online').textContent = new Set(active().map(m => m.actor)).size || 1; $('fishCount').textContent = count.fish; $('sceneCount').textContent = count.scene; $('balance').textContent = balance();
  const remain = Math.max(0, 3600 - Math.floor(identity.remainder || 0)); $('hourProgress').textContent = `下一字符 ${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;
  $('worldLabel').textContent = world.roots.length > 1 ? `合流之海 · ${world.roots.length} 个起源` : '新生的海'; $('networkStatus').textContent = status || (network.live().length ? `伙伴已接入 · 世界由浏览器共同维持` : '独自在线，也可以开始创作');
  $('depthLabel').textContent = `水深 ${Math.max(0, Math.round(renderer.camera.y))} 格 · ${renderer.camera.y < CONFIG.shallow ? '浅水区' : '深水区'}`; $('zoomLabel').textContent = Math.round(renderer.scale * 100) + '%';
  $('networkDetails').textContent = `直连邻居 ${network.live().length}/8 · 已收 ${(network.stats.received / 1024).toFixed(0)} KB · 已发 ${(network.stats.sent / 1024).toFixed(0)} KB`;
  if (selected) inspect(selected, false);
}
function remember(url) { if (!url || url === meta?.url) return; if (!known.includes(url)) { known.push(url); set('known', known).catch(() => {}); } }
function syncIncomeSerial() { for (const op of Object.values(world.data.ops)) if (op.kind === 'earn' && op.actor === identity.actor) identity.serial = Math.max(identity.serial || 0, op.serial); }
async function requestHistory(peer) { const ids = (historyQueues.get(peer.id) || []).filter(id => !histories[id]); historyQueues.set(peer.id, ids); if (ids.length) await network.direct(peer, 'historyRequest', { ids: ids.slice(0, 32) }); else historyQueues.delete(peer.id); }
async function verifyReplica(data) {
  if (!data || data.protocol !== 1 || !data.roots || !data.chars || !data.fishes || !data.scenes || !data.ops || Object.keys(data.chars).length > 100000 || Object.keys(data.ops).length > 500000) throw new Error('世界快照不兼容或超出首版规模');
  for (const [id, op] of Object.entries(data.ops)) { if (world.data.ops[id]) { if (JSON.stringify(opBody(world.data.ops[id])) !== JSON.stringify(opBody(op))) throw new Error('已有消费记录不可覆盖'); } else { const { proof, ...clean } = op; if (id !== op.id || !proof || proof.kind !== 'op' || JSON.stringify(clean) !== JSON.stringify(proof.body) || proof.actor !== op.actor || !await verifyEnvelope(proof) || world.validOp(op)) throw new Error('世界包含无效操作凭据'); } }
  for (const [root, at] of Object.entries(data.roots)) if (!/^[0-9a-f-]{36}$/i.test(root) || !Number.isFinite(at)) throw new Error('世界起源无效');
  for (const [id, c] of Object.entries(data.chars)) {
    if (id !== c.id) throw new Error('字符身份重复或被篡改');
    if (!validGlyph(c.ch) || !/^#[0-9a-f]{6}$/i.test(c.color) || !Number.isInteger(c.x) || !Number.isInteger(c.y) || !Array.isArray(c.path) || c.path.length > 1024 || !['fish', 'scene', 'food', 'burn'].includes(c.kind)) throw new Error('世界字符无效');
    const source = data.ops[c.id.slice(0, 36)] || world.data.ops[c.id.slice(0, 36)], index = +c.id.slice(37);
    const initial = source?.kind === 'food' && c.id === source.id ? source : ['fish', 'scene'].includes(source?.kind) ? source.cells[index] : source?.kind === 'sceneScale' && source.factor === 2 && Number.isInteger(index) && index >= 0 && index < source.cost * 4 / 3 && index % 4 !== 0 ? c : null;
    if (!initial || source.actor !== c.payer) throw new Error('字符缺少合法消费凭据');
    if (c.kind === 'fish' || c.kind === 'food') { if (!['food', 'fish'].includes(source.kind) || initial.ch !== c.ch || initial.color !== c.color) throw new Error('鱼字符只能由合法创建与生态流转生成'); if (c.kind === 'fish' && !c.path.length && (c.entity !== source.id || c.x !== initial.x || c.y !== initial.y)) throw new Error('禁止人工重排已投放的鱼'); }
  }
}
async function mergeReplica(data) {
  await verifyReplica(data); world.merge(data);
  // An expired local copy can be restored only after hearing its roots from a live peer.
  const checkpoint = priorCheckpoint;
  if (checkpoint?.world?.roots && Object.keys(checkpoint.world.roots).some(r => world.roots.includes(r))) {
    await verifyReplica(checkpoint.world); world.merge(checkpoint.world); if (priorCheckpoint === checkpoint) priorCheckpoint = null;
    await network.broadcast('merge', { world: world.serialize() });
  }
}
function resumeAfterInactivity(now = Date.now()) {
  const elapsed = now - lastOnlineAt;
  if (elapsed > 120000) {
    const checkpoint = { world: world.serialize(), picture: lastPicture || localPicture(), lastOnlineAt };
    const restored = restoreCheckpoint(checkpoint, now);
    if (restored.expired) {
      priorCheckpoint = checkpoint; world = restored.world;
      acceptHistory({ ...checkpoint.picture, status: 'ended', endedAt: restored.expiresAt });
      lastPicture = null; pending.clear(); inbox.clear(); selected = null; renderer.selected = null; $('inspector').hidden = true; cancelMode();
    } else world.data.tick = now;
    members.clear(); members.set(network.node, member()); lastHello.clear(); lastLeader = ''; lastFull = 0; sentChars.clear(); sentOps.clear(); lastPictureTime = 0;
  }
  lastOnlineAt = Math.max(lastOnlineAt, now);
  if (elapsed > 120000) { networkChange().catch(() => {}); reconnect().catch(() => {}); }
}
function reconcileHistory() {
  let changed = false; for (const card of Object.values(histories)) if (card.roots.some(r => world.roots.includes(r)) && card.status !== 'corrected') { card.status = 'corrected'; changed = true; } if (changed) set('histories', histories).catch(() => {});
}
function acceptHistory(card) {
  if (!card || !Array.isArray(card.roots) || typeof card.image !== 'string' || card.image.length > 3000000 || !/^data:image\/(webp|png);base64,/.test(card.image)) return;
  let target = clone(card); for (const [id, existing] of Object.entries(histories)) if (existing.roots.some(r => target.roots.includes(r))) { target = { ...(existing.at > target.at ? existing : target), roots: [...new Set([...existing.roots, ...target.roots])] }; delete histories[id]; }
  target.id = target.roots.slice().sort()[0]; if (target.roots.some(r => world.roots.includes(r))) target.status = 'corrected'; histories[target.id] = target; set('histories', histories).catch(() => {});
}
async function onMessage(message, peer) {
  resumeAfterInactivity();
  if (members.has(message.from) && members.get(message.from).actor !== message.actor) return;
  const body = message.body;
  if (message.kind === 'hello') {
    if (message.from !== peer.node || body.member?.id !== message.from || body.member.actor !== message.actor) return;
    const own = body.member; members.set(own.id, { ...own, url: peer.url, at: Date.now() }); remember(peer.url);
    for (const m of body.members || []) remember(m.url);
    const newKnowledge = Object.keys(body.world.roots || {}).some(r => !world.data.roots[r]) || Object.keys(body.world.ops || {}).some(id => !world.data.ops[id]);
    await mergeReplica(body.world); geometryRepair = true;
    if (newKnowledge) await network.broadcast('merge', { world: body.world });
    reconcileHistory(); syncIncomeSerial(); lastPictureTime = 0;
    for (const card of body.cards || []) acceptHistory(card);
    const missing = (body.historyIndex || []).filter(id => !histories[id]); if (missing.length) { historyQueues.set(peer.id, missing); await requestHistory(peer); }
    status = ''; toast('已接入伙伴，两个世界正在合流'); update();
  } else if (message.kind === 'beat') {
    if (body.member?.id === message.from && body.member.actor === message.actor) { const direct = network.live().find(p => p.node === message.from); members.set(message.from, { ...body.member, url: direct?.url || body.member.url, at: Date.now() }); remember(body.member.url); if (amLeader() && Date.now() - lastRepair > 5000 && (body.rootCount > world.roots.length || body.opCount > Object.keys(world.data.ops).length)) { lastRepair = Date.now(); network.broadcast('replicaRequest', { to: message.from }).catch(() => {}); } }
  } else if (message.kind === 'merge') {
    await mergeReplica(body.world); geometryRepair = true; reconcileHistory(); syncIncomeSerial(); update();
  } else if (message.kind === 'replicaRequest') {
    if (body.to === network.node) await network.broadcast('merge', { world: world.serialize() });
  } else if (message.kind === 'world') {
    if (message.from !== leader()) return; await mergeReplica(body.world); syncIncomeSerial(); for (const id of pending.keys()) if (world.data.ops[id]) pending.delete(id); reconcileHistory(); update();
  } else if (message.kind === 'op') {
    if (body.actor !== message.actor || !Array.isArray(body.roots) || !body.roots.some(r => world.roots.includes(r))) return;
    inbox.set(body.id, clone(message));
    if (amLeader()) { const result = world.apply({ ...clone(body), proof: clone(message) }); if (result.ok) await save(); await network.broadcast('ack', { id: body.id, result }); if (result.ok) await broadcastWorld(); }
  } else if (message.kind === 'ack') {
    if (message.from !== leader()) return; const op = pending.get(body.id); if (op && !body.result.ok) { pending.delete(body.id); toast(body.result.error); update(); }
  } else if (message.kind === 'chat') {
    if (typeof body.text !== 'string' || body.text.length > 160) return; appendChat(body.nick, body.text, message.actor);
  } else if (message.kind === 'picture') {
    if (message.from === leader() && body.roots.some(r => world.roots.includes(r))) lastPicture = body;
  } else if (message.kind === 'historyRequest') {
    const ids = (body.ids || []).slice(0, 32); for (const id of ids) if (histories[id]) await network.direct(peer, 'history', { card: histories[id] });
    await network.direct(peer, 'historyEnd', { ids });
  } else if (message.kind === 'history') acceptHistory(body.card);
  else if (message.kind === 'historyEnd') { historyQueues.set(peer.id, (historyQueues.get(peer.id) || []).filter(id => !body.ids?.includes(id))); await requestHistory(peer); }
  else if (message.kind === 'lost') probeGone(body.id, body.url);
}
async function networkChange(error) {
  if (!started) return; if (error) { status = error; update(); return; }
  const live = network.live();
  for (const p of live) if (!lastHello.has(p.id)) { lastHello.add(p.id); await network.direct(p, 'hello', { member: member(), members: active(), world: world.serialize(), cards: Object.values(histories).slice(0, 3), historyIndex: Object.keys(histories) }); }
  const ids = new Set(live.map(p => p.node)); for (const m of active()) if (m.id !== network.node && m.direct && !ids.has(m.id)) { m.direct = false; probeGone(m.id, m.url); } for (const id of ids) if (members.has(id)) members.get(id).direct = true;
  network.presence(active().filter(m => m.id !== network.node).map(m => ({ id: m.id, url: m.url }))).catch(() => {}); update();
}
async function probeGone(id, url) { if (!id || id === network.node || !members.has(id)) return; try { const s = await network.local('probe', { url }); if (!(s.clients || []).some(c => c.id === id)) { members.delete(id); await network.broadcast('lost', { id, url }); update(); } } catch { /* Membership lease expires if the publishing computer is unreachable. */ } }
async function broadcastWorld() {
  if (snapshotBusy || !amLeader()) return; snapshotBusy = true;
  try {
    const full = Date.now() - lastFull > 30000, data = world.data, chars = {}, ops = {}, nextMarks = new Map();
    for (const [id, c] of Object.entries(data.chars)) { const mark = `${c.kind}:${c.entity}:${c.x}:${c.y}:${c.ch}:${c.color}:${c.editAt || 0}:${c.moveAt || 0}:${JSON.stringify(c.path)}`; nextMarks.set(id, mark); if (full || sentChars.get(id) !== mark) chars[id] = c; }
    for (const [id, op] of Object.entries(data.ops)) if (full || !sentOps.has(id)) ops[id] = op;
    await network.broadcast('world', { delta: !full, world: { protocol: 1, roots: data.roots, tick: data.tick, chars, fishes: data.fishes, scenes: data.scenes, participants: data.participants, ops, notices: [] } });
    sentChars = nextMarks; sentOps = new Set(Object.keys(data.ops)); if (full) lastFull = Date.now();
  } catch (e) { status = e.message; } finally { snapshotBusy = false; }
}
async function submit(payload) {
  if (started) resumeAfterInactivity();
  if (!identity) return; const op = { id: payload.kind === 'earn' ? `${identity.actor}:hour:${payload.serial}` : crypto.randomUUID(), actor: identity.actor, nick: maskNick(identity.nick), t: Date.now(), roots: [world.id], cost: 0, ...payload };
  if (op.cost > 0 && op.cost > balance()) { toast('字符余额不足'); return; } pending.set(op.id, op); update();
  try { const message = await network.broadcast('op', op); inbox.set(op.id, clone(message)); if (amLeader()) { const result = world.apply({ ...clone(op), proof: message }); pending.delete(op.id); if (!result.ok) toast(result.error); else await save(); await broadcastWorld(); } else { setTimeout(() => { if (pending.has(op.id)) toast('这次投放仍在等待确认，连接恢复后同步'); }, 12000); } } catch (e) { pending.delete(op.id); toast(e.message); } update();
}
function cancelMode() { mode = null; renderer.preview = null; $('modeBanner').hidden = true; $('sea').style.cursor = 'grab'; }
function placement(kind, cells) { mode = { kind, cells }; $('modeBanner').textContent = `在空水域点击投放${kind === 'fish' ? '鱼' : '造景'} · 消耗 ${cells.length} 字符 · Esc 取消`; $('modeBanner').hidden = false; $('sea').style.cursor = 'crosshair'; }
function feedMode() { if (balance() < 1) { toast('投食需要 1 字符余额'); return; } mode = { kind: 'food', ch: validGlyph($('glyphInput').value) ? $('glyphInput').value : '。', color: $('colorInput').value }; renderer.camera.y = 12; $('modeBanner').textContent = '选择水面上的一个位置投食 · 每颗 1 字符 · Esc 取消'; $('modeBanner').hidden = false; $('sea').style.cursor = 'crosshair'; update(); }
function inspect(hit, show = true) {
  selected = hit; if (hit.kind === 'monument') { historyDialog(); selected = null; return; }
  const object = hit.kind === 'fish' ? world.data.fishes[hit.id] : world.data.scenes[hit.id]; if (!object) { $('inspector').hidden = true; selected = null; return; }
  const cells = hit.kind === 'fish' ? world.fishCells(hit.id) : world.sceneCells(hit.id); $('objectTitle').textContent = `${object.nick || '自然沉积'} 的${hit.kind === 'fish' ? '鱼' : '造景'}`;
  if (hit.kind === 'fish') { const v = velocities(cells), eyes = cells.filter(c => EYES.has(c.ch)).length; $('objectInfo').textContent = `${cells.length} 字符 · ${eyes ? eyes + ' 个眼睛' : '盲鱼'} · 水平 ${v.x.toFixed(2)} 格/秒 · 垂直 ${v.y.toFixed(2)} 格/秒`; $('objectFootnote').textContent = `投放后不可人工修改或删除。距下次饥饿约 ${Math.max(0, (object.hungerAt - Date.now()) / 3600000).toFixed(1)} 小时。`; $('sceneActions').hidden = true; renderer.selected = null; }
  else { $('objectInfo').textContent = `${cells.length} 字符 · 八方向地形 · 共享摆放`; $('objectFootnote').textContent = '移除、缩小不返字符；放大产生的新字符需要支付配额。'; $('sceneActions').hidden = false; renderer.selected = hit.id; }
  if (show) $('inspector').hidden = false;
}
function appendChat(nick, text, actor) { chats.push({ nick, text, actor }); chats = chats.slice(-200); renderChat(); }
function renderChat() { const log = $('chatMessages'); log.replaceChildren(); for (const c of chats.slice(-80)) { const p = document.createElement('p'); p.className = 'message'; const n = document.createElement('span'); n.className = 'name'; n.textContent = c.nick || '匿名'; n.style.color = `hsl(${hash(c.actor || '') % 360} 55% 75%)`; p.append(n, document.createTextNode(c.text)); log.append(p); } log.scrollTop = log.scrollHeight; }
function historyDialog() { const container = $('historyCards'); container.replaceChildren(); const cards = Object.values(histories).filter(c => c.status !== 'corrected').sort((a, b) => b.at - a.at); if (!cards.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '海还年轻，暂时没有湮灭的记忆。'; container.append(p); } for (const card of cards) { const article = document.createElement('article'); article.className = 'historyCard'; const img = document.createElement('img'); img.src = card.image; img.alt = '旧世界全景合影'; img.onclick = () => { const a = document.createElement('a'); a.href = card.image; a.download = '鱼来-世界合影.webp'; a.click(); }; const div = document.createElement('div'), title = document.createElement('h3'), info = document.createElement('p'); title.textContent = `海 ${card.id.slice(0, 6)} · ${new Date(card.at).toLocaleString('zh-CN')}`; info.textContent = `${card.counts?.fish || 0} 条鱼 · ${card.counts?.scene || 0} 处造景 · ${card.participants || 1} 位参与者${card.status === 'pending' ? ' · 暂定湮灭，重逢后校正' : ''}`; div.append(title, info); article.append(img, div); container.append(article); } $('historyDialog').showModal(); }
function localPicture() { return { id: world.id, roots: world.roots, image: renderer.snapshot(world), at: Date.now(), counts: world.counts(), participants: Object.keys(world.data.participants).length || 1 }; }
async function save() { if (!identity) return; if (!lastPicture || JSON.stringify(lastPicture.counts) !== JSON.stringify(world.counts()) || !lastPicture.roots.includes(world.id)) lastPicture = localPicture(); await putMany([['identity', identity], ['histories', histories], ['known', known], ['checkpoint', { world: world.serialize(), picture: lastPicture, at: Date.now(), lastOnlineAt }]]); }
async function takePicture() { if (!amLeader()) return; lastPicture = localPicture(); await network.broadcast('picture', lastPicture); }
async function reconnect() { const input = new URLSearchParams(location.search).get('join') || meta.joinUrl; const urls = [...new Set([input, ...known].filter(Boolean))]; for (const url of urls.slice(0, 12)) { if (network.live().length) break; try { await network.connect(url); remember(url); } catch { } } }
async function start() {
  meta = await (await fetch('/local/meta')).json(); if (!meta.token) throw new Error('请运行自己的启动器，从固定本地地址进入');
  identity = await get('identity'); if (!identity) { $('welcomeDialog').showModal(); await new Promise(resolve => $('welcomeForm').onsubmit = async e => { e.preventDefault(); const nick = $('nickInput').value.trim(); if (!nick) return; identity = await newIdentity(nick); $('welcomeDialog').close(); resolve(); }); }
  histories = await get('histories') || {}; known = await get('known') || []; const previous = await get('checkpoint'), now = Date.now(), restored = restoreCheckpoint(previous, now);
  if (previous?.world && !restored.expired) await verifyReplica(previous.world);
  world = restored.world; lastOnlineAt = now; lastMeter = now;
  if (restored.expired) { priorCheckpoint = previous; if (previous.picture) acceptHistory({ ...previous.picture, status: 'ended', endedAt: restored.expiresAt }); }
  else reconcileHistory();
  network = new Network(identity, meta, onMessage, networkChange); await network.start(maskNick(identity.nick)); started = true; members.set(network.node, member());
  $('myUrl').value = meta.url; creator = new Creator(placement, balance);
  syncIncomeSerial(); await save();
  reconnect().catch(() => {}); update(); lastPictureTime = Date.now(); takePicture().catch(() => {});
  setInterval(tick, CONFIG.step); setInterval(() => { network.presence(active().filter(m => m.id !== network.node).map(m => ({ id: m.id, url: m.url }))).catch(() => {}); if (network.connections.size < 6) { const candidate = active().filter(m => m.id !== network.node && !network.has(m.id)).sort((a, b) => hash(`${network.node}:${a.id}`) - hash(`${network.node}:${b.id}`))[0]; if (candidate) network.connect(candidate.url, candidate.id).catch(() => {}); } }, 6000);
  document.addEventListener('visibilitychange', () => { resumeAfterInactivity(); network.broadcast('beat', { member: member() }).catch(() => {}); save().catch(() => {}); });
  window.addEventListener('pagehide', () => { const blob = new Blob([JSON.stringify({ node: network.node, token: meta.token })], { type: 'application/json' }); navigator.sendBeacon('/local/unregister', blob); lastPicture = localPicture(); save().catch(() => {}); });
  // Exposes read-only diagnostics for the project's automated browser checks.
  window.tide = { get world() { return { data: world.serialize(), counts: world.counts() }; }, get network() { return { node: network.node, leader: leader(), peers: network.live().map(p => ({ node: p.node, url: p.url })), stats: clone(network.stats) }; }, get identity() { return { actor: identity.actor, nick: maskNick(identity.nick) }; }, get histories() { return clone(histories); }, balance };
}
async function tick() {
  const now = Date.now(), elapsed = now - lastMeter; lastMeter = now;
  if (elapsed < 90000) identity.remainder = (identity.remainder || 0) + elapsed / 1000;
  resumeAfterInactivity(now);
  if (identity.remainder >= 3600) { identity.remainder -= 3600; identity.serial = (identity.serial || 0) + 1; await submit({ kind: 'earn', cost: 0, serial: identity.serial }); }
  members.set(network.node, member());
  if (now - selfBeat >= 3000) { selfBeat = now; network.broadcast('beat', { member: member(), rootCount: world.roots.length, opCount: Object.keys(world.data.ops).length }).catch(() => {}); }
  const currentLeader = leader(); if (currentLeader !== lastLeader) { lastLeader = currentLeader; lastFull = 0; sentChars.clear(); sentOps.clear(); if (amLeader()) { geometryRepair = true; world.data.tick = Math.max(world.data.tick, now - 2000); for (const envelope of [...inbox.values()].sort((a, b) => a.body.t - b.body.t || a.body.id.localeCompare(b.body.id))) { if (!world.data.ops[envelope.body.id]) { const result = world.apply({ ...clone(envelope.body), proof: clone(envelope) }); network.broadcast('ack', { id: envelope.body.id, result }).catch(() => {}); } } for (const id of pending.keys()) if (world.data.ops[id]) pending.delete(id); } }
  if (amLeader() && geometryRepair) { const result = world.reconcileGeometry(now); geometryRepair = false; if (result.waiting) toast('世界空间不足，部分合流造景仍待安置'); }
  if (amLeader()) { let loops = 0; while (world.data.tick + CONFIG.step <= now && loops++ < 20) world.step(world.data.tick + CONFIG.step); if (now - lastSnapshot >= 1000) { lastSnapshot = now; broadcastWorld(); } }
  if (now - lastSave > 5000) { lastSave = now; save().catch(e => toast('本地保存失败：' + e.message)); }
  if (amLeader() && now - lastPictureTime > 30000) { lastPictureTime = now; takePicture().catch(() => {}); }
  update();
}

$('makeFish').onclick = () => { cancelMode(); creator?.open('fish'); }; $('makeScene').onclick = () => { cancelMode(); creator?.open('scene'); }; $('feed').onclick = () => feedMode();
$('surface').onclick = () => { renderer.camera.y = 12; update(); }; $('seabed').onclick = () => { renderer.camera = { x: MONUMENT.x + 4, y: CONFIG.depth - 15 }; update(); };
$('zoomIn').onclick = () => { renderer.zoom(renderer.scale + .15); update(); }; $('zoomOut').onclick = () => { renderer.zoom(renderer.scale - .15); update(); };
$('connect').onclick = () => $('connectionDialog').showModal(); $('closeConnection').onclick = () => $('connectionDialog').close();
$('connectionForm').onsubmit = async e => { e.preventDefault(); const url = $('peerUrl').value.trim(); status = '正在自动配对…'; update(); try { await network.connect(url); remember(url); $('connectionDialog').close(); } catch (e) { status = e.message; toast(e.message); } update(); };
$('copyUrl').onclick = async () => { await navigator.clipboard.writeText(meta.url); toast('发布地址已复制'); };
$('backup').onclick = () => download('鱼来-身份与记忆备份.json', { format: 'tide-backup-1', identity, histories, known });
$('importBackup').onchange = async e => { try { const data = JSON.parse(await e.target.files[0].text()); if (data.format !== 'tide-backup-1' || !data.identity?.secret || await actorId(data.identity.pub) !== data.identity.actor) throw new Error('备份无效'); await putMany([['identity', data.identity], ['histories', data.histories || {}], ['known', data.known || []]]); await network.stop(); location.reload(); } catch (e) { toast(e.message); } };
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = () => $('helpDialog').close(); $('closeHistory').onclick = () => $('historyDialog').close();
$('collapseChat').onclick = () => { document.querySelector('.chat').classList.toggle('collapsed'); $('collapseChat').textContent = document.querySelector('.chat').classList.contains('collapsed') ? '+' : '−'; };
$('chatForm').onsubmit = async e => { e.preventDefault(); const text = $('chatInput').value.trim(); if (!text || Date.now() - lastChat < 1500) return; lastChat = Date.now(); const nick = maskNick(identity.nick); appendChat(nick, text, identity.actor); $('chatInput').value = ''; await network.broadcast('chat', { nick, text, t: Date.now() }); };
$('closeInspector').onclick = () => { selected = null; renderer.selected = null; $('inspector').hidden = true; };
$('moveScene').onclick = () => { if (!selected) return; mode = { kind: 'sceneMove', scene: selected.id, cells: world.sceneCells(selected.id) }; $('modeBanner').textContent = '选择造景的新位置 · 不返还或消耗现有字符 · Esc 取消'; $('modeBanner').hidden = false; };
$('rotateScene').onclick = () => selected && submit({ kind: 'sceneRotate', scene: selected.id, cost: 0 });
$('scaleScene').onclick = () => selected && submit({ kind: 'sceneScale', scene: selected.id, factor: 2, cost: world.sceneCells(selected.id).length * 3 });
$('shrinkScene').onclick = () => selected && submit({ kind: 'sceneScale', scene: selected.id, factor: .5, cost: 0 });
$('deleteScene').onclick = () => { if (!selected) return; submit({ kind: 'sceneDelete', scene: selected.id, cost: 0 }); selected = null; renderer.selected = null; $('inspector').hidden = true; };
$('sea').oncontextmenu = e => { e.preventDefault(); cancelMode(); };
$('sea').addEventListener('pointerdown', e => { if (e.button !== 0) return; if (mode) { const p = renderer.point(e.clientX, e.clientY); if (mode.kind === 'food') { if (p.y !== 0) { toast('请在亮蓝色水面行点击投食'); return; } submit({ kind: 'food', ch: mode.ch, color: mode.color, x: p.x, y: 0, cost: 1 }); } else { const b = bounds(mode.cells), x = p.x - b.minX, y = p.y - b.minY; submit({ kind: mode.kind, cells: mode.cells, scene: mode.scene, x, y, cost: mode.kind === 'sceneMove' ? 0 : mode.cells.length }); cancelMode(); } return; } dragging = { startX: e.clientX, startY: e.clientY, x: renderer.camera.x, y: renderer.camera.y, moved: false }; $('sea').setPointerCapture(e.pointerId); });
$('sea').addEventListener('pointermove', e => { if (mode) { const p = renderer.point(e.clientX, e.clientY), b = bounds(mode.cells || []); renderer.preview = { ...mode, x: mode.kind === 'food' ? p.x : p.x - b.minX, y: mode.kind === 'food' ? 0 : p.y - b.minY }; } else if (dragging) { const s = renderer.cell * renderer.scale; renderer.camera.x = Math.min(CONFIG.width, Math.max(0, dragging.x - (e.clientX - dragging.startX) / s)); renderer.camera.y = Math.min(CONFIG.depth, Math.max(0, dragging.y - (e.clientY - dragging.startY) / s)); dragging.moved ||= Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 4; update(); } });
$('sea').addEventListener('pointerup', e => { if (dragging && !dragging.moved) { const hit = renderer.hit(e.clientX, e.clientY); if (hit) inspect(hit); else { selected = null; renderer.selected = null; $('inspector').hidden = true; } } dragging = null; });
$('sea').addEventListener('wheel', e => { e.preventDefault(); renderer.zoom(renderer.scale * (e.deltaY < 0 ? 1.1 : .9)); update(); }, { passive: false });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { cancelMode(); return; } if (e.target.matches('input,textarea') || document.querySelector('dialog[open]')) return; if (e.key.toLowerCase() === 'f') $('makeFish').click(); else if (e.key.toLowerCase() === 's') $('makeScene').click(); else if (e.key.toLowerCase() === 'e') feedMode(); else if (e.key.toLowerCase() === 'm') $('seabed').click(); });
function render() { renderer.draw(world); requestAnimationFrame(render); } render(); start().catch(e => { toast(e.message); status = e.message; $('networkStatus').textContent = e.message; });
