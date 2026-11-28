import { hash } from './world-hash.js';
import { wrapX } from './geography.js';

export const ECOLOGY = Object.freeze({ radius: 15, weedMinLife: 72 * 3600000, weedLifeRange: 48 * 3600000, looseLife: 75000, sedimentGrace: 48 * 3600000 });
export function newEcology(now, legacy = false) { return { version: 1, activated: now, legacy, hour: Math.floor(now / 3600000) }; }
export function ensureEcology(world, now, legacy = false) { return world.data.ecology ||= newEcology(now, legacy); }
export function validEcology(state, now = Date.now() + 60000) { return state === undefined || !!state && state.version === 1 && typeof state.legacy === 'boolean' && Number.isFinite(state.activated) && state.activated >= 0 && state.activated <= now && Number.isInteger(state.hour) && state.hour >= 0 && state.hour <= Math.floor(now / 3600000); }
export function mergeEcology(a, b) { if (!a) return b; if (!b) return a; return { version: 1, activated: Math.min(a.activated, b.activated), legacy: a.legacy || b.legacy, hour: Math.max(a.hour, b.hour) }; }
// A query covers at most (2r+1)² cells. A rectangle sum therefore holds both
// exact counts without a carry from its water count into its occupied count.
const densityScale = 2 ** Math.ceil(Math.log2((2 * ECOLOGY.radius + 1) ** 2 + 1));
export function densityField(world, scenery = world.sceneryMap(), occupiedByFish) {
  const width = 1000, floors = Array.from({ length: width }, (_, x) => world.floorAt(x)), height = Math.max(...floors), stride = width + 1;
  const occupied = new Uint8Array(width * height), totals = new Uint32Array(stride * (height + 1));
  const mark = (x, y) => { if (Number.isInteger(y) && y >= 0 && y < height) occupied[y * width + wrapX(x)] = 1; };
  for (const { scene, cell } of scenery.values()) mark(scene.x + cell.x, scene.y + cell.y);
  for (const c of occupiedByFish ? world.charValues('food', 'seaweed', 'scene') : world.charValues()) {
    if (['food', 'seaweed'].includes(c.kind)) mark(c.x, c.y);
    if (c.kind === 'fish') { const f = world.data.fishes[c.entity]; if (f) mark(f.x + f.facing * c.x, f.y + c.y); }
  }
  const monument = world.monument; for (const [dy, row] of monument.rows.entries()) for (const [dx, ch] of Array.from(row).entries()) if (ch !== ' ') mark(monument.x + dx, monument.y + dy);
  // Summed-area tables make every local density query constant-time, even on hourly turnover.
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      if (y < floors[x]) row += occupied[cell] || occupiedByFish?.[cell] ? densityScale + 1 : 1;
      const index = (y + 1) * stride + x + 1;
      totals[index] = totals[index - stride] + row;
    }
  }
  const rectangle = (left, right, top, bottom) => totals[(bottom + 1) * stride + right + 1] - totals[top * stride + right + 1] - totals[(bottom + 1) * stride + left] + totals[top * stride + left];
  function windowArea(x, y) {
    const r = ECOLOGY.radius, left = x - r, right = x + r;
    const top = Math.max(0, y - r), bottom = Math.min(height - 1, y + r);
    if (top > bottom) return 0;
    if (left < 0) return rectangle(width + left, width - 1, top, bottom) + rectangle(0, right, top, bottom);
    if (right >= width) return rectangle(left, width - 1, top, bottom) + rectangle(0, right - width, top, bottom);
    return rectangle(left, right, top, bottom);
  }
  const density = (cx, cy) => {
    const x = wrapX(Math.round(cx)), y = Math.round(cy);
    const total = windowArea(x, y), water = total % densityScale;
    const used = Math.floor(total / densityScale);
    return water ? used / water : 1;
  };
  const allowsBreeding = (x, y) => {
    const total = windowArea(x, y);
    return Math.floor(total / densityScale) * 5 < (total % densityScale) * 2;
  };
  // Each row prefix counts centers that permit breeding. One range check
  // covers all possible contact midpoints on that row of a fish's body.
  const openRows = [];
  density.crowdedRegion = (minX, minY, maxX, maxY) => {
    if (minY < 0 || maxY >= height) return false;
    const left = wrapX(minX), right = left + maxX - minX;
    for (let y = minY; y <= maxY; y++) {
      let row = openRows[y];
      if (!row) {
        row = openRows[y] = new Uint16Array(stride);
        for (let x = 0; x < width; x++) {
          row[x + 1] = row[x] + Number(allowsBreeding(x, y));
        }
      }
      if (right < width ? row[right + 1] !== row[left] :
          row[width] !== row[left] || row[right - width + 1] !== 0) return false;
    }
    return true;
  };
  density.allowsBreedingAt = allowsBreeding;
  return density;
}
export const contactTime = density => density >= .4 ? Infinity : density >= .2 ? 20000 : 5000;
export const growthChance = density => density >= .4 ? 0 : density >= .2 ? .005 : .01;
export function weedExpires(cell, state) {
  const ordinary = cell.created + ECOLOGY.weedMinLife + hash(`weed-life:${cell.id}`) % (ECOLOGY.weedLifeRange + 1);
  const activated = cell.ecoGraceAt ?? (state?.legacy && cell.created < state.activated ? state.activated : undefined);
  const grace = Number.isFinite(activated) ? activated + 24 * 3600000 + hash(`weed-grace:${cell.id}`) % (24 * 3600000 + 1) : 0;
  return Math.max(ordinary, grace);
}
export function weedAlpha(cell, state, now) { const remaining = weedExpires(cell, state) - now; return Math.max(.25, Math.min(1, .25 + remaining / (12 * 3600000) * .75)); }
export function looseWither(cell) {
  let lastEat = -Infinity, lastWither = -Infinity;
  for (const event of cell.path) {
    if (event.reason === 'eat') lastEat = Math.max(lastEat, event.t);
    else if (event.reason === 'wither-loose') lastWither = Math.max(lastWither, event.t);
  }
  return lastWither > lastEat;
}
export function naturalSediment(cell, data) {
  if (cell.kind !== 'scene' || cell.chat || !cell.path.some(event => event.reason === 'expire')) return false;
  return !Object.values(data.ops).some(op => op.kind === 'sceneEdit' && op.cell === cell.id);
}
export function settleAt(cell) { return Math.max(...cell.path.filter(event => event.reason === 'expire').map(event => event.t)); }
function settleWithering(world, state, now, transition) {
  const schedule = world.witherSchedule;
  const grace = state.legacy ? state.activated : null;
  if (schedule && schedule.grace === grace && now < schedule.due) return;
  const deadPlants = new Map();
  let due = Infinity;
  for (const c of world.charValues('food', 'seaweed')) {
    if (c.kind === 'seaweed') {
      const at = weedExpires(c, state);
      if (now < at) { due = Math.min(due, at); continue; }
      if (!(now >= at)) continue;
      if (!deadPlants.has(c.entity)) deadPlants.set(c.entity, []);
      deadPlants.get(c.entity).push({ index: c.wild.index, at });
      transition(c, { kind: 'burn', entity: '' }, { id: `wither:${c.id}`, t: at, reason: 'wither' });
      world.foodRevision++; world.dirty = true;
    } else if (c.kind === 'food' && looseWither(c)) {
      const at = c.born + ECOLOGY.looseLife;
      if (now < at) { due = Math.min(due, at); continue; }
      if (now >= at) {
        transition(c, { kind: 'burn', entity: '' }, { id: `wither-dissolve:${c.id}:${c.born}`, t: at, reason: 'wither-dissolve' });
        world.dirty = true;
      }
    }
  }
  if (deadPlants.size) for (const c of world.charValues('seaweed')) {
    const cuts = (deadPlants.get(c.entity) || []).filter(cut => cut.index < c.wild.index); if (!cuts.length) continue;
    const at = Math.min(...cuts.map(cut => cut.at)); transition(c, { kind: 'food', entity: '', born: at, fall: 0 }, { id: `wither-loose:${c.id}:${at}`, t: at, reason: 'wither-loose' });
    if (now >= at + ECOLOGY.looseLife) transition(c, { kind: 'burn', entity: '' }, { id: `wither-dissolve:${c.id}:${at}`, t: at + ECOLOGY.looseLife, reason: 'wither-dissolve' });
    else due = Math.min(due, at + ECOLOGY.looseLife);
    world.foodRevision++; world.dirty = true;
  }
  if (schedule) { schedule.grace = grace; schedule.due = due; }
}
export function updateEcology(world, now, transition) {
  const state = ensureEcology(world, now);
  settleWithering(world, state, now, transition);
  const hour = Math.floor(now / 3600000); if (hour <= state.hour) return;
  let density;
  const edited = new Set(Object.values(world.data.ops).filter(op => op.kind === 'sceneEdit').map(op => op.cell));
  const scenes = world.charValues('scene');
  for (const c of scenes) {
    if (c.chat || edited.has(c.id)) continue;
    const settled = settleAt(c); if (!Number.isFinite(settled)) continue;
    const scene = world.data.scenes[c.entity]; if (!scene) continue;
    // One stable trial per elapsed hour, with immutable settlement age.
    const first = Math.max(state.hour + 1, Math.ceil((settled + ECOLOGY.sedimentGrace) / 3600000));
    if (first > hour) continue;
    // The first eligible deposit captures the same pre-weathering sea for all trials.
    density ??= densityField(world);
    const x = wrapX(scene.x + c.x), y = scene.y + c.y, probability = density(x, y) >= .4 ? 500 : 200;
    for (let h = first; h <= hour; h++) if (hash(`weathering:${c.id}:${h}`) % 10000 < probability) { transition(c, { kind: 'burn', entity: '' }, { id: `weathering:${c.id}:${h}`, t: h * 3600000, reason: 'weathering' }); world.dirty = true; break; }
  }
  const remaining = new Set(scenes.filter(c => c.kind === 'scene').map(c => c.entity)); for (const id of Object.keys(world.data.scenes)) if (!remaining.has(id)) delete world.data.scenes[id];
  state.hour = hour;
}
