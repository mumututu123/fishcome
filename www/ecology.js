import { wrapX, deltaX, worldKey } from './geography.js';

export const ECOLOGY = Object.freeze({ radius: 15, weedMinLife: 72 * 3600000, weedLifeRange: 48 * 3600000, looseLife: 75000, sedimentGrace: 48 * 3600000 });
const hash = text => { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619); return n >>> 0; };
export function newEcology(now, legacy = false) { return { version: 1, activated: now, legacy, hour: Math.floor(now / 3600000) }; }
export function ensureEcology(world, now, legacy = false) { return world.data.ecology ||= newEcology(now, legacy); }
export function validEcology(state, now = Date.now() + 60000) { return state === undefined || !!state && state.version === 1 && typeof state.legacy === 'boolean' && Number.isFinite(state.activated) && state.activated >= 0 && state.activated <= now && Number.isInteger(state.hour) && state.hour >= 0 && state.hour <= Math.floor(now / 3600000); }
export function mergeEcology(a, b) { if (!a) return b; if (!b) return a; return { version: 1, activated: Math.min(a.activated, b.activated), legacy: a.legacy || b.legacy, hour: Math.max(a.hour, b.hour) }; }
export function densityField(world, scenery = world.sceneryMap()) {
  const width = 1000, floors = Array.from({ length: width }, (_, x) => world.floorAt(x)), height = Math.max(...floors), stride = width + 1;
  const occupied = new Uint8Array(width * height), used = new Uint32Array(stride * (height + 1)), wet = new Uint32Array(used.length);
  const mark = (x, y) => { if (Number.isInteger(y) && y >= 0 && y < height) occupied[y * width + wrapX(x)] = 1; };
  for (const { scene, cell } of scenery.values()) mark(scene.x + cell.x, scene.y + cell.y);
  for (const c of Object.values(world.data.chars)) {
    if (['food', 'seaweed'].includes(c.kind)) mark(c.x, c.y);
    if (c.kind === 'fish') { const f = world.data.fishes[c.entity]; if (f) mark(f.x + f.facing * c.x, f.y + c.y); }
  }
  const monument = world.monument; for (const [dy, row] of monument.rows.entries()) for (const [dx, ch] of Array.from(row).entries()) if (ch !== ' ') mark(monument.x + dx, monument.y + dy);
  // Summed-area tables make every local density query constant-time, even on hourly turnover.
  for (let y = 0; y < height; y++) { let rowWet = 0, rowUsed = 0; for (let x = 0; x < width; x++) { const water = y < floors[x]; rowWet += +water; rowUsed += water ? occupied[y * width + x] : 0; const index = (y + 1) * stride + x + 1; wet[index] = wet[index - stride] + rowWet; used[index] = used[index - stride] + rowUsed; } }
  const rectangle = (table, left, right, top, bottom) => table[(bottom + 1) * stride + right + 1] - table[top * stride + right + 1] - table[(bottom + 1) * stride + left] + table[top * stride + left];
  const cache = new Map();
  return (cx, cy) => {
    const x = wrapX(Math.round(cx)), y = Math.round(cy), key = worldKey(x, y); if (cache.has(key)) return cache.get(key);
    const left = x - ECOLOGY.radius, right = x + ECOLOGY.radius, top = Math.max(0, y - ECOLOGY.radius), bottom = Math.min(height - 1, y + ECOLOGY.radius);
    if (top > bottom) return 1;
    const ranges = left < 0 ? [[0, right], [width + left, width - 1]] : right >= width ? [[left, width - 1], [0, right - width]] : [[left, right]];
    let totalWet = 0, totalUsed = 0; for (const [a, b] of ranges) { totalWet += rectangle(wet, a, b, top, bottom); totalUsed += rectangle(used, a, b, top, bottom); }
    const result = totalWet ? totalUsed / totalWet : 1; cache.set(key, result); return result;
  };
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
export function looseWither(cell) { const lastEat = cell.path.reduce((at, event) => event.reason === 'eat' ? Math.max(at, event.t) : at, -Infinity), lastWither = cell.path.reduce((at, event) => event.reason === 'wither-loose' ? Math.max(at, event.t) : at, -Infinity); return lastWither > lastEat; }
export function naturalSediment(cell, data) {
  if (cell.kind !== 'scene' || cell.chat || !cell.path.some(event => event.reason === 'expire')) return false;
  return !Object.values(data.ops).some(op => op.kind === 'sceneEdit' && op.cell === cell.id);
}
export function settleAt(cell) { return Math.max(...cell.path.filter(event => event.reason === 'expire').map(event => event.t)); }
export function updateEcology(world, now, transition) {
  const state = ensureEcology(world, now), deadPlants = new Map();
  for (const c of Object.values(world.data.chars)) {
    if (c.kind === 'seaweed' && now >= weedExpires(c, state)) { if (!deadPlants.has(c.entity)) deadPlants.set(c.entity, []); deadPlants.get(c.entity).push({ index: c.wild.index, at: weedExpires(c, state) }); transition(c, { kind: 'burn', entity: '' }, { id: `wither:${c.id}`, t: weedExpires(c, state), reason: 'wither' }); world.foodRevision++; world.dirty = true; }
    else if (c.kind === 'food' && looseWither(c) && now >= c.born + ECOLOGY.looseLife) { transition(c, { kind: 'burn', entity: '' }, { id: `wither-dissolve:${c.id}:${c.born}`, t: c.born + ECOLOGY.looseLife, reason: 'wither-dissolve' }); world.dirty = true; }
  }
  for (const c of Object.values(world.data.chars)) if (c.kind === 'seaweed') {
    const cuts = (deadPlants.get(c.entity) || []).filter(cut => cut.index < c.wild.index); if (!cuts.length) continue;
    const at = Math.min(...cuts.map(cut => cut.at)); transition(c, { kind: 'food', entity: '', born: at, fall: 0 }, { id: `wither-loose:${c.id}:${at}`, t: at, reason: 'wither-loose' });
    if (now >= at + ECOLOGY.looseLife) transition(c, { kind: 'burn', entity: '' }, { id: `wither-dissolve:${c.id}:${at}`, t: at + ECOLOGY.looseLife, reason: 'wither-dissolve' });
    world.foodRevision++; world.dirty = true;
  }
  const hour = Math.floor(now / 3600000); if (hour <= state.hour) return;
  const density = densityField(world), edited = new Set(Object.values(world.data.ops).filter(op => op.kind === 'sceneEdit').map(op => op.cell));
  for (const c of Object.values(world.data.chars)) {
    if (c.kind !== 'scene' || c.chat || edited.has(c.id)) continue;
    const settled = settleAt(c); if (!Number.isFinite(settled)) continue;
    const scene = world.data.scenes[c.entity]; if (!scene) continue;
    const x = wrapX(scene.x + c.x), y = scene.y + c.y, probability = density(x, y) >= .4 ? 500 : 200;
    // One stable trial per elapsed hour, with immutable settlement age.
    const first = Math.max(state.hour + 1, Math.ceil((settled + ECOLOGY.sedimentGrace) / 3600000));
    for (let h = first; h <= hour; h++) if (hash(`weathering:${c.id}:${h}`) % 10000 < probability) { transition(c, { kind: 'burn', entity: '' }, { id: `weathering:${c.id}:${h}`, t: h * 3600000, reason: 'weathering' }); world.dirty = true; break; }
  }
  const remaining = new Set(Object.values(world.data.chars).filter(c => c.kind === 'scene').map(c => c.entity)); for (const id of Object.keys(world.data.scenes)) if (!remaining.has(id)) delete world.data.scenes[id];
  state.hour = hour;
}
