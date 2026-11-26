import { CHAT_FLOOR, validChatMessage, buildChatFloor, chatGlyphs } from './chat.js';
import { applyInputRows, worldEdited, worldRevision } from './simulation-changes.js';
import { shanghaiDay, mealIndex, fishStatus, mergeTravel, feedingStatus, lastMealAt } from './fish-status.js';
import { HOUR, updateSeaweed } from './seaweed.js';
import { MINUTE, updateBubbles, mergeBubbles } from './bubbles.js';
import { initialLife, initialSources, validInitialOp } from './genesis.js';
import { fishNameError } from './fish-profile.js';
import { newEcology, ensureEcology, updateEcology, validEcology, mergeEcology } from './ecology.js';
import { emptyArchiveState, mergeArchiveState, operationValue, archiveDependencies } from './archive.js';
import { LIFE, newLife, lifeContext, updateLife, idleMotion, spawnPlankton, recordStory, mergeLife, validateLife, freshPlankton } from './life.js';
import { REFERRAL_REWARD, referralError, chooseReferral } from './referral.js';
import { WORLD_WIDTH, MAX_FLOOR, wrapX, worldKey, deltaX, nearX, makeTerrain, terrainOf, validTerrain, chooseTerrain, floorAt, waterAt } from './geography.js';
import { canonicalBirthFish, canonicalBirthPath, fishOrigin, activeBreeding, finishBreeding, updateContacts, motionUnits, commitUnit, mergeBreeding, normalizeBreeding, normalizeBirthCells, writeBreedingRecord } from './breeding.js';
import { newLegends, processLegends, capturedFish, retargetCapture, mergeLegends, settleLegendary, validLegends, legendSchedule } from './legends.js';
export const CONFIG = Object.freeze({ width: WORLD_WIDTH, depth: MAX_FLOOR + 1, shallow: 60, sightShallow: 20, sightDeep: 10, step: 500, speed: 2, foodLife: 300000, hunger: 86400000, initial: 20, offlineLife: 240 * 60 * 60 * 1000 });
export const MONUMENT = { x: 610, y: CONFIG.depth - 5, rows: ['  ____  ', ' /记忆\\ ', ' | 口 | ', ' |____| ', '________'] };
// The fixed monument provides one memory entrance, separate from scenery entities.
export const sceneryCount = data => Object.keys(data.scenes).filter(id => data.ops[id]?.kind === 'scene').length + 1;
export const EYES = new Set(['0', 'O', 'o', '。', '.', '口']);
export const NEIGHBORS = [-1, 0, 1].flatMap(x => [-1, 0, 1].map(y => [x, y])).filter(([x, y]) => x || y);
export const clone = value => structuredClone(value);
export const key = worldKey;
const localKey = (x, y) => `${x},${y}`;
export const ordinal = (a, b) => a === b ? 0 : a > b ? 1 : -1;
export function hash(text) { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619); return n >>> 0; }
export function validGlyph(ch) { return typeof ch === 'string' && Array.from(ch).length === 1 && !/\s/u.test(ch) && (/^[\x21-\x7e]$/.test(ch) || /\p{Script=Han}/u.test(ch) || /^[\u3001-\u303f\uff01-\uff65]$/u.test(ch)); }
export function bounds(cells) { if (!cells.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }; const xs = cells.map(c => c.x), ys = cells.map(c => c.y); const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys); return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }; }
export function components(cells) {
  const remaining = new Map(cells.map(c => [key(c.x, c.y), c])), groups = [];
  while (remaining.size) { const start = remaining.values().next().value, queue = [start], group = []; remaining.delete(key(start.x, start.y));
    for (let i = 0; i < queue.length; i++) { const c = queue[i]; group.push(c); for (const [dx, dy] of NEIGHBORS) { const p = key(c.x + dx, c.y + dy); if (remaining.has(p)) { queue.push(remaining.get(p)); remaining.delete(p); } } } groups.push(group);
  } return groups;
}
export function exteriorContour(cells) {
  const occupied = new Set(cells.map(c => localKey(c.x, c.y))), b = bounds(cells), outside = new Set(), queue = [[b.minX - 1, b.minY - 1]];
  outside.add(localKey(...queue[0]));
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = queue[i][0] + dx, y = queue[i][1] + dy, k = localKey(x, y);
    if (x < b.minX - 1 || x > b.maxX + 1 || y < b.minY - 1 || y > b.maxY + 1 || occupied.has(k) || outside.has(k)) continue;
    outside.add(k); queue.push([x, y]);
  }
  return cells.filter(c => NEIGHBORS.some(([dx, dy]) => outside.has(localKey(c.x + dx, c.y + dy))));
}
export function validateDrawing(cells, kind, balance = Infinity) {
  const size = kind === 'fish' ? 15 : 20;
  if (!Array.isArray(cells) || cells.length < 2) return '至少需要两个相连的鱼元';
  if (kind === 'fish' && cells.length > 15) return '创建鱼最多使用 15 个鱼元';
  if (cells.length > balance) return '鱼元余额不足';
  if (cells.some(c => !Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 || c.x >= size || c.y >= size || !validGlyph(c.ch) || !/^#[0-9a-f]{6}$/i.test(c.color))) return '每格只能有一个中文或 ASCII 鱼元及有效颜色';
  if (new Set(cells.map(c => key(c.x, c.y))).size !== cells.length) return '鱼元位置不能重复';
  if (components(cells).length !== 1) return '所有鱼元必须八方向连成一个整体';
  return '';
}
export function cellPosition(fish, cell) { return { x: fish.x + fish.facing * cell.x, y: fish.y + cell.y }; }
export function velocities(cells) { const b = bounds(cells); return { x: CONFIG.speed * b.width / Math.max(1, cells.length), y: CONFIG.speed * b.height / Math.max(1, cells.length) }; }
export const sightRadius = depth => depth < CONFIG.shallow ? CONFIG.sightShallow : CONFIG.sightDeep;
export function canSee(fish, cells, food) { return cells.some(c => { if (!EYES.has(c.ch)) return false; const p = cellPosition(fish, c); return Math.max(Math.abs(deltaX(food.x, p.x)), Math.abs(p.y - food.y)) <= sightRadius(p.y); }); }
export function touching(fish, cells, food, scenery = new Map()) { return cells.some(c => { const p = cellPosition(fish, c), dx = Math.abs(deltaX(food.x, p.x)), dy = Math.abs(p.y - food.y); return dx <= 1 && dy <= 1 && (dx || dy) && !(dx && dy && (scenery.has(key(p.x, food.y)) || scenery.has(key(food.x, p.y)))); }); }
export function displayNick(value) { return typeof value === 'string' ? value.trim() : ''; }
export const maskNick = displayNick; // Old test fixtures and saved tools can keep importing this alias.

function compareTransition(a, b) {
  if (a.id === b.id && JSON.stringify(a) === JSON.stringify(b)) return 0;
  if (a.t !== b.t) return a.t < b.t ? 1 : -1;
  if (a.reason === 'expire' && b.reason === 'eat') return 1;
  if (b.reason === 'expire' && a.reason === 'eat') return -1;
  if (a.reason === 'eat' && b.reason === 'eat' && a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  const ha = hash(JSON.stringify(a)), hb = hash(JSON.stringify(b)); return ha === hb ? ordinal(JSON.stringify(a), JSON.stringify(b)) : ha > hb ? 1 : -1;
}
export function chooseClaim(a, b) {
  const burnedA = a.path?.some(e => e.reason === 'legendBurn'), burnedB = b.path?.some(e => e.reason === 'legendBurn');
  if (burnedA !== burnedB) return burnedA ? a : b;
  const aa = a.path || [], bb = b.path || []; let i = 0;
  while (i < Math.min(aa.length, bb.length)) { const c = compareTransition(aa[i], bb[i]); if (c) return c > 0 ? a : b; i++; }
  if (aa.length !== bb.length) return aa.length > bb.length ? a : b;
  if ((a.moveAt || 0) !== (b.moveAt || 0)) return (a.moveAt || 0) > (b.moveAt || 0) ? a : b;
  if ((a.editAt || 0) !== (b.editAt || 0)) return (a.editAt || 0) > (b.editAt || 0) ? a : b;
  return ordinal(JSON.stringify(a), JSON.stringify(b)) >= 0 ? a : b;
}
function transition(c, next, record) { Object.assign(c, next); c.path.push({ ...record, target: next.entity || '', x: next.x, y: next.y }); }

export class World {
  constructor(now = Date.now(), id = crypto.randomUUID(), { populate = true, ambient = true } = {}) {
    this.data = { protocol: 1, roots: { [id]: now }, terrain: makeTerrain(id, now), tick: now, seaweedHour: Math.floor(now / HOUR), bubbleMinute: Math.floor(now / MINUTE), bubbles: {}, chars: {}, fishes: {}, breeding: {}, contacts: {}, contactAt: now, scenes: {}, ops: {}, participants: {}, notices: [], chats: {}, chatSources: {}, pendingChatGlyphs: 0, travel: {} };
    this.data.life = newLife(now);
    this.data.legends = newLegends(now);
    this.data.ecology = newEcology(now);
    this.data.archives = emptyArchiveState(now);
    this.ambient = ambient;
    this.dirty = true; this.foodRevision = 0;
    if (populate) {
      const life = initialLife(id, now); Object.assign(this.data.chars, life.chars);
      for (const op of Object.values(life.ops)) { const result = this.apply(op); if (!result.ok) throw new Error(result.error); }
    }
  }
  get id() { return Object.keys(this.data.roots).sort()[0]; }
  get roots() { return Object.keys(this.data.roots); }
  floorAt(x) { return floorAt(this.data, x); }
  waterAt(x, y) { return waterAt(this.data, x, y); }
  get monument() { const width = Math.max(...MONUMENT.rows.map(row => Array.from(row).length)); return { ...MONUMENT, y: Math.min(...Array.from({ length: width }, (_, i) => this.floorAt(MONUMENT.x + i))) - MONUMENT.rows.length }; }
  serialize() { return clone(this.data); }
  attachArchives(store) { worldEdited(this); this.archives = store; Object.defineProperty(this.data, 'archivedCatalog', { configurable: true, get: () => store.summary.catalog }); }
  initializeTracking(now = Date.now()) {
    this.data.travel ||= {};
    for (const fish of Object.values(this.data.fishes)) this.data.travel[fish.id] ||= { since: Math.max(fish.created, now), days: {} };
  }
  recordMovement(id, distance, now) {
    if (!Number.isFinite(distance) || !(distance > 0) || !this.data.fishes[id]) return;
    const record = this.data.travel[id] ||= { since: now, days: {} }, day = shanghaiDay(now);
    record.days[day] = (record.days[day] || 0) + distance;
  }
  fishStatus(id, now = Date.now()) {
    const fish = this.data.fishes[id]; if (!fish) return null;
    if (!this.mealCache || this.mealCache.revision !== this.foodRevision || now < this.mealCache.at) this.mealCache = { revision: this.foodRevision, at: now, fish: mealIndex(this.data.chars, now) };
    return fishStatus(fish, this.data.travel[id], this.mealCache.fish.get(id), now);
  }
  fishOrigin(id) { return fishOrigin(this.data, id); }
  breedingState(id) { return activeBreeding(this.data, id); }
  swimVelocities(id) { const record = this.breedingState(id); if (!record) return velocities(this.fishCells(id)); const cells = [record.male, record.female].flatMap(parent => this.fishCells(parent).map(cell => { const p = cellPosition(this.data.fishes[parent], cell); return { ...cell, x: nearX(p.x, this.data.fishes[record.male].x), y: p.y }; })); return velocities(cells); }
  myFishes(actor) { return Object.values(this.data.fishes).filter(fish => this.fishOrigin(fish.id)?.actor === actor).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)); }
  addChat(message) {
    if (!validChatMessage(message) || !message.body.roots.some(root => this.data.roots[root] !== undefined)) return { ok: false, error: '聊天不属于当前世界' };
    if (this.archives?.ids.chats.has(message.id)) return { ok: true, duplicate: true };
    const existing = this.data.chats[message.id];
    if (existing) return JSON.stringify(existing) === JSON.stringify(message) ? { ok: true, duplicate: true } : { ok: false, error: '已有聊天记录不可覆盖' };
    const rows = [['chats', message.id, clone(message)]];
    if (!this.data.participants[message.actor]) rows.push(['participants', message.actor, displayNick(message.body.nick)]);
    applyInputRows(this, rows);
    return { ok: true };
  }
  reconcileChatFloor(now = this.data.tick) {
    worldEdited(this);
    if (!Object.keys(this.data.chatSources || {}).length) {
      for (const id in this.data.chars) if (this.data.chars[id].chat) delete this.data.chars[id];
      delete this.data.scenes[CHAT_FLOOR];
      this.data.pendingChatGlyphs = 0; this.dirty = true;
      return { chars: {}, waiting: 0 };
    }
    const occupied = new Set(this.fishMap().keys());
    const monument = this.monument, monumentWidth = Math.max(...monument.rows.map(row => Array.from(row).length));
    for (let y = monument.y; y < monument.y + monument.rows.length; y++) for (let x = monument.x; x < monument.x + monumentWidth; x++) occupied.add(key(x, y));
    for (const c of Object.values(this.data.chars)) {
      if (c.kind === 'food') occupied.add(key(c.x, c.y));
      else if (c.kind === 'scene' && !c.chat) { const s = this.data.scenes[c.entity]; if (s) occupied.add(key(s.x + c.x, s.y + c.y)); }
    }
    const result = buildChatFloor(this.data.chatSources, { ...CONFIG, floorAt: x => this.floorAt(x) }, occupied, hash);
    for (const [id, c] of Object.entries(this.data.chars)) if (c.chat && !result.chars[id]) delete this.data.chars[id];
    for (const [id, c] of Object.entries(result.chars)) {
      const old = this.data.chars[id]; this.data.chars[id] = { ...c, moveAt: old && old.x === c.x && old.y === c.y ? old.moveAt : now };
    }
    if (this.sceneCells(CHAT_FLOOR).length) this.data.scenes[CHAT_FLOOR] = { id: CHAT_FLOOR, actor: '', nick: '旧海的聊天', x: 0, y: 0, posAt: 0, poseId: CHAT_FLOOR, fixed: true };
    else delete this.data.scenes[CHAT_FLOOR];
    this.data.pendingChatGlyphs = result.waiting; this.dirty = true; return result;
  }
  fishCells(id) { return Object.values(this.data.chars).filter(c => c.kind === 'fish' && c.entity === id); }
  sceneCells(id) { return Object.values(this.data.chars).filter(c => c.kind === 'scene' && c.entity === id); }
  fishGroups() { const map = new Map(); for (const c of Object.values(this.data.chars)) if (c.kind === 'fish') { if (!map.has(c.entity)) map.set(c.entity, []); map.get(c.entity).push(c); } return map; }
  wallet(actor) {
    const ops = this.data.ops, revision = worldRevision(this), archiveRevision = this.archives?.revision;
    const cache = this.walletCache;
    if (cache && cache.actor === actor && cache.ops === ops && cache.revision === revision && cache.archiveRevision === archiveRevision) return cache.value;
    let value = CONFIG.initial + (this.archives?.summary.ledger[actor] || 0);
    for (const id in ops) {
      const op = ops[id], archived = this.archives?.summary.ops[id];
      if (archived) value -= operationValue(archived, actor);
      if (op.kind === 'referral' && op.inviter === actor && !referralError(op)) value += REFERRAL_REWARD;
      if (op.actor === actor) value += op.kind === 'earn' ? 1 : -(op.cost || 0);
    }
    this.walletCache = { actor, ops, revision, archiveRevision, value };
    return value;
  }
  surfaceBlocked(x) {
    const { chars, fishes, scenes } = this.data;
    const occupies = cell => {
      const fish = cell.kind === 'fish';
      const owner = fish ? fishes[cell.entity] : cell.kind === 'scene' ? scenes[cell.entity] : undefined;
      return owner && owner.y + cell.y === 0 && wrapX(owner.x + (fish ? owner.facing : 1) * cell.x) === x;
    };
    const candidates = this.surfaceCandidates?.(x);
    if (candidates) return candidates.some(occupies);
    for (const id in chars) if (occupies(chars[id])) return true;
    return false;
  }
  sceneryMap() {
    const map = new Map(); for (const c of Object.values(this.data.chars)) if (c.kind === 'scene') { const s = this.data.scenes[c.entity]; if (s) map.set(key(s.x + c.x, s.y + c.y), { scene: s, cell: c }); } return map;
  }
  fishMap() { const map = new Map(); for (const [id, cells] of this.fishGroups()) { const f = this.data.fishes[id]; if (f) for (const c of cells) { const p = cellPosition(f, c); map.set(key(p.x, p.y), id); } } return map; }
  fishOccupants(groups = this.fishGroups()) { const map = new Map(); for (const [id, cells] of groups) { const fish = this.data.fishes[id]; if (!fish) continue; for (const cell of cells) { const p = cellPosition(fish, cell), k = key(p.x, p.y); if (!map.has(k)) map.set(k, new Set()); map.get(k).add(id); } } return map; }
  collisionIds(f) { const pair = this.data.breeding[f.id]; return new Set(pair?.status === 'active' ? [pair.male, pair.female] : [f.id]); }
  canOccupy(f, cells, scenery = this.sceneryMap(), occupants = this.fishOccupants()) { const ignored = this.collisionIds(f), positions = cells.map(c => cellPosition(f, c)); return new Set(positions.map(p => key(p.x, p.y))).size === cells.length && positions.every(p => { const k = key(p.x, p.y); return this.waterAt(p.x, p.y) && !scenery.has(k) && ![...(occupants.get(k) || [])].some(id => !ignored.has(id)); }); }
  updateFishOccupants(occupants, members, groups, remove = false) { for (const fish of members) for (const cell of groups.get(fish.id) || []) { const p = cellPosition(fish, cell), k = key(p.x, p.y); if (remove) { occupants.get(k)?.delete(fish.id); if (!occupants.get(k)?.size) occupants.delete(k); } else { if (!occupants.has(k)) occupants.set(k, new Set()); occupants.get(k).add(fish.id); } } }
  separateFish(now = this.data.tick) {
    normalizeBreeding(this, now);
    // A takeover normally receives an already placed world. One bit per water
    // cell proves separation without constructing a Set for every body cell.
    const occupied = new Uint8Array(Math.ceil(CONFIG.width * CONFIG.depth / 8));
    let conflict = false;
    for (const id in this.data.chars) {
      const cell = this.data.chars[id];
      if (cell.kind !== 'fish') continue;
      const fish = this.data.fishes[cell.entity];
      if (!fish) continue;
      const { x, y } = cellPosition(fish, cell), column = wrapX(x);
      if (!Number.isInteger(column) || !Number.isInteger(y) || !this.waterAt(column, y)) { conflict = true; break; }
      const index = y * CONFIG.width + column, byte = Math.floor(index / 8), bit = 1 << (index % 8);
      if (occupied[byte] & bit) { conflict = true; break; }
      occupied[byte] |= bit;
    }
    if (!conflict) return { moved: 0, waiting: 0 };
    const groups = this.fishGroups(), occupants = this.fishOccupants(groups), scenery = this.sceneryMap(), resources = new Set(Object.values(this.data.chars).filter(c => ['food', 'seaweed'].includes(c.kind)).map(c => key(c.x, c.y))), processed = new Set();
    let moved = 0, waiting = 0;
    for (const unit of motionUnits(this, groups).sort((a, b) => a.id.localeCompare(b.id))) {
      const { fish, cells, members } = unit;
      const overlaps = cells.some(cell => { const p = cellPosition(fish, cell); return !this.waterAt(p.x, p.y) || [...(occupants.get(key(p.x, p.y)) || [])].some(id => processed.has(id)); });
      if (overlaps) {
        const fits = (x, y) => { const next = { ...fish, x, y }; return this.canOccupy(next, cells, scenery, occupants) && cells.every(cell => { const p = cellPosition(next, cell); return !resources.has(key(p.x, p.y)); }); };
        let target;
        for (let radius = 1; radius <= CONFIG.width + CONFIG.depth && !target; radius++) for (let dx = -radius; dx <= radius && !target; dx++) { const dy = radius - Math.abs(dx); for (const offset of dy ? [-dy, dy] : [0]) if (fits(fish.x + dx, fish.y + offset)) { target = [fish.x + dx, fish.y + offset]; break; } }
        if (target) { this.updateFishOccupants(occupants, members, groups, true); [fish.x, fish.y] = target; fish.cx = fish.cy = 0; commitUnit(unit, Math.max(now, ...members.map(member => member.posAt + 1))); for (const member of members) retargetCapture(this.data, member.id, now); this.updateFishOccupants(occupants, members, groups); moved++; this.dirty = true; }
        else waiting++;
      }
      for (const member of members) processed.add(member.id);
    }
    return { moved, waiting };
  }
  reconcileGeometry(now = this.data.tick) {
    worldEdited(this);
    // The elected browser separates overlapping fish and places conflicting scenery as a whole.
    this.data.terrain ||= terrainOf(this.data);
    for (const cell of Object.values(this.data.chars)) if (['food', 'seaweed'].includes(cell.kind) && !this.waterAt(cell.x, cell.y)) { cell.x = wrapX(cell.x); cell.y = Math.max(0, Math.min(cell.y, this.floorAt(cell.x) - 1)); if (cell.kind === 'seaweed') transition(cell, { kind: 'food', entity: '', born: now, fall: 0 }, { id: `terrain-uproot:${cell.id}`, t: now, reason: 'uproot' }); cell.moveAt = now; this.foodRevision++; this.dirty = true; }
    const fishRepair = this.separateFish(now);
    this.reconcileChatFloor(now);
    if (!Object.keys(this.data.scenes).length) return { waiting: 0, fishWaiting: fishRepair.waiting, fishMoved: fishRepair.moved };
    const occupied = new Set(this.fishMap().keys());
    for (const c of Object.values(this.data.chars)) if (c.kind === 'food') occupied.add(key(c.x, c.y));
    const scenes = new Map(); for (const c of Object.values(this.data.chars)) if (c.kind === 'scene') { if (!scenes.has(c.entity)) scenes.set(c.entity, []); scenes.get(c.entity).push(c); }
    let waiting = 0;
    for (const s of Object.values(this.data.scenes).sort((a, b) => a.id.localeCompare(b.id))) {
      const cells = scenes.get(s.id) || [], b = bounds(cells);
      if (s.id === CHAT_FLOOR) { for (const c of cells) occupied.add(key(s.x + c.x, s.y + c.y)); continue; }
      const fits = (x, y) => cells.every(c => this.waterAt(x + c.x, y + c.y) && !occupied.has(key(x + c.x, y + c.y)));
      if (!fits(s.x, s.y)) {
        let target;
        for (let radius = 1; radius <= CONFIG.width + CONFIG.depth && !target; radius++) for (let dx = -radius; dx <= radius && !target; dx++) {
          const dy = radius - Math.abs(dx); for (const offset of dy ? [-dy, dy] : [0]) if (fits(s.x + dx, s.y + offset)) { target = [s.x + dx, s.y + offset]; break; }
        }
        if (target) { [s.x, s.y] = target; s.posAt = Math.max(now, s.posAt + 1); s.poseId = `merge-place:${s.id}:${s.posAt}`; this.dirty = true; } else waiting++;
      }
      for (const c of cells) occupied.add(key(s.x + c.x, s.y + c.y));
    }
    return { waiting, fishWaiting: fishRepair.waiting, fishMoved: fishRepair.moved };
  }
  validOp(op) {
    if (op?.genesis !== undefined && !validInitialOp(op, initialSources(this.data.roots))) return '初始鱼记录被修改或无效';
    if (!op || typeof op.id !== 'string' || typeof op.actor !== 'string' || !Number.isFinite(op.t) || !['fish', 'scene', 'food', 'sceneMove', 'sceneDelete', 'sceneRotate', 'sceneScale', 'sceneEdit', 'earn', 'referral'].includes(op.kind)) return '不支持的操作';
    if (op.genesis === undefined && op.t > Date.now() + 60000) return '操作时间无效';
    if (!['earn', 'referral'].includes(op.kind) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(op.id)) return '操作标识无效';
    if (!Number.isInteger(op.cost) || op.cost < 0 || (!['fish', 'scene', 'food', 'sceneScale'].includes(op.kind) && op.cost !== 0)) return '鱼元费用无效';
    if (['fish', 'scene'].includes(op.kind)) { const e = validateDrawing(op.cells, op.kind); if (e) return e; if (op.cost !== op.cells.length) return '鱼元费用不一致'; }
    if (op.kind === 'fish' && op.gender !== undefined && !['male', 'female'].includes(op.gender)) return '鱼的性别无效';
    if (op.kind === 'fish' && fishNameError(op.name, op.cells.length)) return fishNameError(op.name, op.cells.length);
    if (op.kind === 'food' && (!validGlyph(op.ch) || !/^#[0-9a-f]{6}$/i.test(op.color) || op.cost !== 1 || op.y !== 0)) return '鱼食只能从水面投放';
    if (op.kind === 'earn' && (op.cost !== 0 || !Number.isInteger(op.serial) || op.serial < 1 || op.id !== `${op.actor}:hour:${op.serial}`)) return '在线奖励无效';
    if (op.kind === 'referral') return referralError(op);
    return '';
  }
  apply(op, archivedOp) {
    const prior = this.data.ops[op.id];
    if (prior || this.archives?.ids.ops.has(op.id)) {
      if (op.kind === 'referral' && (!prior || prior.kind === 'referral')) {
        if (!prior && !archivedOp) throw new Error('缺少已归档推广凭据');
        const error = this.validOp(op);
        if (error) return { ok: false, error };
        const chosen = chooseReferral(prior || archivedOp, op);
        if (chosen !== prior) {
          this.walletCache = null;
          applyInputRows(this, [['ops', op.id, clone(chosen)]]);
        }
      }
      return { ok: true, duplicate: true };
    }
    const invalid = this.validOp(op); if (invalid) return { ok: false, error: invalid };
    if (op.cost > 0 && op.cost > this.wallet(op.actor)) return { ok: false, error: '鱼元余额不足，合并超支需由在线奖励抵扣' };
    if (['fish', 'scene', 'food'].includes(op.kind) && (!Number.isInteger(op.x) || op.x < 0 || op.x >= CONFIG.width || !Number.isInteger(op.y))) return { ok: false, error: '投放位置无效' };
    if (['food', 'earn', 'referral'].includes(op.kind)) {
      const rows = [];
      if (op.kind === 'food') {
        if (this.surfaceBlocked(op.x)) return { ok: false, error: '这里的水面已被占用，请换个位置' };
        rows.push(['chars', op.id, { id: op.id, payer: op.actor, ch: op.ch, color: op.color, kind: 'food', entity: '', x: op.x, y: 0, born: op.t, fall: 0, path: [], created: op.t }]);
      }
      rows.push(['ops', op.id, clone(op)]);
      const nick = op.nick || this.data.participants[op.actor] || '匿名';
      if (this.data.participants[op.actor] !== nick) rows.push(['participants', op.actor, nick]);
      if (this.walletCache) this.walletCache.value += operationValue(op, this.walletCache.actor);
      applyInputRows(this, rows);
      return { ok: true };
    }
    worldEdited(this);
    const scenery = this.sceneryMap(), fishMap = this.fishMap(), seaweedMap = new Set(Object.values(this.data.chars).filter(c => c.kind === 'seaweed').map(c => key(c.x, c.y)));
    if (op.kind === 'fish') {
      const f = { id: op.id, actor: op.actor, nick: op.nick, ...(op.name === undefined ? {} : { name: op.name }), ...(op.gender === undefined ? {} : { gender: op.gender }), x: op.x, y: op.y, facing: 1, created: op.t, lastFed: op.t, hungerAt: op.t + CONFIG.hunger, cx: 0, cy: 0, posAt: op.t };
      if (!this.canOccupy(f, op.cells, scenery) || op.cells.some(c => Object.values(this.data.chars).some(existing => ['food', 'seaweed'].includes(existing.kind) && wrapX(existing.x) === wrapX(f.x + c.x) && existing.y === f.y + c.y))) return { ok: false, error: '鱼体碰到其他鱼、造景、食物或世界边界，换个空位置投放' };
      this.data.fishes[f.id] = f;
      this.data.travel[f.id] = { since: op.t, days: {} };
      op.cells.forEach((c, i) => this.data.chars[`${op.id}:${i}`] = { ...c, id: `${op.id}:${i}`, payer: op.actor, kind: 'fish', entity: f.id, path: [], created: op.t });
    } else if (op.kind === 'scene') {
      if (op.cells.some(c => { const x = op.x + c.x, y = op.y + c.y; return !this.waterAt(x, y) || fishMap.has(key(x, y)) || seaweedMap.has(key(x, y)) || scenery.has(key(x, y)); })) return { ok: false, error: '造景不能覆盖鱼、海草或已有造景' };
      this.data.scenes[op.id] = { id: op.id, actor: op.actor, nick: op.nick, x: op.x, y: op.y, posAt: op.t, poseId: op.id };
      op.cells.forEach((c, i) => this.data.chars[`${op.id}:${i}`] = { ...c, id: `${op.id}:${i}`, payer: op.actor, kind: 'scene', entity: op.id, path: [], created: op.t });
    } else if (op.kind.startsWith('scene')) {
      const s = this.data.scenes[op.scene]; if (!s) return { ok: false, error: '造景已不存在' };
      if (s.id === CHAT_FLOOR) return { ok: false, error: '海底聊天记忆已固化，不能编辑、搬动或删除' };
      const cells = this.sceneCells(s.id);
      if (op.kind === 'sceneDelete') { for (const c of cells) transition(c, { kind: 'burn', entity: '' }, { id: op.id, t: op.t, reason: 'delete' }); delete this.data.scenes[s.id]; }
      else if (op.kind === 'sceneMove') {
        if (!Number.isInteger(op.x) || !Number.isInteger(op.y)) return { ok: false, error: '位置无效' };
        if (cells.some(c => !this.waterAt(op.x + c.x, op.y + c.y) || fishMap.has(key(op.x + c.x, op.y + c.y)) || seaweedMap.has(key(op.x + c.x, op.y + c.y)) || (scenery.has(key(op.x + c.x, op.y + c.y)) && scenery.get(key(op.x + c.x, op.y + c.y)).scene.id !== s.id))) return { ok: false, error: '这里会覆盖鱼、海草或其他造景' };
        Object.assign(s, { x: op.x, y: op.y, posAt: op.t, poseId: op.id });
      } else if (op.kind === 'sceneEdit') {
        const c = this.data.chars[op.cell]; if (!c || c.entity !== s.id || c.kind !== 'scene' || !validGlyph(op.ch) || !/^#[0-9a-f]{6}$/i.test(op.color)) return { ok: false, error: '鱼元无效' }; Object.assign(c, { ch: op.ch, color: op.color, editAt: op.t });
      } else {
        const b = bounds(cells), next = [];
        if (op.kind === 'sceneRotate') for (const c of cells) next.push({ c, x: b.minX + b.maxY - c.y, y: b.minY + c.x - b.minX });
        else if (op.factor === 2) for (const c of cells) for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) next.push({ c, x: b.minX + (c.x - b.minX) * 2 + x, y: b.minY + (c.y - b.minY) * 2 + y, fresh: !!(x || y) });
        else if (op.factor === 0.5) { const seen = new Set(); for (const c of [...cells].sort((a, b) => a.id.localeCompare(b.id))) { const x = b.minX + Math.floor((c.x - b.minX) / 2), y = b.minY + Math.floor((c.y - b.minY) / 2); if (!seen.has(key(x, y))) { seen.add(key(x, y)); next.push({ c, x, y }); } } }
        else return { ok: false, error: '缩放无效' };
        const expected = next.filter(c => c.fresh).length; if ((op.cost || 0) !== expected) return { ok: false, error: '缩放费用不一致' };
        if (new Set(next.map(n => key(s.x + n.x, s.y + n.y))).size !== next.length) return { ok: false, error: '造景跨越整圈后会重叠，不能继续放大' };
        if (next.some(n => !this.waterAt(s.x + n.x, s.y + n.y) || fishMap.has(key(s.x + n.x, s.y + n.y)) || seaweedMap.has(key(s.x + n.x, s.y + n.y)) || (scenery.has(key(s.x + n.x, s.y + n.y)) && scenery.get(key(s.x + n.x, s.y + n.y)).scene.id !== s.id))) return { ok: false, error: '变形会覆盖鱼、海草或其他造景' };
        const retained = new Set(next.filter(n => !n.fresh).map(n => n.c.id)); for (const c of cells) if (!retained.has(c.id)) transition(c, { kind: 'burn', entity: '' }, { id: op.id, t: op.t, reason: 'delete' });
        next.forEach((n, i) => { if (n.fresh) { const { wild, plankton, ghost, ...copied } = clone(n.c); this.data.chars[`${op.id}:${i}`] = { ...copied, id: `${op.id}:${i}`, payer: op.actor, x: n.x, y: n.y, path: [], created: op.t, editAt: op.t }; } else Object.assign(n.c, { x: n.x, y: n.y, editAt: op.t }); }); s.posAt = op.t; s.poseId = op.id;
      }
    }
    this.data.ops[op.id] = clone(op); this.data.participants[op.actor] = op.nick || this.data.participants[op.actor] || '匿名';
    if (op.kind === 'fish' && op.genesis === undefined) recordStory(this, 'arrive', op.id, op.t);
    this.dirty = true; return { ok: true };
  }
  step(now) {
    this.initializeTracking(now);
    processLegends(this, now, transition);
    finishBreeding(this, now, transition);
    if (this.ambient) updateEcology(this, now, transition);
    updateSeaweed(this, now, CONFIG, this.monument, hash, transition);
    updateBubbles(this, now);
    if (this.ambient) spawnPlankton(this, now);
    const dt = Math.min(1, Math.max(0, (now - this.data.tick) / 1000)); this.data.tick = now;
    const scenery = this.sceneryMap(), groups = this.fishGroups();
    const fishOccupancy = this.fishOccupants(groups);
    const pastMeals = new Set(), pastGrass = new Set(), latestMeals = new Map();
    for (const c of Object.values(this.data.chars)) for (const event of c.path) if (event.reason === 'eat') { pastMeals.add(event.target); if (c.wild) pastGrass.add(event.target); if (Number.isFinite(event.t)) latestMeals.set(event.target, Math.max(latestMeals.get(event.target) ?? -Infinity, event.t)); }
    for (const f of Object.values(this.data.fishes)) { const recorded = Math.max(latestMeals.get(f.id) ?? -Infinity, this.archives?.summary.lastMeals.get(f.id) ?? -Infinity), at = lastMealAt(f, recorded); if (at !== undefined) f.lastMealAt = at; }
    const canEat = id => !!this.data.fishes[id] && !capturedFish(this.data, id, now) && feedingStatus(this.data.fishes[id], now).canEat;
    const ambient = this.ambient ? lifeContext(this, now, scenery, groups) : null; if (ambient) updateLife(this, now, ambient);
    for (const c of Object.values(this.data.chars)) if (freshPlankton(c) && c.kind === 'food' && now - c.born >= LIFE.planktonLife) { transition(c, { kind: 'burn', entity: '' }, { id: `dissolve:${c.id}`, t: c.born + LIFE.planktonLife, reason: 'dissolve' }); this.dirty = true; }
    const foods = Object.values(this.data.chars).filter(c => c.kind === 'food').sort((a, b) => a.born - b.born || a.id.localeCompare(b.id));
    const foodCount = new Map(); for (const c of foods) foodCount.set(key(c.x, c.y), (foodCount.get(key(c.x, c.y)) || 0) + 1);
    const contact = food => {
      const at = key(food.x, food.y);
      if (scenery.has(at)) return [];
      const ids = new Set();
      for (const [dx, dy] of NEIGHBORS) {
        for (const id of fishOccupancy.get(key(food.x + dx, food.y + dy)) || []) ids.add(id);
      }
      return [...ids].filter(id => !fishOccupancy.get(at)?.has(id) && canEat(id) && touching(this.data.fishes[id], groups.get(id), food, scenery));
    };
    for (const c of foods) {
      if (now - c.born >= CONFIG.foodLife && scenery.has(key(c.x, c.y))) {
        // Stacked food may expire in the same cell. Preserve it in the nearest free supported slot.
        let slot;
        for (let r = 1; r <= CONFIG.depth + CONFIG.width && !slot; r++) for (let dx = -r; dx <= r && !slot; dx++) {
          const dy = r - Math.abs(dx); for (const sy of dy ? [-dy, dy] : [0]) {
            const x = wrapX(c.x + dx), y = c.y + sy, k = key(x, y);
            if (this.waterAt(x, y) && !scenery.has(k) && !fishOccupancy.has(k) && !(foodCount.get(k) > 0) && (y === this.floorAt(x) - 1 || scenery.has(key(x, y + 1)))) { slot = [x, y]; break; }
          }
        }
        if (slot) { const old = key(c.x, c.y); foodCount.set(old, Math.max(0, foodCount.get(old) - 1)); [c.x, c.y] = slot; foodCount.set(key(c.x, c.y), 1); c.moveAt = now; }
      }
      const blocked = c.y >= this.floorAt(c.x) - 1 || scenery.has(key(c.x, c.y + 1)), eatContact = now - c.born < CONFIG.foodLife && contact(c).length;
      if (now - c.born >= CONFIG.foodLife && blocked && !fishOccupancy.has(key(c.x, c.y)) && !scenery.has(key(c.x, c.y))) {
        const support = scenery.get(key(c.x, c.y + 1)), id = support?.scene.id || `deposit:${c.id}:${c.path.length}`;
        if (!this.data.scenes[id]) this.data.scenes[id] = { id, actor: c.payer, nick: this.data.participants[c.payer] || '自然沉积', x: c.x, y: c.y, posAt: now, poseId: id };
        const s = this.data.scenes[id], px = c.x, py = c.y; transition(c, { kind: 'scene', entity: id, x: deltaX(c.x, s.x), y: c.y - s.y }, { id: `settle:${c.id}:${c.path.length}`, t: c.born + CONFIG.foodLife, reason: 'expire' }); this.dirty = true; scenery.set(key(px, py), { scene: s, cell: c }); continue;
      }
      c.fall = blocked || eatContact || fishOccupancy.has(key(c.x, c.y + 1)) || (foodCount.get(key(c.x, c.y + 1)) > 0) ? 0 : (c.fall || 0) + dt * CONFIG.depth / 300;
      while (c.fall >= 1 && c.y + 1 < this.floorAt(c.x) && !scenery.has(key(c.x, c.y + 1)) && !fishOccupancy.has(key(c.x, c.y + 1)) && !(foodCount.get(key(c.x, c.y + 1)) > 0)) { const old = key(c.x, c.y); foodCount.set(old, Math.max(0, foodCount.get(old) - 1)); c.y++; c.fall--; foodCount.set(key(c.x, c.y), (foodCount.get(key(c.x, c.y)) || 0) + 1); }
      c.moveAt = now;
    }
    const edible = [...foods.filter(c => c.kind === 'food' && now - c.born < CONFIG.foodLife), ...Object.values(this.data.chars).filter(c => c.kind === 'seaweed')].sort((a, b) => (a.born ?? a.created) - (b.born ?? b.created) || a.id.localeCompare(b.id)), foodPositions = new Set([...foods.filter(c => c.kind === 'food'), ...edible].map(c => key(c.x, c.y)));
    const turningObstacles = new Map(scenery); for (const cell of edible) if (cell.kind === 'seaweed') turningObstacles.set(key(cell.x, cell.y), {});
    const waitingToEat = new Set(); for (const food of edible) for (const id of contact(food)) waitingToEat.add(id);
    const bins = new Map();
    for (const food of edible) { const bin = key(Math.floor(wrapX(food.x) / 10), Math.floor(food.y / 10)); if (!bins.has(bin)) bins.set(bin, []); bins.get(bin).push(food); }
    for (const unit of motionUnits(this, groups).sort((a, b) => a.id.localeCompare(b.id))) {
      const { id, cells, fish: f } = unit; if (!cells.length) continue;
      if (unit.members.some(member => capturedFish(this.data, member.id, now))) continue;
      if (unit.members.some(member => waitingToEat.has(member.id))) { commitUnit(unit, now); continue; }
      const found = new Map();
      const seeking = bins.size && unit.members.some(member => canEat(member.id));
      for (const eye of cells) if (EYES.has(eye.ch) && seeking) {
        const p = cellPosition(f, eye), r = sightRadius(p.y), binWidth = CONFIG.width / 10;
        for (let bx = Math.floor((p.x - r) / 10); bx <= Math.floor((p.x + r) / 10); bx++) for (let by = Math.floor((p.y - r) / 10); by <= Math.floor((p.y + r) / 10); by++) {
          for (const food of bins.get(key((bx % binWidth + binWidth) % binWidth, by)) || []) if (Math.max(Math.abs(deltaX(food.x, p.x)), Math.abs(food.y - p.y)) <= r) found.set(food.id, food);
        }
      }
      const visible = [...found.values()];
      const center = bounds(cells), midX = f.x + f.facing * (center.minX + center.maxX) / 2, midY = f.y + (center.minY + center.maxY) / 2;
      visible.sort((a, b) => (Math.abs(deltaX(a.x, midX)) + Math.abs(a.y - midY)) - (Math.abs(deltaX(b.x, midX)) + Math.abs(b.y - midY)) || a.id.localeCompare(b.id));
      let dx, dy; if (visible.length) { dx = Math.sign(deltaX(visible[0].x, midX)); dy = Math.sign(visible[0].y - midY); }
      else if (ambient) { const motion = idleMotion(this, f, now, ambient, { x: midX, y: midY }); dx = motion.dx; dy = motion.dy; }
      else { const phase = Math.floor((now - f.created) / 12000), r = hash(`${id}:${phase}`); dx = [-1, 0, 1][r % 3]; dy = [-1, 0, 1][Math.floor(r / 3) % 3]; }
      this.updateFishOccupants(fishOccupancy, unit.members, groups, true);
      // A blocked ambient direction needs a way out, especially when several
      // friends select different companions in a packed group. Probe real cells
      // against the live occupancy map; normal velocity and collision rules still apply.
      if (ambient && unit.members.length === 1 && (dx || dy)) {
        const free = (x, y) => { const next = { ...f }; if (x && x !== next.facing) this.turn(next, cells, turningObstacles, fishOccupancy); next.x += x; next.y += y; return this.canOccupy(next, cells, scenery, fishOccupancy) && cells.every(c => { const p = cellPosition(next, c); return !foodPositions.has(key(p.x, p.y)); }); };
        if (!(dx && free(dx, 0)) && !(dy && free(0, dy))) {
          const choices = [[0, -1], [0, 1], [-1, 0], [1, 0]], offset = hash(`avoid:${id}:${Math.floor(now / 12000)}`) % choices.length;
          for (let i = 0; i < choices.length; i++) { const [x, y] = choices[(offset + i) % choices.length]; if (free(x, y)) { dx = x; dy = y; break; } }
        }
      }
      if (dx && dx !== f.facing) this.turn(f, cells, turningObstacles, fishOccupancy);
      let movedX = 0, movedY = 0;
      const v = velocities(cells); f.cx = dx ? Math.min(2, (f.cx || 0) + v.x * dt) : 0; f.cy = dy ? Math.min(2, (f.cy || 0) + v.y * dt) : 0;
      if (f.cx >= 1 && dx) { const next = { ...f, x: f.x + dx }; if (this.canOccupy(next, cells, scenery, fishOccupancy) && cells.every(c => { const p = cellPosition(next, c); return !foodPositions.has(key(p.x, p.y)); })) { f.x += dx; movedX = dx; } f.cx--; }
      if (f.cy >= 1 && dy) { const next = { ...f, y: f.y + dy }; if (this.canOccupy(next, cells, scenery, fishOccupancy) && cells.every(c => { const p = cellPosition(next, c); return !foodPositions.has(key(p.x, p.y)); })) { f.y += dy; movedY = dy; } f.cy--; }
      commitUnit(unit, now);
      this.updateFishOccupants(fishOccupancy, unit.members, groups);
      for (const member of unit.members) this.recordMovement(member.id, Math.hypot(movedX, movedY), now);
    }
    for (const food of edible) {
      if (!['food', 'seaweed'].includes(food.kind) || !this.waterAt(food.x, food.y) || fishOccupancy.has(key(food.x, food.y))) continue;
      const candidates = contact(food);
      // A winner becomes ineligible for an hour, so every remaining candidate still has its pre-meal size.
      candidates.sort((a, b) => groups.get(b).length - groups.get(a).length || hash(`${food.id}:${b}`) - hash(`${food.id}:${a}`) || a.localeCompare(b));
      if (candidates.length) {
        const winner = candidates[0], grass = food.kind === 'seaweed';
        const previouslyAte = (grass ? pastGrass : pastMeals).has(winner) || (grass ? this.archives?.summary.grassMeals.has(winner) : this.archives?.summary.lastMeals.has(winner));
        const id = winner, cs = groups.get(id), f = this.data.fishes[id]; fishOccupancy.set(key(food.x, food.y), new Set([id])); transition(food, { kind: 'fish', entity: id, x: deltaX(food.x, f.x) * f.facing, y: food.y - f.y }, { id: `eat:${food.id}:${food.path.length}`, t: now, reason: 'eat', rank: cs.length }); cs.push(food); f.lastFed = now; f.hungerAt = now + CONFIG.hunger; this.foodRevision++; this.dirty = true;
        if (!previouslyAte) recordStory(this, grass ? 'grass' : 'meal', id, now);
        f.lastMealAt = now; pastMeals.add(id); if (grass) pastGrass.add(id);
        if (food.ghost) { const s = legendSchedule(this.data.roots, food.ghost.seed, food.ghost.slot); recordStory(this, 'shipMeal', id, now, { legendary: s.id, legendSeed: s.seed, legendSlot: s.slot }); }
      }
    }
    for (const [id, cells] of groups) { const f = this.data.fishes[id]; if (f && now >= f.hungerAt) this.starve(id, f.hungerAt); }
    normalizeBreeding(this, now); updateContacts(this, now, this.fishGroups(), scenery);
  }
  turn(f, cells, scenery = this.sceneryMap(), occupants = this.fishOccupants()) {
    const b = bounds(cells), next = { ...f, x: f.x + f.facing * (b.minX + b.maxX), facing: -f.facing };
    const ignored = this.collisionIds(f);
    for (const c of cells) { const a = cellPosition(f, c), z = cellPosition(next, c); for (let x = Math.min(a.x, z.x); x <= Math.max(a.x, z.x); x++) if (!this.waterAt(x, a.y) || scenery.has(key(x, a.y)) || [...(occupants.get(key(x, a.y)) || [])].some(id => !ignored.has(id))) return false; }
    if (!this.canOccupy(next, cells, scenery, occupants)) return false; f.x = next.x; f.facing = next.facing; return true;
  }
  starve(id, at, selectedId = null) {
    const f = this.data.fishes[id], cells = this.fishCells(id); if (!f || cells.length < 2) return;
    const rim = exteriorContour(cells);
    const removed = rim.find(c => c.id === selectedId) || [...rim].sort((a, b) => hash(`${id}:${at}:${a.id}`) - hash(`${id}:${at}:${b.id}`) || a.id.localeCompare(b.id))[0];
    const event = `hunger:${id}:${at}`; transition(removed, { kind: 'burn', entity: '' }, { id: event, t: at, reason: 'starve' });
    const remaining = cells.filter(c => c !== removed), parts = components(remaining).sort((a, b) => b.length - a.length || hash(`${event}:${a.map(c => c.id).sort()[0]}`) - hash(`${event}:${b.map(c => c.id).sort()[0]}`));
    const kept = parts[0]?.length >= 2 ? new Set(parts[0].map(c => c.id)) : new Set();
    for (const c of remaining) if (!kept.has(c.id)) { const p = cellPosition(f, c); transition(c, { kind: 'food', entity: '', x: wrapX(p.x), y: p.y, born: at, fall: 0 }, { id: event, t: at, reason: 'shed' }); }
    if (!kept.size) { delete this.data.fishes[id]; recordStory(this, 'depart', id, at); } else f.hungerAt = at + CONFIG.hunger;
    this.dirty = true;
  }
  merge(other, archived = {}) {
    worldEdited(this);
    if (!other || other.protocol !== 1 || !other.chars || !other.fishes || !other.scenes || !other.ops) throw new Error('世界协议不兼容');
    if (other.terrain && !validTerrain(other.terrain, other.roots)) throw new Error('固定海底地形被修改或无效');
    for (const [root, at] of Object.entries(other.roots || {})) if (this.data.roots[root] !== undefined && this.data.roots[root] !== at) throw new Error('世界起源时间不能修改');
    const initial = initialSources({ ...this.data.roots, ...other.roots });
    if (!validEcology(other.ecology, Math.max(Date.now() + 60000, other.tick))) throw new Error('生态更替时钟无效');
    if (!validateLife(other.life, { roots: { ...this.data.roots, ...other.roots }, ops: { ...archived.ops, ...this.data.ops, ...other.ops }, breeding: { ...archived.breeding, ...this.data.breeding, ...other.breeding }, chars: { ...archived.chars, ...this.data.chars, ...other.chars } }, Math.max(Date.now() + 60000, this.data.tick, other.tick))) throw new Error('鱼生记录无效');
    if (!validLegends(other.legends, { roots: { ...this.data.roots, ...other.roots }, ops: { ...archived.ops, ...this.data.ops, ...other.ops }, breeding: { ...archived.breeding, ...this.data.breeding, ...other.breeding } }, Math.max(Date.now() + 60000, this.data.tick, other.tick))) throw new Error('稀有异象记录无效');
    for (const op of Object.values(other.ops)) if (op.genesis !== undefined && !validInitialOp(op, initial)) throw new Error('初始鱼记录被修改或无效');
    this.data.terrain = clone(chooseTerrain(terrainOf(this.data), terrainOf(other)));
    Object.assign(this.data.roots, other.roots);
    for (const [id, op] of Object.entries(other.ops)) {
      if (op.kind === 'referral' && (id !== op.id || this.validOp(op))) throw new Error('推广奖励记录无效');
      const cold = archived.ops?.[id], old = this.data.ops[id] || cold;
      if (!old) this.data.ops[id] = clone(op);
      else if (op.kind === 'referral' && old.kind === 'referral') { const winner = chooseReferral(old, op); if (this.data.ops[id] || JSON.stringify(winner) !== JSON.stringify(cold)) this.data.ops[id] = clone(winner); }
    }
    Object.assign(this.data.participants, other.participants);
    this.data.seaweedHour = Math.max(this.data.seaweedHour ?? Math.floor(this.data.tick / HOUR), other.seaweedHour ?? Math.floor(other.tick / HOUR));
    const competingBirths = [];
    for (const [id, record] of Object.entries(other.breeding || {})) {
      const previous = this.data.breeding[id] || archived.breeding?.[id];
      if (previous?.status === 'born' && record.status === 'born' && previous.baby.created !== record.baby.created) competingBirths.push(id);
    }
    mergeBreeding(this, other, archived.breeding);
    for (const [id, record] of Object.entries(other.travel || {})) this.data.travel[id] = mergeTravel(this.data.travel[id], record);
    for (const message of Object.values(other.chats || {})) { const result = this.addChat(message); if (!result.ok) throw new Error(result.error); }
    for (const [id, message] of Object.entries(other.chatSources || {})) {
      if (id !== message.id || !validChatMessage(message)) throw new Error('聊天沉积来源无效');
      if (this.data.chatSources[id] && JSON.stringify(this.data.chatSources[id]) !== JSON.stringify(message)) throw new Error('已有聊天沉积来源不可覆盖');
      this.data.chatSources[id] = clone(message);
    }
    const birthRecords = Object.fromEntries(competingBirths.map(id => [id, this.data.breeding[id] || archived.breeding?.[id]]));
    const reconcilePath = competingBirths.length ? cell => canonicalBirthPath(cell, birthRecords) : cell => cell;
    for (const [id, c] of Object.entries(other.chars)) {
      const cold = archived.chars?.[id], previous = this.data.chars[id] || cold;
      const old = previous && reconcilePath(previous), next = reconcilePath(c);
      const chosen = old ? chooseClaim(old, next) : next;
      if (!this.data.chars[id] && cold && JSON.stringify(chosen) === JSON.stringify(cold)) continue;
      this.data.chars[id] = clone(chosen);
      const grace = [old?.ecoGraceAt, c.ecoGraceAt].filter(Number.isFinite);
      if (grace.length) this.data.chars[id].ecoGraceAt = Math.min(...grace);
    }
    if (competingBirths.length) for (const [id, c] of Object.entries(this.data.chars)) if (!Object.hasOwn(other.chars, id)) this.data.chars[id] = reconcilePath(c);
    const birthOf = id => id.startsWith('born:') ? this.data.breeding[id.slice(5)] || archived.breeding?.[id.slice(5)] : undefined;
    for (const [id, fish] of Object.entries(this.data.fishes)) this.data.fishes[id] = canonicalBirthFish(fish, birthOf(id));
    for (const type of ['fishes', 'scenes']) for (const [id, incoming] of Object.entries(other[type])) {
      const obj = type === 'fishes' ? canonicalBirthFish(incoming, birthOf(id)) : incoming, old = this.data[type][id];
      if (!old || (obj.posAt || 0) > (old.posAt || 0) || ((obj.posAt || 0) === (old.posAt || 0) && JSON.stringify(obj).localeCompare(JSON.stringify(old)) > 0)) this.data[type][id] = clone(obj);
    }
    const dependencies = archiveDependencies({ ...this.data, ops: { ...archived.ops, ...this.data.ops }, breeding: { ...archived.breeding, ...this.data.breeding } });
    for (const field of ['ops', 'breeding']) for (const [id, record] of Object.entries(archived[field] || {})) {
      const current = this.data[field][id], keep = dependencies[field].has(id);
      if (keep && !current) {
        const next = clone(record);
        if (field === 'breeding') writeBreedingRecord(this.data.breeding, id, next);
        else this.data[field][id] = next;
      } else if (!keep && JSON.stringify(current) === JSON.stringify(record)) delete this.data[field][id];
    }
    this.data.legends = mergeLegends(this.data.legends, other.legends, Math.max(this.data.tick, other.tick));
    settleLegendary(this, Math.max(this.data.tick, other.tick), transition);
    normalizeBirthCells(this); const groups = this.fishGroups();
    const latestFeed = new Map(this.archives?.summary.lastMeals || []); for (const c of Object.values(this.data.chars)) for (const r of c.path) if (r.reason === 'eat') latestFeed.set(r.target, Math.max(latestFeed.get(r.target) || 0, r.t));
    for (const id of Object.keys(this.data.fishes)) {
      const f = this.data.fishes[id], cs = groups.get(id) || []; if (!cs.length) { delete this.data.fishes[id]; continue; }
      let fed = Math.max(f.created, latestFeed.get(id) || 0);
      f.lastFed = fed; f.hungerAt = Math.max(f.hungerAt, fed + CONFIG.hunger);
      const mealAt = lastMealAt(f, latestFeed.get(id)); if (mealAt !== undefined) f.lastMealAt = mealAt;
      if (cs.length === 1) { const c = cs[0], p = cellPosition(f, c); transition(c, { kind: 'food', entity: '', x: wrapX(p.x), y: p.y, born: Math.max(this.data.tick, other.tick), fall: 0 }, { id: `normalize:${id}`, t: Math.max(this.data.tick, other.tick), reason: 'shed' }); delete this.data.fishes[id]; }
    }
    for (const id of Object.keys(this.data.scenes)) if (!this.sceneCells(id).length) delete this.data.scenes[id];
    for (const [id, message] of Object.entries(this.data.chatSources)) if (message.body.roots.some(root => this.data.roots[root] !== undefined)) {
      delete this.data.chatSources[id]; for (const [cellId, c] of Object.entries(this.data.chars)) if (c.chat === id) delete this.data.chars[cellId];
    }
    if (!this.sceneCells(CHAT_FLOOR).length) delete this.data.scenes[CHAT_FLOOR];
    this.data.pendingChatGlyphs = Math.max(0, Object.values(this.data.chatSources).reduce((sum, message) => sum + chatGlyphs(message.body.text).length, 0) - Object.values(this.data.chars).filter(c => c.chat).length);
    this.data.tick = Math.max(this.data.tick, other.tick);
    this.data.ecology = mergeEcology(this.data.ecology, other.ecology);
    this.data.archives = mergeArchiveState(this.data.archives, other.archives);
    this.data.life = mergeLife(this.data.life, other.life, this.data);
    this.data.bubbles = mergeBubbles(this.data.bubbles, other.bubbles, this.data.tick, this.data.chars); this.data.bubbleMinute = Math.max(this.data.bubbleMinute ?? Math.floor(this.data.tick / MINUTE), other.bubbleMinute ?? Math.floor(other.tick / MINUTE));
    normalizeBreeding(this, this.data.tick); this.foodRevision++; this.dirty = true;
  }
  counts() { const chars = Object.values(this.data.chars); return { fish: Object.keys(this.data.fishes).length, scene: sceneryCount(this.data), food: chars.filter(c => c.kind === 'food' && this.data.tick - c.born < CONFIG.foodLife).length, characters: chars.filter(c => c.kind !== 'burn').length }; }
  resolveLegends(now) { worldEdited(this); processLegends(this, now, transition); }
}
