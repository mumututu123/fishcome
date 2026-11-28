import { BodyLayout, fitsHull, fitsHullAt, sweepsHull, sweepsHullAt } from './motion-hull.js';
import { MovementGrid, foreignOwner } from './movement-grid.js';
import { CHAT_FLOOR, validChatMessage, buildChatFloor, chatGlyphs } from './chat.js';
import { applyInputRows, subscribeSimulationChanges, worldEdited, worldRevision } from './simulation-changes.js';
import { shanghaiDay, mealIndex, fishStatus, mergeTravel, feedingStatus, lastMealAt } from './fish-status.js';
import { HOUR, updateSeaweed } from './seaweed.js';
import { MINUTE, updateBubbles, mergeBubbles } from './bubbles.js';
import { initialLife, initialSources, validInitialOp } from './genesis.js';
import { fishNameError } from './fish-profile.js';
import { newEcology, updateEcology, validEcology, mergeEcology } from './ecology.js';
import { emptyArchiveState, mergeArchiveState, operationValue, archiveDependencies } from './archive.js';
import { LIFE, newLife, lifeContext, updateLife, idleMotion, swimPattern, spawnPlankton, recordStory, withStoryBatch, mergeLife, validateLife, freshPlankton } from './life.js';
import { REFERRAL_REWARD, referralError, chooseReferral } from './referral.js';
import { WORLD_WIDTH, MAX_FLOOR, wrapX, worldKey, deltaX, nearX, makeTerrain, terrainOf, validTerrain, chooseTerrain, floorAt, waterAt } from './geography.js';
import { canonicalBirthFish, canonicalBirthPath, fishOrigin, activeBreeding, finishBreeding, updateContacts, motionOrder, motionUnits, commitUnit, mergeBreeding, normalizeBreeding, normalizeBirthCells, writeBreedingRecord } from './breeding.js';
import { newLegends, processLegends, capturedFishIds, retargetCapture, mergeLegends, settleLegendary, validLegends, legendSchedule } from './legends.js';
import { POPULATION, newPopulation, updatePopulation, mergePopulation, populationScenery, validPopulation, validRocks, mergeRocks, illnessOf, cureFish, killFish } from './population.js';
import { cancelBreeding } from './breeding.js';
export const CONFIG = Object.freeze({ width: WORLD_WIDTH, depth: MAX_FLOOR + 1, shallow: 60, sightShallow: 20, sightDeep: 10, step: 500, speed: 2, foodLife: 300000, hunger: 86400000, initial: 20, offlineLife: 240 * 60 * 60 * 1000 });
export const MONUMENT = { x: 610, y: CONFIG.depth - 5, rows: ['  ____  ', ' /记忆\\ ', ' | 口 | ', ' |____| ', '________'] };
// The fixed monument provides one memory entrance, separate from scenery entities.
export const sceneryCount = data => Object.keys(data.scenes).filter(id => data.ops[id]?.kind === 'scene').length + 1;
export const EYES = new Set(['0', 'O', 'o', '。', '.', '口']);
export const NEIGHBORS = [-1, 0, 1].flatMap(x => [-1, 0, 1].map(y => [x, y])).filter(([x, y]) => x || y);
const AVOID_DIRECTIONS = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const MOVES = 1, TURNS = 2;
const DIAGONAL_SWIM = Math.hypot(1, 1);
export function validateLifeAndLegends(data, sources, latest) {
  if (!validateLife(data.life, sources, latest)) throw new Error('鱼生记录无效');
  if (!validLegends(data.legends, sources, latest)) throw new Error('稀有异象记录无效');
}
export const clone = value => structuredClone(value);
// The usual swimmer and relationship rows contain only scalars. Copy each
// once. Nested ancestry and extension records still get a full detached copy.
function detachReplicaRecord(row) {
  if (!row || Object.getPrototypeOf(row) !== Object.prototype) return clone(row);
  const copy = { ...row };
  for (const field in copy) {
    const value = copy[field], type = typeof value;
    if ((value !== null && type === 'object') || type === 'function' || type === 'symbol') return clone(row);
  }
  return copy;
}
export function detachReplicaRows(rows) {
  const result = { ...rows };
  for (const id of Object.keys(result)) result[id] = detachReplicaRecord(result[id]);
  return result;
}
export function replicaSourceTable(current, incoming, archived) {
  // Creation records are seldom added during a swim. Validators only read
  // this table, so a full dictionary is needed only for an actual overlay.
  for (const changes of [incoming, archived]) for (const key in changes) {
    if (Object.hasOwn(changes, key)) return { ...archived, ...current, ...incoming };
  }
  return current || {};
}
export const key = worldKey;
const localKey = (x, y) => `${x},${y}`;
// Replica validators look up these rows by ID, in newest-to-oldest order.
export function replicaSourceRows(...tables) {
  const sources = tables.filter(Boolean);
  return new Proxy({}, {
    get(_, id) {
      for (const table of sources) if (Object.hasOwn(table, id)) return table[id];
      return Object.prototype[id];
    }
  });
}
export const ordinal = (a, b) => a === b ? 0 : a > b ? 1 : -1;
export function hash(text, n = 2166136261) { for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619); return n >>> 0; }
export function validGlyph(ch) { return typeof ch === 'string' && Array.from(ch).length === 1 && !/\s/u.test(ch) && (/^[\x21-\x7e]$/.test(ch) || /\p{Script=Han}/u.test(ch) || /^[\u3001-\u303f\uff01-\uff65]$/u.test(ch)); }
export function bounds(cells) {
  if (!cells.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of cells) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
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
function lossContour(cells, hull) {
  if (!hull) return exteriorContour(cells);
  // Coordinates fix the contour, but each swimmer's glyph IDs decide the loss.
  if (!hull.lossRim) {
    const points = cells.map(({ x, y }, index) => ({ x, y, index }));
    hull.lossRim = exteriorContour(points).map(p => p.index);
    hull.connectedLoss = new Uint8Array(cells.length);
  }
  return hull.lossRim.map(i => cells[i]);
}
function survivingFragment(cells, removed, event, hull) {
  const index = cells.indexOf(removed);
  if (hull?.connectedLoss?.[index]) return;
  const remaining = cells.filter(c => c !== removed), parts = components(remaining);
  if (parts.length === 1 && parts[0].length === remaining.length && remaining.length >= 2) {
    if (hull?.connectedLoss) hull.connectedLoss[index] = 1;
    return;
  }
  parts.sort((a, b) => b.length - a.length || hash(`${event}:${a.map(c => c.id).sort()[0]}`) - hash(`${event}:${b.map(c => c.id).sort()[0]}`));
  return new Set(parts[0]?.length >= 2 ? parts[0].map(c => c.id) : []);
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
function noteMagmaContact(magma, victims, groups, f, cells, pair, x, y, facing) {
  if (!pair) {
    for (const cell of cells) if (magma.has(key(x + facing * cell.x, y + cell.y))) victims.add(f.id);
    return;
  }
  for (const [index, member] of pair.members.entries()) {
    const offset = pair.offsets[index];
    const memberX = wrapX(x + facing * offset.x), memberY = y + offset.y, memberFacing = facing * offset.facing;
    for (const cell of groups.get(member.id) || []) if (magma.has(key(memberX + memberFacing * cell.x, memberY + cell.y))) victims.add(member.id);
  }
}
function positionFits(hull, x, y, facing, grid, slot, legacy) {
  if (!legacy) return fitsHullAt(hull, x, y, facing, grid, slot);
  const { world, id, cells, scenery, foodPositions } = legacy;
  return world.canOccupy({ id, x, y, facing }, cells, scenery, grid, foodPositions, hull);
}
function canFlip(hull, x, y, facing, grid, slot, legacy) {
  if (!legacy) return sweepsHullAt(hull, x, y, facing, grid, slot);
  const { world, id, cells, turningObstacles, center } = legacy;
  return world.turn({ id, x, y, facing }, cells, turningObstacles, grid, center, hull);
}
function probeDirection(hull, grid, slot, legacy, x, y, facing, turnX, dx, dy) {
  const turns = dx && dx !== facing && canFlip(hull, x, y, facing, grid, slot, legacy);
  const moves = positionFits(hull, (turns ? turnX : x) + dx, y + dy, turns ? -facing : facing, grid, slot, legacy);
  return (turns ? TURNS : 0) | (moves ? MOVES : 0);
}
// Hungry swimmers sharing a creation-time offset turn over their intentions
// together. Eating or changing a fish replaces the roster supplied by the grid.
function planFreeSwimming(grid, singles, now) {
  let plan = grid.intentPlan;
  if (!plan || plan.singles !== singles || now < plan.last || now >= plan.fedDeadline) {
    const byResidue = new Map();
    plan = grid.intentPlan = { singles, last: now, fedDeadline: Infinity, next: -Infinity, buckets: [] };
    for (const entry of singles) {
      const swimmer = entry[3], fish = swimmer?.fish;
      if (!fish) continue;
      swimmer.intended = undefined;
      if (!Number.isSafeInteger(fish.created) || !Number.isSafeInteger(now - fish.created) || !Number.isFinite(fish.lastFed)) continue;
      if (now - fish.lastFed < CONFIG.hunger) {
        plan.fedDeadline = Math.min(plan.fedDeadline, fish.lastFed + CONFIG.hunger);
        continue;
      }
      const residue = ((fish.created % LIFE.wanderPeriod) + LIFE.wanderPeriod) % LIFE.wanderPeriod;
      let bucket = byResidue.get(residue);
      if (!bucket) {
        bucket = { swimmers: [], due: -Infinity, residue };
        byResidue.set(residue, bucket);
        plan.buckets.push(bucket);
      }
      bucket.swimmers.push(swimmer);
    }
  }
  if (now >= plan.next) {
    plan.next = Infinity;
    for (const bucket of plan.buckets) {
      if (now >= bucket.due) {
        for (const swimmer of bucket.swimmers) swimmer.intended = swimPattern(swimmer.fish, now);
        bucket.due = (Math.floor((now - bucket.residue) / LIFE.wanderPeriod) + 1) * LIFE.wanderPeriod + bucket.residue;
      }
      plan.next = Math.min(plan.next, bucket.due);
    }
  }
  plan.last = now;
}
function chooseDirection(world, id, fish, cells, pair, center, now, ambient, bins, canEat) {
  const found = bins?.size && (pair ? pair.members.some(member => canEat(member.id)) : canEat(id)) ? new Map() : null;
  if (found) for (const eye of cells) if (EYES.has(eye.ch)) {
    const p = cellPosition(fish, eye), r = sightRadius(p.y), binWidth = CONFIG.width / 10;
    for (let bx = Math.floor((p.x - r) / 10); bx <= Math.floor((p.x + r) / 10); bx++) for (let by = Math.floor((p.y - r) / 10); by <= Math.floor((p.y + r) / 10); by++) {
      for (const food of bins.get(key((bx % binWidth + binWidth) % binWidth, by)) || []) if (Math.max(Math.abs(deltaX(food.x, p.x)), Math.abs(food.y - p.y)) <= r) found.set(food.id, food);
    }
  }
  const visible = found?.size ? [...found.values()] : null;
  const midX = fish.x + fish.facing * (center.minX + center.maxX) / 2, midY = fish.y + (center.minY + center.maxY) / 2;
  if (visible) {
    const needsRemedy = visible.length > 1 && (pair ? pair.members.some(member => illnessOf(world.data, member.id)) : illnessOf(world.data, id));
    visible.sort((a, b) => (needsRemedy ? Number(b.ch === POPULATION.remedy) - Number(a.ch === POPULATION.remedy) : 0) || (Math.abs(deltaX(a.x, midX)) + Math.abs(a.y - midY)) - (Math.abs(deltaX(b.x, midX)) + Math.abs(b.y - midY)) || a.id.localeCompare(b.id));
    return { dx: Math.sign(deltaX(visible[0].x, midX)), dy: Math.sign(visible[0].y - midY) };
  }
  if (ambient) return idleMotion(world, fish, now, ambient, { x: midX, y: midY });
  const phase = Math.floor((now - fish.created) / LIFE.wanderPeriod), r = hash(`${id}:${phase}`);
  return { dx: r % 3 - 1, dy: Math.floor(r / 3) % 3 - 1 };
}
function ownersAt(occupants, x, y) {
  return occupants instanceof MovementGrid ? occupants.get(x, y) : occupants.get(key(x, y));
}
function groupFishCell(groups, cell) {
  const body = groups.get(cell.entity);
  if (body) body.push(cell); else groups.set(cell.entity, [cell]);
}
const replicaCellIndexes = new WeakMap();
subscribeSimulationChanges((world, patch, origin) => {
  if (!patch && origin === 'archive') return;
  if (!patch || patch.tables?.chars || patch.tables?.breeding || patch.tables?.fishes || patch.values?.tick !== undefined) replicaCellIndexes.delete(world);
});
function indexReplicaCells(world, changedChars) {
  const bodies = new Map(), occupiedScenes = new Map(), latestFeed = new Map(world.archives?.summary.lastMeals || []);
  let chatGlyphCount = 0;
  for (const cell of world.charValues()) {
    if (cell.kind === 'fish') {
      if (cell.path.at(-1)?.reason === 'birth') {
        normalizeBirthCells(world, [cell]);
        changedChars?.add(cell.id);
      }
      const body = bodies.get(cell.entity);
      // Keep the glyph itself only when it is the entire body.
      bodies.set(cell.entity, typeof body === 'number' ? body + 1 : body ? 2 : cell);
    }
    if (cell.kind === 'scene') occupiedScenes.set(cell.entity, (occupiedScenes.get(cell.entity) || 0) + 1);
    if (cell.chat) chatGlyphCount++;
    for (const event of cell.path) if (event.reason === 'eat') latestFeed.set(event.target, Math.max(latestFeed.get(event.target) || 0, event.t));
  }
  return { bodies, occupiedScenes, latestFeed, chatGlyphCount };
}
function updateReplicaCellIndex(previous, next, index) {
  if (previous !== next && (previous?.path.length || next.path.length)) {
    const meals = path => path.filter(event => event.reason === 'eat');
    const before = meals(previous?.path ?? []), after = meals(next.path);
    if (before.length !== after.length || before.some((event, i) => event.target !== after[i].target || event.t !== after[i].t)) return false;
  }
  if (next.kind === 'fish') {
    if (previous?.kind !== next.kind || previous.entity !== next.entity ||
        typeof index.bodies.get(next.entity) !== 'number' || next.path.at(-1)?.reason === 'birth') return false;
  } else if (previous?.kind === 'fish') {
    const body = index.bodies.get(previous.entity);
    if (body === undefined) return false;
    if (typeof body === 'number' && body > 1) index.bodies.set(previous.entity, body - 1);
    else index.bodies.delete(previous.entity);
    index.posed.add(previous.entity);
  }
  const oldScene = previous?.kind === 'scene' ? previous.entity : undefined;
  const nextScene = next.kind === 'scene' ? next.entity : undefined;
  if (oldScene !== nextScene) {
    const scenes = index.occupiedScenes;
    if (oldScene !== undefined) {
      const remaining = scenes.get(oldScene) - 1;
      if (remaining) scenes.set(oldScene, remaining); else scenes.delete(oldScene);
    }
    if (nextScene !== undefined) scenes.set(nextScene, (scenes.get(nextScene) || 0) + 1);
  }
  index.chatGlyphCount += Number(!!next.chat) - Number(!!previous?.chat);
  return true;
}
// These memberships and meal claims change when a character changes owner or
// history. Swimming moves the fish anchor and leaves this index intact.
export function indexEcologyCharacters(cells, knownBodies, knownMeals) {
  const groups = knownBodies ?? new Map(), sceneCells = [], looseFood = [], seaweed = [];
  const { pastMeals, pastGrass, latestMeals } = knownMeals ?? { pastMeals: new Set(), pastGrass: new Set(), latestMeals: new Map() };
  for (const cell of cells) {
    if (cell.kind === 'fish') { if (!knownBodies) groupFishCell(groups, cell); }
    else if (cell.kind === 'scene') sceneCells.push(cell);
    else if (cell.kind === 'food') looseFood.push(cell);
    else if (cell.kind === 'seaweed') seaweed.push(cell);
    if (!knownMeals) for (const event of cell.path) if (event.reason === 'eat') {
      pastMeals.add(event.target);
      if (cell.wild) pastGrass.add(event.target);
      if (Number.isFinite(event.t)) latestMeals.set(event.target, Math.max(latestMeals.get(event.target) ?? -Infinity, event.t));
    }
  }
  return { groups, sceneCells, looseFood, seaweed, pastMeals, pastGrass, latestMeals };
}
function indexSceneCell(map, scenes, cell) {
  const scene = scenes[cell.entity];
  if (scene) map.set(key(scene.x + cell.x, scene.y + cell.y), { scene, cell });
}
export function velocities(cells, b = bounds(cells)) { return { x: CONFIG.speed * b.width / Math.max(1, cells.length), y: CONFIG.speed * b.height / Math.max(1, cells.length) }; }
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
  const deadA = a.path?.some(e => ['ecoDeath', 'ecoDissolve'].includes(e.reason)), deadB = b.path?.some(e => ['ecoDeath', 'ecoDissolve'].includes(e.reason));
  if (deadA !== deadB) return deadA ? a : b;
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

export function validateOperation(op, roots) {
  if (op?.genesis !== undefined && !validInitialOp(op, initialSources(roots))) return '初始鱼记录被修改或无效';
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

export class World {
  constructor(now = Date.now(), id = crypto.randomUUID(), { populate = true, ambient = true } = {}) {
    this.data = { protocol: 1, roots: { [id]: now }, terrain: makeTerrain(id, now), tick: now, seaweedHour: Math.floor(now / HOUR), bubbleMinute: Math.floor(now / MINUTE), bubbles: {}, chars: {}, fishes: {}, breeding: {}, contacts: {}, contactAt: now, scenes: {}, ops: {}, participants: {}, notices: [], chats: {}, chatSources: {}, pendingChatGlyphs: 0, travel: {} };
    this.data.life = newLife(now);
    this.data.legends = newLegends(now);
    this.data.ecology = newEcology(now);
    this.data.population = newPopulation(now); this.data.rocks = {};
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
  readFish(id) { return this.data.fishes[id]; }
  fishValues() { return this.stableFishRoster?.() ?? Object.values(this.data.fishes); }
  initializeTracking(now = Date.now()) {
    this.data.travel ||= {};
    const roster = this.stableFishRoster?.();
    if (roster && roster === this.trackedRoster) return;
    for (const fish of roster ?? this.fishValues()) this.data.travel[fish.id] ||= { since: Math.max(fish.created, now), days: {} };
    this.trackedRoster = roster;
  }
  applyMealClaims(claims) {
    const roster = this.stableFishRoster?.();
    const edits = this.mealEdits;
    const current = roster && this.appliedClaims === claims && this.fedRoster === roster;
    if (current && !edits?.size) return;
    const archived = this.archives?.summary.lastMeals;
    const apply = fish => {
      const recorded = Math.max(claims.get(fish.id) ?? -Infinity, archived?.get(fish.id) ?? -Infinity);
      const at = lastMealAt(fish, recorded);
      if (at !== undefined && fish.lastMealAt !== at) fish.lastMealAt = at;
    };
    if (current) {
      for (const id of edits) if (this.data.fishes[id]) apply(this.data.fishes[id]);
    } else for (const fish of roster ?? this.fishValues()) apply(fish);
    edits?.clear();
    if (roster) this.appliedClaims = claims;
    this.fedRoster = roster;
  }
  recordMovement(id, distance, now, day) {
    if (!Number.isFinite(distance) || !(distance > 0) || !this.data.fishes[id]) return;
    day ??= shanghaiDay(now);
    const record = this.data.travel[id] ||= { since: now, days: {} };
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
    for (const r of Object.values(this.data.rocks || {})) occupied.add(key(r.x, r.y));
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
  // Simulation callers iterate this snapshot of row references without mutating the array.
  charValues(...kinds) {
    const cells = Object.values(this.data.chars);
    return kinds[0] === undefined ? cells : cells.filter(cell => kinds.includes(cell.kind));
  }
  fishCells(id) { return this.charValues('fish').filter(c => c.entity === id); }
  sceneCells(id) { return this.charValues('scene').filter(c => c.entity === id); }
  fishGroups() { const map = new Map(); for (const c of this.charValues('fish')) groupFishCell(map, c); return map; }
  ecologyCharacters() { return indexEcologyCharacters(this.charValues()); }
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
  sceneryMap(natural = true) {
    const map = new Map();
    for (const c of this.charValues('scene')) indexSceneCell(map, this.data.scenes, c);
    return natural ? populationScenery(this.data, map) : map;
  }
  fishMap(groups = this.fishGroups()) { const map = new Map(); for (const [id, cells] of groups) { const f = this.data.fishes[id]; if (f) for (const c of cells) { const p = cellPosition(f, c); map.set(key(p.x, p.y), id); } } return map; }
  fishOccupants(groups = this.fishGroups()) { const map = new Map(); for (const [id, cells] of groups) { const fish = this.data.fishes[id]; if (!fish) continue; for (const cell of cells) { const p = cellPosition(fish, cell), k = key(p.x, p.y); if (!map.has(k)) map.set(k, new Set()); map.get(k).add(id); } } return map; }
  bodyLayout(groups) { return new BodyLayout(groups); }
  movementGrid(groups) {
    const cached = this.movingPopulation;
    if (cached && cached.groups === groups && cached.version === this.poseRevision()) return cached.grid;
    const layout = this.bodyLayout(groups);
    if (cached && this.poseEdits) {
      const bodies = cached.groups === groups ? [] : this.bodyEdits(cached.groups, groups)?.ids, poses = this.poseEdits();
      if (bodies && poses && cached.grid.reconcile(this, layout, bodies, poses)) {
        this.retainMovementGrid(groups, cached.grid);
        return cached.grid;
      }
    }
    const grid = new MovementGrid(layout);
    for (const [id, body] of groups) if (this.data.fishes[id]) grid.update(this.data.fishes[id], body);
    this.retainMovementGrid(groups, grid);
    return grid;
  }
  retainMovementGrid(groups, grid) {
    if (!this.poseRevision) return;
    // Overlapping owners must be enumerated in body-table order at every new step.
    this.clearPoseEdits?.();
    this.movingPopulation = grid.overlapped ? null : { groups, grid, version: this.poseRevision() };
  }
  canOccupy(f, cells, scenery = this.sceneryMap(), occupants = this.fishOccupants(), blocked, hull) {
    if (hull) return fitsHull(hull, f, occupants, this.data.breeding[f.id]);
    const seen = new Set(), pair = this.data.breeding[f.id];
    for (const cell of cells) {
      const { x, y } = cellPosition(f, cell), k = key(x, y);
      if (!this.waterAt(x, y) || scenery.has(k) || blocked?.has(k) || seen.has(k)) return false;
      seen.add(k);
      if (foreignOwner(ownersAt(occupants, x, y), f.id, pair)) return false;
    }
    return true;
  }
  updateFishOccupants(occupants, members, groups, remove = false) { for (const fish of members) for (const cell of groups.get(fish.id) || []) { const p = cellPosition(fish, cell), k = key(p.x, p.y); if (remove) { occupants.get(k)?.delete(fish.id); if (!occupants.get(k)?.size) occupants.delete(k); } else { if (!occupants.has(k)) occupants.set(k, new Set()); occupants.get(k).add(fish.id); } } }
  separateFish(now = this.data.tick) {
    normalizeBreeding(this, now);
    // A takeover normally receives an already placed world. One bit per water
    // cell proves separation without constructing a Set for every body cell.
    const occupied = new Uint8Array(Math.ceil(CONFIG.width * CONFIG.depth / 8));
    const rocks = new Set(Object.values(this.data.rocks || {}).map(r => key(r.x, r.y)));
    let conflict = false;
    for (const id in this.data.chars) {
      const cell = this.data.chars[id];
      if (cell.kind !== 'fish') continue;
      const fish = this.data.fishes[cell.entity];
      if (!fish) continue;
      const { x, y } = cellPosition(fish, cell), column = wrapX(x);
      if (!Number.isInteger(column) || !Number.isInteger(y) || !this.waterAt(column, y) || rocks.has(key(column, y))) { conflict = true; break; }
      const index = y * CONFIG.width + column, byte = Math.floor(index / 8), bit = 1 << (index % 8);
      if (occupied[byte] & bit) { conflict = true; break; }
      occupied[byte] |= bit;
    }
    if (!conflict) return { moved: 0, waiting: 0 };
    const groups = this.fishGroups(), occupants = this.fishOccupants(groups), scenery = this.sceneryMap(), resources = new Set(Object.values(this.data.chars).filter(c => ['food', 'seaweed'].includes(c.kind)).map(c => key(c.x, c.y))), processed = new Set();
    let moved = 0, waiting = 0;
    for (const unit of motionUnits(this, groups)) {
      const { fish, cells, members } = unit;
      const overlaps = cells.some(cell => { const p = cellPosition(fish, cell); return !this.waterAt(p.x, p.y) || rocks.has(key(p.x, p.y)) || [...(occupants.get(key(p.x, p.y)) || [])].some(id => processed.has(id)); });
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
    for (const r of Object.values(this.data.rocks || {})) occupied.add(key(r.x, r.y));
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
  validOp(op) { return validateOperation(op, this.data.roots); }
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
  step(now, swims) {
    return withStoryBatch(this, () => this.#advanceEcology(now, swims));
  }
  #advanceEcology(now, swims) {
    this.initializeTracking(now);
    // Only an unchanged body can replay its confirmed path from the preceding frame.
    const changedBodies = swims && capturedFishIds(this.data, this.data.tick), paths = [];
    const changeCell = swims ? (cell, next, record) => {
      if (cell.kind === 'fish') changedBodies.add(cell.entity);
      if (next.kind === 'fish') changedBodies.add(next.entity);
      transition(cell, next, record);
    } : transition;
    processLegends(this, now, changeCell);
    updatePopulation(this, now, changeCell);
    finishBreeding(this, now, changeCell);
    if (this.ambient) updateEcology(this, now, changeCell);
    updateSeaweed(this, now, CONFIG, this.monument, hash, changeCell);
    updateBubbles(this, now);
    if (this.ambient) spawnPlankton(this, now);
    const dt = Math.min(1, Math.max(0, (now - this.data.tick) / 1000)); this.data.tick = now;
    const magma = new Set(Object.values(this.data.population.eruption?.particles || {}).filter(c => now < c.born + POPULATION.cooling).map(c => key(c.x, c.y))), magmaVictims = new Set();
    const { groups, sceneCells, looseFood, seaweed, pastMeals, pastGrass, latestMeals } = this.ecologyCharacters();
    const scenery = new Map();
    for (const cell of sceneCells) indexSceneCell(scenery, this.data.scenes, cell);
    populationScenery(this.data, scenery);
    const fishOccupancy = this.movementGrid(groups), captured = capturedFishIds(this.data, now);
    this.applyMealClaims(latestMeals);
    const canEat = id => !!this.data.fishes[id] && !captured.has(id) && feedingStatus(this.data.fishes[id], now).canEat;
    const ambient = this.ambient ? lifeContext(this, now, scenery, groups, fishOccupancy.layout) : null; if (ambient) updateLife(this, now, ambient);
    for (const c of looseFood) if (freshPlankton(c) && now - c.born >= LIFE.planktonLife) { transition(c, { kind: 'burn', entity: '' }, { id: `dissolve:${c.id}`, t: c.born + LIFE.planktonLife, reason: 'dissolve' }); this.dirty = true; }
    const foods = looseFood.filter(c => c.kind === 'food').sort((a, b) => a.born - b.born || a.id.localeCompare(b.id));
    const foodCount = new Map(); for (const c of foods) foodCount.set(key(c.x, c.y), (foodCount.get(key(c.x, c.y)) || 0) + 1);
    const contact = food => {
      const at = key(food.x, food.y);
      if (scenery.has(at)) return [];
      const ids = new Set();
      for (const [dx, dy] of NEIGHBORS) {
        for (const id of fishOccupancy.get(food.x + dx, food.y + dy) || []) ids.add(id);
      }
      return [...ids].filter(id => !fishOccupancy.get(food.x, food.y)?.has(id) && canEat(id) && touching(this.data.fishes[id], groups.get(id), food, scenery));
    };
    for (const c of foods) {
      if (now - c.born >= CONFIG.foodLife && scenery.has(key(c.x, c.y))) {
        // Stacked food may expire in the same cell. Preserve it in the nearest free supported slot.
        let slot;
        for (let r = 1; r <= CONFIG.depth + CONFIG.width && !slot; r++) for (let dx = -r; dx <= r && !slot; dx++) {
          const dy = r - Math.abs(dx); for (const sy of dy ? [-dy, dy] : [0]) {
            const x = wrapX(c.x + dx), y = c.y + sy, k = key(x, y);
            if (this.waterAt(x, y) && !scenery.has(k) && !fishOccupancy.get(x, y) && !(foodCount.get(k) > 0) && (y === this.floorAt(x) - 1 || scenery.has(key(x, y + 1)))) { slot = [x, y]; break; }
          }
        }
        if (slot) { const old = key(c.x, c.y); foodCount.set(old, Math.max(0, foodCount.get(old) - 1)); [c.x, c.y] = slot; foodCount.set(key(c.x, c.y), 1); c.moveAt = now; }
      }
      const blocked = c.y >= this.floorAt(c.x) - 1 || scenery.has(key(c.x, c.y + 1)), eatContact = now - c.born < CONFIG.foodLife && contact(c).length;
      if (now - c.born >= CONFIG.foodLife && blocked && !fishOccupancy.get(c.x, c.y) && !scenery.has(key(c.x, c.y))) {
        const support = scenery.get(key(c.x, c.y + 1)), id = this.data.scenes[support?.scene.id] ? support.scene.id : `deposit:${c.id}:${c.path.length}`;
        if (!this.data.scenes[id]) this.data.scenes[id] = { id, actor: c.payer, nick: this.data.participants[c.payer] || '自然沉积', x: c.x, y: c.y, posAt: now, poseId: id };
        const s = this.data.scenes[id], px = c.x, py = c.y; transition(c, { kind: 'scene', entity: id, x: deltaX(c.x, s.x), y: c.y - s.y }, { id: `settle:${c.id}:${c.path.length}`, t: c.born + CONFIG.foodLife, reason: 'expire' }); this.dirty = true; scenery.set(key(px, py), { scene: s, cell: c }); continue;
      }
      c.fall = blocked || eatContact || fishOccupancy.get(c.x, c.y + 1) || (foodCount.get(key(c.x, c.y + 1)) > 0) ? 0 : (c.fall || 0) + dt * CONFIG.depth / 300;
      while (c.fall >= 1 && c.y + 1 < this.floorAt(c.x) && !scenery.has(key(c.x, c.y + 1)) && !fishOccupancy.get(c.x, c.y + 1) && !(foodCount.get(key(c.x, c.y + 1)) > 0)) { const old = key(c.x, c.y); foodCount.set(old, Math.max(0, foodCount.get(old) - 1)); c.y++; c.fall--; foodCount.set(key(c.x, c.y), (foodCount.get(key(c.x, c.y)) || 0) + 1); }
      c.moveAt = now;
    }
    const edible = [...foods.filter(c => c.kind === 'food' && now - c.born < CONFIG.foodLife), ...seaweed].sort((a, b) => (a.born ?? a.created) - (b.born ?? b.created) || a.id.localeCompare(b.id)), foodPositions = new Set([...foods.filter(c => c.kind === 'food'), ...edible].map(c => key(c.x, c.y)));
    const turningObstacles = new Map(scenery); for (const cell of edible) if (cell.kind === 'seaweed') turningObstacles.set(key(cell.x, cell.y), {});
    const waitingToEat = new Set(); for (const food of edible) for (const id of contact(food)) waitingToEat.add(id);
    const bins = new Map();
    for (const food of edible) { const bin = key(Math.floor(wrapX(food.x) / 10), Math.floor(food.y / 10)); if (!bins.has(bin)) bins.set(bin, []); bins.get(bin).push(food); }
    fishOccupancy.prepareMovement(this.data, scenery, foodPositions, seaweed);
    const layout = fishOccupancy.layout;
    const { fishes, breeding } = this.data, hasMagma = magma.size > 0;
    const avoidancePhase = Math.floor(now / 12000);
    let travelDay, starvationDue = false;
    const singles = fishOccupancy.swimmers(this, CONFIG.speed);
    const freeIntents = ambient && this.stableFishRoster;
    const nearFood = freeIntents && bins.size && fishOccupancy.ownersNear(edible, Math.max(CONFIG.sightShallow, CONFIG.sightDeep));
    if (freeIntents) planFreeSwimming(fishOccupancy, singles, now);
    const ordered = motionOrder(this, groups, layout, singles), batch = this.beginSwimBatch?.();
    const hasCaptives = captured.size > 0, hasWaiting = waitingToEat.size > 0, hasFood = bins.size > 0;
    const avoidanceText = String(avoidancePhase);
    const avoidance = AVOID_DIRECTIONS.map((_, seed) => hash(avoidanceText, seed) % AVOID_DIRECTIONS.length);
    for (let index = 0; index < ordered.length; index++) {
      const entry = ordered[index], id = entry[0], cells = entry[1], pair = entry[2], swimmer = entry[3];
      let f = pair ? pair.fish : swimmer?.fish ?? fishes[id];
      if (!starvationDue) starvationDue = pair ? pair.members.some(member => now >= member.hungerAt) : !!f && now >= f.hungerAt;
      if (!f || !cells.length || (hasCaptives && (pair ? pair.members.some(member => captured.has(member.id)) : captured.has(id)))) continue;
      const ordinal = swimmer?.ordinal;
      if (ordinal === undefined && !pair && this.movingFish) f = this.movingFish(f);
      const waiting = hasWaiting && (pair ? pair.members.some(member => waitingToEat.has(member.id)) : waitingToEat.has(id));
      const beforeX = f.x, beforeY = f.y, beforeFacing = f.facing;
      let x = beforeX, y = beforeY, facing = beforeFacing, cx = f.cx, cy = f.cy;
      let movedX = 0, movedY = 0, hull, slot;
      if (!waiting) {
        hull = swimmer ? swimmer.hull : layout.hull(cells);
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || Math.abs(facing) !== 1 || Math.abs(x) > WORLD_WIDTH * 2) hull = null;
        const center = hull?.bounds || bounds(cells);
        slot = hull && !pair && breeding[id]?.status !== 'active' ? swimmer?.slot ?? fishOccupancy.slots.get(id) : undefined;
        const legacy = slot === undefined ? { world: this, id, cells, scenery, foodPositions, turningObstacles, center } : null;
        const visibleBins = hasFood && (!nearFood || swimmer?.slot === undefined || nearFood[swimmer.slot]) ? bins : null;
        const intended = !visibleBins && freeIntents && now - f.lastFed >= CONFIG.hunger && swimmer?.intended ||
          chooseDirection(this, id, f, cells, pair, center, now, ambient, visibleBins, canEat);
        let dx = intended.dx, dy = intended.dy;
        if (pair) for (const member of pair.members) fishOccupancy.update(member, groups.get(member.id) || [], true);
        const turnX = beforeX + beforeFacing * (center.minX + center.maxX);
        let horizontal = -1, vertical = -1;
        if (ambient && !pair && (dx || dy)) {
          if (dx) horizontal = probeDirection(hull, fishOccupancy, slot, legacy, beforeX, beforeY, beforeFacing, turnX, dx, 0);
          if (horizontal === -1 || !(horizontal & MOVES)) {
            if (dy) vertical = probeDirection(hull, fishOccupancy, slot, legacy, beforeX, beforeY, beforeFacing, turnX, 0, dy);
            if (vertical === -1 || !(vertical & MOVES)) {
              // With four directions only the low two bits of the hash can affect the offset.
              const offset = swimmer ? avoidance[swimmer.avoidanceSeed ??= hash('avoid:' + id + ':') & 3]
                : hash('avoid:' + id + ':' + avoidanceText) % AVOID_DIRECTIONS.length;
              for (let i = 0; i < AVOID_DIRECTIONS.length; i++) {
                const direction = AVOID_DIRECTIONS[(offset + i) % AVOID_DIRECTIONS.length];
                const alongX = direction[0], alongY = direction[1];
                if (alongX && alongX === dx && horizontal !== -1 || alongY && alongY === dy && vertical !== -1) continue;
                const candidate = probeDirection(hull, fishOccupancy, slot, legacy, beforeX, beforeY, beforeFacing, turnX, alongX, alongY);
                if (!(candidate & MOVES)) continue;
                dx = alongX; dy = alongY;
                horizontal = dx ? candidate : -1;
                vertical = dy ? candidate : -1;
                break;
              }
            }
          }
        }
        if (dx && dx !== beforeFacing) {
          if (horizontal === -1 ? canFlip(hull, beforeX, beforeY, beforeFacing, fishOccupancy, slot, legacy) : horizontal & TURNS) {
            x = turnX; facing = -beforeFacing;
          }
          if (hasMagma) noteMagmaContact(magma, magmaVictims, groups, f, cells, pair, x, y, facing);
        }
        cx = dx ? Math.min(2, (cx || 0) + (hull && swimmer ? swimmer.speedX : CONFIG.speed * center.width / cells.length) * dt) : 0;
        cy = dy ? Math.min(2, (cy || 0) + (hull && swimmer ? swimmer.speedY : CONFIG.speed * center.height / cells.length) * dt) : 0;
        if (cx >= 1 && dx) {
          if (horizontal === -1 ? positionFits(hull, x + dx, y, facing, fishOccupancy, slot, legacy) : horizontal & MOVES) {
            x += dx; movedX = dx;
          }
          cx--;
        }
        if (movedX && hasMagma) noteMagmaContact(magma, magmaVictims, groups, f, cells, pair, x, y, facing);
        if (cy >= 1 && dy) {
          const moves = vertical !== -1 && x === beforeX && facing === beforeFacing ? vertical & MOVES
            : positionFits(hull, x, y + dy, facing, fishOccupancy, slot, legacy);
          if (moves) { y += dy; movedY = dy; }
          cy--;
        }
        f.y = y; f.facing = facing; f.cx = cx; f.cy = cy;
      }
      if (pair) {
        f.x = x;
        commitUnit(pair, now);
        if (!waiting) for (const member of pair.members) fishOccupancy.update(member, groups.get(member.id) || []);
      } else {
        x = wrapX(x); f.x = x; f.posAt = now;
        if (!waiting && (beforeX !== x || beforeY !== y || beforeFacing !== facing)) {
          fishOccupancy.moveFish(f, cells, beforeX, beforeY, beforeFacing, hull, slot);
          if (swims && beforeFacing === facing && (movedX || movedY)) (paths[(movedY + 1) * 3 + movedX + 1] ||= []).push(id);
        }
      }
      if (ordinal !== undefined) {
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(facing) && Number.isFinite(cx) && Number.isFinite(cy)) {
          const offset = batch.poses.length * 5;
          batch.poseIndex[ordinal] = batch.poses.push(ordinal);
          batch.motion[offset] = x;
          batch.motion[offset + 1] = y;
          batch.motion[offset + 2] = facing;
          batch.motion[offset + 3] = cx;
          batch.motion[offset + 4] = cy;
        } else this.movingFish(f);
      }
      if (waiting) continue;
      if (hasMagma) noteMagmaContact(magma, magmaVictims, groups, f, cells, pair, x, y, facing);
      if (movedX || movedY) {
        travelDay ??= shanghaiDay(now);
        const distance = movedX && movedY ? DIAGONAL_SWIM : 1;
        if (pair) for (const member of pair.members) this.recordMovement(member.id, distance, now, travelDay);
        else {
          const days = ordinal === undefined ? undefined : batch.daysByOrdinal[ordinal] ?? batch.readDays(id, ordinal);
          if (days) {
            const distanceToday = (days[travelDay] || 0) + distance;
            days[travelDay] = distanceToday;
            batch.distances[batch.travel.length] = distanceToday;
            batch.tripIndex[ordinal] = batch.travel.push(ordinal);
          } else this.recordMovement(id, distance, now, travelDay);
        }
      }
    }
    if (batch) this.completeSwimBatch(batch, travelDay);
    this.retainMovementGrid(groups, fishOccupancy);
    let bodyChanged = magmaVictims.size > 0;
    for (const id of magmaVictims) killFish(this, id, now, 'magma', changeCell, groups);
    for (const food of edible) {
      if (!['food', 'seaweed'].includes(food.kind) || !this.waterAt(food.x, food.y) || fishOccupancy.get(food.x, food.y)) continue;
      const candidates = contact(food);
      // A winner becomes ineligible for an hour, so every remaining candidate still has its pre-meal size.
      candidates.sort((a, b) => groups.get(b).length - groups.get(a).length || hash(`${food.id}:${b}`) - hash(`${food.id}:${a}`) || a.localeCompare(b));
      if (candidates.length) {
        bodyChanged = true;
        const winner = candidates[0], grass = food.kind === 'seaweed';
        const previouslyAte = (grass ? pastGrass : pastMeals).has(winner) || (grass ? this.archives?.summary.grassMeals.has(winner) : this.archives?.summary.lastMeals.has(winner));
        const id = winner, cs = groups.get(id), f = this.data.fishes[id]; fishOccupancy.add(food.x, food.y, id); changeCell(food, { kind: 'fish', entity: id, x: deltaX(food.x, f.x) * f.facing, y: food.y - f.y }, { id: `eat:${food.id}:${food.path.length}`, t: now, reason: 'eat', rank: cs.length }); cs.push(food); f.lastFed = now; f.hungerAt = now + CONFIG.hunger; this.foodRevision++; this.dirty = true;
        if (!previouslyAte) recordStory(this, grass ? 'grass' : 'meal', id, now);
        f.lastMealAt = now; pastMeals.add(id); if (grass) pastGrass.add(id);
        cureFish(this, id, food, now);
        if (food.ghost) { const s = legendSchedule(this.data.roots, food.ghost.seed, food.ghost.slot); recordStory(this, 'shipMeal', id, now, { legendary: s.id, legendSeed: s.seed, legendSlot: s.slot }); }
      }
    }
    let hungryBodies = bodyChanged ? undefined : groups, hungryLayout;
    if (starvationDue) for (const id of groups.keys()) {
      const f = this.data.fishes[id];
      if (f && now >= f.hungerAt) {
        hungryBodies ??= this.fishGroups();
        hungryLayout ??= hungryBodies === groups ? layout : this.bodyLayout(hungryBodies);
        const cells = hungryBodies.get(id);
        this.starve(id, f.hungerAt, null, { cells, hull: cells && hungryLayout.hull(cells), changeCell });
        bodyChanged = true;
      }
    }
    normalizeBreeding(this, now);
    updateContacts(this, now, bodyChanged ? this.fishGroups() : groups, scenery, captured, bodyChanged ? undefined : fishOccupancy);
    paths.forEach((ids, direction) => {
      const stable = changedBodies.size ? ids.filter(id => !changedBodies.has(id)) : ids;
      if (stable.length) swims[direction] = stable;
    });
  }
  turn(f, cells, scenery = this.sceneryMap(), occupants = this.fishOccupants(), b = bounds(cells), hull) {
    const next = { id: f.id, x: f.x + f.facing * (b.minX + b.maxX), y: f.y, facing: -f.facing };
    if (hull) {
      if (!sweepsHull(hull, f, occupants, this.data.breeding[f.id])) return false;
      f.x = next.x; f.facing = next.facing; return true;
    }
    const pair = this.data.breeding[f.id];
    for (const c of cells) { const a = cellPosition(f, c), z = cellPosition(next, c); for (let x = Math.min(a.x, z.x); x <= Math.max(a.x, z.x); x++) if (!this.waterAt(x, a.y) || scenery.has(key(x, a.y)) || foreignOwner(ownersAt(occupants, x, a.y), f.id, pair)) return false; }
    if (!this.canOccupy(next, cells, scenery, occupants)) return false; f.x = next.x; f.facing = next.facing; return true;
  }
  starve(id, at, selectedId = null, { illness = false, cells = this.fishCells(id), hull, changeCell = transition } = {}) {
    const f = this.data.fishes[id]; if (!f || cells.length < 2) return;
    const candidates = illness ? cells.filter(c => components(cells.filter(other => other !== c)).length === 1) : [];
    const rim = candidates.length ? candidates : lossContour(cells, hull);
    let removed = rim.find(c => c.id === selectedId);
    if (!removed) {
      let best = Infinity;
      const prefix = hash(`${id}:${at}:`);
      for (const cell of rim) {
        const score = hash(String(cell.id), prefix);
        if (score < best || score === best && cell.id.localeCompare(removed.id) < 0) { removed = cell; best = score; }
      }
    }
    const event = `${illness ? 'illness' : 'hunger'}:${id}:${at}`, loss = { id: event, t: at, reason: illness ? 'ecoDissolve' : 'starve', ...(illness ? { fish: id, cause: 'depression' } : {}) };
    if (illness) { const pair = this.breedingState(id); if (pair) cancelBreeding(this.data, pair, at, 'illness'); }
    changeCell(removed, { kind: 'burn', entity: '' }, loss);
    const kept = survivingFragment(cells, removed, event, hull);
    if (kept) for (const c of cells) if (c !== removed && !kept.has(c.id)) { const p = cellPosition(f, c); changeCell(c, illness ? { kind: 'burn', entity: '' } : { kind: 'food', entity: '', x: wrapX(p.x), y: p.y, born: at, fall: 0 }, illness ? loss : { id: event, t: at, reason: 'shed' }); }
    if (kept?.size === 0) { delete this.data.fishes[id]; recordStory(this, 'depart', id, at); } else if (!illness) f.hungerAt = at + CONFIG.hunger;
    this.foodRevision++; this.dirty = true;
  }
  merge(other, archived = {}, origin, trackChanges = false, checkedRules) {
    let cellIndex = origin === 'replica' ? replicaCellIndexes.get(this) : undefined;
    const changes = trackChanges ? { chars: undefined, fishes: new Set(), scenes: new Set() } : undefined;
    let changedChars = trackChanges ? new Set() : undefined;
    if (!other || other.protocol !== 1 || !other.chars || !other.fishes || !other.scenes || !other.ops) throw new Error('世界协议不兼容');
    if (other.terrain && !validTerrain(other.terrain, other.roots)) throw new Error('固定海底地形被修改或无效');
    for (const [root, at] of Object.entries(other.roots || {})) if (this.data.roots[root] !== undefined && this.data.roots[root] !== at) throw new Error('世界起源时间不能修改');
    if (!validEcology(other.ecology, Math.max(Date.now() + 60000, other.tick))) throw new Error('生态更替时钟无效');
    const sources = { roots: { ...this.data.roots, ...other.roots }, fishes: replicaSourceRows(other.fishes, this.data.fishes),
      ops: replicaSourceTable(this.data.ops, other.ops, archived.ops), breeding: replicaSourceTable(this.data.breeding, other.breeding, archived.breeding) };
    if (!validPopulation(other.population, sources, Math.max(Date.now() + 60000, other.tick)) || !validRocks(other.rocks, sources, Math.max(Date.now() + 60000, other.tick))) throw new Error('生态控制记录无效');
    const latest = Math.max(Date.now() + 60000, this.data.tick, other.tick);
    if (!checkedRules?.(this.data, other, archived, latest)) {
      sources.chars = replicaSourceRows(other.chars, this.data.chars, archived.chars);
      validateLifeAndLegends(other, sources, latest);
    }
    let initial;
    for (const op of Object.values(other.ops)) if (op.genesis !== undefined &&
      !validInitialOp(op, initial ??= initialSources(sources.roots))) throw new Error('初始鱼记录被修改或无效');
    worldEdited(this, origin, changes);
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
    const competingBirths = new Map();
    for (const [id, record] of Object.entries(other.breeding || {})) {
      const previous = this.data.breeding[id] || archived.breeding?.[id];
      if (previous?.status === 'born' && record.status === 'born' && JSON.stringify(previous.baby) !== JSON.stringify(record.baby)) competingBirths.set(id, previous);
    }
    mergeBreeding(this, other, archived.breeding);
    for (const [id, record] of Object.entries(other.travel || {})) this.data.travel[id] = mergeTravel(this.data.travel[id], record);
    for (const message of Object.values(other.chats || {})) { const result = this.addChat(message); if (!result.ok) throw new Error(result.error); }
    for (const [id, message] of Object.entries(other.chatSources || {})) {
      if (id !== message.id || !validChatMessage(message)) throw new Error('聊天沉积来源无效');
      if (this.data.chatSources[id] && JSON.stringify(this.data.chatSources[id]) !== JSON.stringify(message)) throw new Error('已有聊天沉积来源不可覆盖');
      this.data.chatSources[id] = clone(message);
    }
    const birthRecords = {}, alternatives = {};
    for (const [id, previous] of competingBirths) {
      const winner = this.data.breeding[id] || archived.breeding[id];
      birthRecords[id] = winner;
      alternatives[id] = winner === previous ? other.breeding[id] : previous;
    }
    const reconcilePath = competingBirths.size ? cell => canonicalBirthPath(cell, birthRecords, alternatives) : cell => cell;
    if (cellIndex && (cellIndex.table !== this.data.chars || cellIndex.tick !== this.data.tick || cellIndex.mealRevision !== this.archives?.mealRevision ||
        Object.values(other.breeding || {}).some(record => record.status === 'born') ||
        Object.values(archived.breeding || {}).some(record => record.status === 'born'))) cellIndex = undefined;
    for (const [id, c] of Object.entries(other.chars)) {
      const live = this.data.chars[id], cold = archived.chars?.[id], previous = live || cold;
      const old = previous && reconcilePath(previous), next = reconcilePath(c);
      const chosen = old ? chooseClaim(old, next) : next;
      if (!live && cold && JSON.stringify(chosen) === JSON.stringify(cold)) continue;
      if (cellIndex && !updateReplicaCellIndex(live, chosen, cellIndex)) cellIndex = undefined;
      // A newly visible older row or a new array-index key may change iteration order.
      if (changedChars && (live?.kind === 'burn' && chosen.kind !== 'burn' ||
        !live && String(Number(id) >>> 0) === id && Number(id) < 0xffffffff)) changedChars = undefined;
      changedChars?.add(id);
      this.data.chars[id] = clone(chosen);
      const grace = [old?.ecoGraceAt, c.ecoGraceAt].filter(Number.isFinite);
      if (grace.length) this.data.chars[id].ecoGraceAt = Math.min(...grace);
    }
    if (competingBirths.size) for (const [id, c] of Object.entries(this.data.chars)) if (!Object.hasOwn(other.chars, id)) {
      const next = reconcilePath(c);
      if (next !== c) { this.data.chars[id] = next; changedChars?.add(id); }
    }
    const birthOf = id => id.startsWith('born:') ? this.data.breeding[id.slice(5)] || archived.breeding?.[id.slice(5)] : undefined;
    // A retained cell index covers the previous normalized fish and their
    // birth certificates. Incoming fish still resolve against the current winner.
    const pendingFish = cellIndex?.posed;
    for (const id of pendingFish ?? Object.keys(this.data.fishes)) {
      if (id.startsWith('born:') && this.data.fishes[id]) this.data.fishes[id] = canonicalBirthFish(this.data.fishes[id], birthOf(id));
    }
    for (const type of ['fishes', 'scenes']) {
      const table = this.data[type], incomingRows = other[type], winners = origin === 'replica' ? undefined : {};
      for (const id in incomingRows) {
        if (!Object.hasOwn(incomingRows, id)) continue;
        const incoming = incomingRows[id];
        const obj = type === 'fishes' && id.startsWith('born:') ? canonicalBirthFish(incoming, birthOf(id)) : incoming, old = table[id];
        if (!old || (obj.posAt || 0) > (old.posAt || 0) || ((obj.posAt || 0) === (old.posAt || 0) && JSON.stringify(obj).localeCompare(JSON.stringify(old)) > 0)) {
          if (changes && (!old || old.x !== obj.x || old.y !== obj.y || old.facing !== obj.facing)) changes[type].add(id);
          if (winners) winners[id] = obj;
          else table[id] = detachReplicaRecord(obj);
          // The previous merge normalized each surviving body and its meals.
          // An unchanged index and equal inputs give the same feeding fields,
          // even when the local and remote poses came from different writers.
          if (pendingFish && type === 'fishes' && (!old || obj.created !== old.created ||
              obj.hungerAt !== old.hungerAt || obj.lastFed !== old.lastFed || obj.lastMealAt !== old.lastMealAt)) pendingFish.add(id);
        }
      }
      if (winners) Object.assign(table, clone(winners));
    }
    let dependencies;
    for (const field of ['ops', 'breeding']) for (const [id, record] of Object.entries(archived[field] || {})) {
      const current = this.data[field][id];
      if (current && JSON.stringify(current) !== JSON.stringify(record)) continue;
      dependencies ??= archiveDependencies({ ...this.data, ops: { ...archived.ops, ...this.data.ops }, breeding: { ...archived.breeding, ...this.data.breeding } });
      const keep = dependencies[field].has(id);
      if (keep && !current) {
        const next = clone(record);
        if (field === 'breeding') writeBreedingRecord(this.data.breeding, id, next);
        else this.data[field][id] = next;
      } else if (!keep && current) delete this.data[field][id];
    }
    this.data.legends = mergeLegends(this.data.legends, other.legends, Math.max(this.data.tick, other.tick));
    this.data.population = mergePopulation(this.data.population, other.population, Math.max(this.data.tick, other.tick));
    this.data.rocks = mergeRocks(this.data.rocks, other.rocks);
    settleLegendary(this, Math.max(this.data.tick, other.tick), (cell, fields, event) => {
      cellIndex = undefined;
      changedChars?.add(cell.id);
      transition(cell, fields, event);
    }, id => {
      pendingFish?.add(id);
      changes?.fishes.add(id);
    });
    // Only a surviving singleton needs its exact glyph for the food transition.
    if (cellIndex) for (const id of pendingFish) {
      if (cellIndex.bodies.get(id) === 1) { cellIndex = undefined; break; }
    }
    const normalize = cellIndex && pendingFish ? pendingFish : Object.keys(this.data.fishes);
    cellIndex ??= indexReplicaCells(this, changedChars);
    const { bodies, latestFeed, occupiedScenes } = cellIndex;
    let { chatGlyphCount } = cellIndex;
    for (const id of normalize) {
      const f = this.data.fishes[id];
      if (!f) continue;
      const body = bodies.get(id);
      if (!body) { delete this.data.fishes[id]; changes?.fishes.add(id); continue; }
      const meal = latestFeed.get(id), fed = Math.max(f.created, meal || 0);
      f.lastFed = fed; f.hungerAt = Math.max(f.hungerAt, fed + CONFIG.hunger);
      const mealAt = lastMealAt(f, meal); if (mealAt !== undefined) f.lastMealAt = mealAt;
      if (typeof body !== 'number') { const lone = body, p = cellPosition(f, lone); changedChars?.add(lone.id); transition(lone, { kind: 'food', entity: '', x: wrapX(p.x), y: p.y, born: Math.max(this.data.tick, other.tick), fall: 0 }, { id: `normalize:${id}`, t: Math.max(this.data.tick, other.tick), reason: 'shed' }); delete this.data.fishes[id]; bodies.delete(id); changes?.fishes.add(id); }
    }
    for (const id of Object.keys(this.data.scenes)) if (!occupiedScenes.has(id)) {
      delete this.data.scenes[id];
      changes?.scenes.add(id);
    }
    const localChatSources = new Set();
    for (const [id, message] of Object.entries(this.data.chatSources)) if (message.body.roots.some(root => this.data.roots[root] !== undefined)) {
      delete this.data.chatSources[id];
      localChatSources.add(id);
    }
    let occupiedChatFloor = occupiedScenes.has(CHAT_FLOOR);
    if (localChatSources.size) {
      occupiedChatFloor = false;
      for (const [id, c] of Object.entries(this.data.chars)) {
        if (localChatSources.has(c.chat)) { delete this.data.chars[id]; changedChars?.add(id); if (c.chat) chatGlyphCount--; }
        else if (c.kind === 'scene' && c.entity === CHAT_FLOOR) occupiedChatFloor = true;
      }
    }
    if (!occupiedChatFloor && Object.hasOwn(this.data.scenes, CHAT_FLOOR)) {
      delete this.data.scenes[CHAT_FLOOR];
      changes?.scenes.add(CHAT_FLOOR);
    }
    this.data.pendingChatGlyphs = Math.max(0, Object.values(this.data.chatSources).reduce((sum, message) => sum + chatGlyphs(message.body.text).length, 0) - chatGlyphCount);
    this.data.tick = Math.max(this.data.tick, other.tick);
    this.data.ecology = mergeEcology(this.data.ecology, other.ecology);
    this.data.archives = mergeArchiveState(this.data.archives, other.archives);
    this.data.life = mergeLife(this.data.life, other.life, this.data);
    for (const id of Object.keys(this.data.population.illnesses)) if (!this.data.fishes[id]) delete this.data.population.illnesses[id];
    const beforePopulation = this.foodRevision;
    updatePopulation(this, this.data.tick, transition, { resume: true });
    this.data.bubbles = mergeBubbles(this.data.bubbles, other.bubbles, this.data.tick, this.data.chars); this.data.bubbleMinute = Math.max(this.data.bubbleMinute ?? Math.floor(this.data.tick / MINUTE), other.bubbleMinute ?? Math.floor(other.tick / MINUTE));
    const retainCells = origin === 'replica' && !localChatSources.size && beforePopulation === this.foodRevision;
    if (retainCells) (cellIndex.posed ??= new Set()).clear();
    normalizeBreeding(this, this.data.tick, retainCells ? cellIndex.posed : changes?.fishes);
    if (retainCells) {
      if (changes) for (const id of cellIndex.posed) changes.fishes.add(id);
      cellIndex.table = this.data.chars;
      cellIndex.tick = this.data.tick;
      cellIndex.mealRevision = this.archives?.mealRevision;
      replicaCellIndexes.set(this, cellIndex);
    }
    if (changes && beforePopulation === this.foodRevision) changes.chars = changedChars;
    this.foodRevision++; this.dirty = true;
    return changes;
  }
  counts() { const chars = Object.values(this.data.chars); return { fish: Object.keys(this.data.fishes).length, scene: sceneryCount(this.data), food: chars.filter(c => c.kind === 'food' && this.data.tick - c.born < CONFIG.foodLife).length, characters: chars.filter(c => c.kind !== 'burn').length }; }
  resolveLegends(now) { worldEdited(this); withStoryBatch(this, () => processLegends(this, now, transition)); }
  resolvePopulation(now) { worldEdited(this); updatePopulation(this, now, transition, { resume: true }); }
}
