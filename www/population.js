import { cellPosition, hash, key } from './engine.js';
import { wrapX, deltaX } from './geography.js';
import { cancelBreeding } from './breeding.js';
import { recordStory, storyBatch } from './life.js';

// Shared, conservative limits. NPCs and geology never spend player currency.
export const POPULATION = Object.freeze({ threshold: 300, sickRatio: .2, check: 3600000,
  dissolveEvery: 3600000, remedy: '乐', immunity: 24 * 3600000, juvenile: 2 * 3600000,
  predatorThreshold: 200, predators: 4, preySize: 8, sight: 24, biteCooldown: 1800000,
  huntCooldown: 600000, volcanoPeriod: 1800000, volcanoChance: .25, volcanoCooldown: 6 * 3600000,
  warning: 30000, emission: 2000, magmaLimit: 32, cooling: 600000, rockLimit: 2000 });
export const newPopulation = at => ({ at, illnessSlot: Math.floor(at / POPULATION.check),
  illnesses: {}, predators: {}, huntAt: 0, volcanoSlot: Math.floor(at / POPULATION.volcanoPeriod), eruption: null });
const order = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const latest = (a, b, field = 'at') => !a ? b : !b ? a : a[field] > b[field] || a[field] === b[field] && order(a, b) > 0 ? a : b;
export function illnessOf(data, id) { const r = data.population?.illnesses[id]; return r && !r.curedAt ? r : null; }
export function cureFish(world, id, food, now) {
  const r = illnessOf(world.data, id);
  if (!r || !world.data.fishes[id] || food.ch !== POPULATION.remedy) return false;
  r.curedAt = now; recordStory(world, 'recovered', id, now, { visit: r.at }); return true;
}
export const predatorCells = p => [[0, 0, '鲨'], [1, 0, '食'], [2, 0, '肉'], [3, 0, '鱼'], [1, -1, '鳍'], [1, 1, '鳍']]
  .map(([x, y, ch]) => ({ x: wrapX(p.x - p.facing * x), y: p.y + y, ch, color: '#d9ab86' }));
export function populationScenery(data, map, { predators = true } = {}) {
  const add = (id, x, y, ch, created) => map.set(key(x, y), { scene: { id, x: 0, y: 0, fixed: true, natural: true }, cell: { id, x, y, ch, created } });
  for (const r of Object.values(data.rocks || {})) add(r.id, r.x, r.y, '岩', r.at);
  if (predators) for (const p of Object.values(data.population?.predators || {})) for (const [i, c] of predatorCells(p).entries()) add(`npc:${p.id}:${i}`, c.x, c.y, c.ch, p.created);
  return map;
}
export function killFish(world, id, now, cause, transition, groups = world.fishGroups()) {
  const fish = world.data.fishes[id]; if (!fish) return;
  const pair = world.breedingState(id); if (pair) cancelBreeding(world.data, pair, now, cause);
  for (const cell of groups.get(id) || []) {
    const p = cellPosition(fish, cell);
    transition(cell, { kind: 'burn', entity: '', x: wrapX(p.x), y: p.y },
      { id: `eco-death:${id}:${now}`, t: now, reason: 'ecoDeath', fish: id, cause });
  }
  delete world.data.fishes[id]; delete world.data.population.illnesses[id];
  recordStory(world, 'depart', id, now, { cause }); world.foodRevision++; world.dirty = true;
}
function settleIllness(world, now, changeCell) {
  const state = world.data.population;
  let groups;
  for (const [id, r] of Object.entries(state.illnesses)) {
    if (!world.data.fishes[id]) delete state.illnesses[id];
    else if (!r.curedAt) {
      r.nextLossAt ??= r.at + POPULATION.dissolveEvery;
      delete r.deadline;
      while (world.data.fishes[id] && now >= r.nextLossAt) {
        const at = r.nextLossAt;
        groups ??= world.fishGroups();
        const cells = (groups.get(id) || []).filter(cell => cell.kind === 'fish');
        world.starve(id, at, null, { illness: true, cells, changeCell });
        r.nextLossAt = at + POPULATION.dissolveEvery;
      }
      if (!world.data.fishes[id]) delete state.illnesses[id];
    }
  }
}
function checkIllness(world, now) {
  const state = world.data.population, slot = Math.floor(now / POPULATION.check);
  if (slot <= state.illnessSlot || !world.ambient) return;
  state.illnessSlot = slot;
  // Never backfill infections for unattended/offline hours.
  const fishes = world.fishValues();
  if (fishes.length < POPULATION.threshold) return;
  const active = fishes.filter(f => illnessOf(world.data, f.id)).length;
  const quota = Math.max(0, Math.ceil(fishes.length * POPULATION.sickRatio) - active);
  if (!quota) return;
  const eligible = fishes.filter(f => now - f.created >= POPULATION.juvenile && !illnessOf(world.data, f.id)
    && (!state.illnesses[f.id]?.curedAt || now - state.illnesses[f.id].curedAt >= POPULATION.immunity));
  const ranked = eligible.map(fish => ({ fish, rank: hash(`crowding:${slot}:${fish.id}`) }));
  ranked.sort((a, b) => a.rank - b.rank || a.fish.id.localeCompare(b.fish.id));
  const stories = storyBatch(world);
  for (const { fish: f } of ranked.slice(0, quota)) {
    state.illnesses[f.id] = { at: now, nextLossAt: now + POPULATION.dissolveEvery, curedAt: 0 };
    stories.record(world, 'depressed', f.id, now, { visit: now });
  }
  stories.commit();
}
function lineClear(world, a, b, scenery) {
  const dx = deltaX(b.x, a.x), dy = b.y - a.y, n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  for (let i = 1; i <= n; i++) { const x = Math.round(a.x + dx * i / n), y = Math.round(a.y + dy * i / n); if (!world.waterAt(x, y) || scenery.has(key(x, y))) return false; }
  return true;
}
function updatePredators(world, now, dt, transition) {
  const state = world.data.population, fishes = world.fishValues(), count = fishes.length;
  const wanted = Math.min(POPULATION.predators, Math.max(0, Math.ceil((count - POPULATION.predatorThreshold) / 100)));
  for (const id of Object.keys(state.predators)) if (+id >= wanted) delete state.predators[id];
  if (!wanted && !Object.keys(state.predators).length) return;
  const groups = world.fishGroups();
  const scenery = populationScenery(world.data, world.sceneryMap(false), { predators: false });
  const occupants = world.movementGrid(groups);
  const fits = p => predatorCells(p).every(c => world.waterAt(c.x, c.y) && !scenery.has(key(c.x, c.y)) && !occupants.get(c.x, c.y));
  for (let i = 0; i < wanted; i++) if (!state.predators[i]) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const x = hash(`predator:${world.id}:${i}:${attempt}`) % 1000;
      const p = { id: String(i), x, y: Math.max(3, world.floorAt(x) - 12 - i * 4), facing: 1, created: now, lastBite: 0, cx: 0, cy: 0 };
      if (fits(p) && !Object.values(state.predators).some(other => predatorCells(other).some(c => predatorCells(p).some(d => key(c.x, c.y) === key(d.x, d.y))))) { state.predators[i] = p; break; }
    }
  }
  let prey;
  for (const p of Object.values(state.predators).sort((a, b) => a.id.localeCompare(b.id))) {
    if (now < p.created) continue;
    if (!fits(p)) { delete state.predators[p.id]; continue; }
    const mouth = predatorCells(p)[0], ready = now - p.lastBite >= POPULATION.biteCooldown && now - state.huntAt >= POPULATION.huntCooldown;
    const targets = [];
    if (ready) {
      prey ??= fishes.filter(f => now - f.created >= POPULATION.juvenile && (groups.get(f.id)?.length || Infinity) <= POPULATION.preySize);
      const nearby = !occupants.unsafeHorizontal && occupants.ownersNear([mouth], POPULATION.sight);
      for (const f of prey) {
        if ((nearby && !nearby[occupants.slots.get(f.id)]) || !world.data.fishes[f.id]) continue;
        for (const cell of groups.get(f.id) || []) {
          const at = cellPosition(f, cell);
          if (Math.max(Math.abs(deltaX(at.x, mouth.x)), Math.abs(at.y - mouth.y)) <= POPULATION.sight && lineClear(world, mouth, at, scenery)) targets.push({ fish: f, ...at });
        }
      }
    }
    targets.sort((a, b) => Number(!!illnessOf(world.data, b.fish.id)) - Number(!!illnessOf(world.data, a.fish.id))
      || Math.abs(deltaX(a.x, mouth.x)) + Math.abs(a.y - mouth.y) - Math.abs(deltaX(b.x, mouth.x)) - Math.abs(b.y - mouth.y) || a.fish.id.localeCompare(b.fish.id));
    let target = targets[0];
    const bite = () => {
      if (!target || !world.data.fishes[target.fish.id]) return false;
      const m = predatorCells(p)[0], dx = Math.abs(deltaX(target.x, m.x)), dy = Math.abs(target.y - m.y);
      if (dx + dy !== 1) return false; // No attacks across diagonal corners or scenery.
      const f = target.fish;
      for (const c of groups.get(f.id) || []) { const at = cellPosition(f, c); occupants.clear(at.x, at.y); }
      killFish(world, f.id, now, 'predator', transition, groups); p.lastBite = state.huntAt = now; target = null; return true;
    };
    if (bite()) continue;
    const phase = hash(`patrol:${p.id}:${Math.floor(now / 15000)}`), dx = target ? Math.sign(deltaX(target.x, mouth.x)) : [-1, 0, 1][phase % 3], dy = target ? Math.sign(target.y - mouth.y) : [-1, 0, 1][(phase >>> 4) % 3];
    const free = next => fits(next) && !Object.values(state.predators).some(other => other.id !== p.id && predatorCells(other).some(c => predatorCells(next).some(d => key(c.x, c.y) === key(d.x, d.y))));
    if (dx && dx !== p.facing) {
      // Mirror about the body midpoint, checking every swept grid cell.
      const next = { ...p, x: wrapX(p.x - 3 * p.facing), facing: -p.facing };
      const swept = predatorCells(p).every(c => Array.from({ length: 7 }, (_, i) => p.x - 3 + i).every(x => world.waterAt(x, c.y) && !scenery.has(key(x, c.y)) && !occupants.get(x, c.y)));
      if (swept && free(next)) { p.x = next.x; p.facing = next.facing; }
    }
    p.cx = dx ? Math.min(1, p.cx + dt) : 0; p.cy = dy ? Math.min(1, p.cy + dt * .6) : 0;
    if (p.cx >= 1) { const next = { ...p, x: wrapX(p.x + dx) }; if (free(next)) p.x = next.x; p.cx = 0; }
    if (p.cy >= 1) { const next = { ...p, y: p.y + dy }; if (free(next)) p.y = next.y; p.cy = 0; }
    bite();
  }
}
export function volcanoPlan(data, slot) {
  const seed = data.terrain?.seed || Object.keys(data.roots).sort()[0], id = `volcano:${seed}:${slot}`;
  if (!Object.hasOwn(data.roots, seed) || !Number.isInteger(slot) || slot < 0 || slot * POPULATION.volcanoPeriod < data.roots[seed] || hash(id) % 10000 >= POPULATION.volcanoChance * 10000) return null;
  return { id, seed, slot, x: hash(`vent:${id}`) % 1000 };
}
function magmaOrigin(vent, id) {
  const roll = hash(id);
  return { x: wrapX(vent + roll % 5 - 2), rise: 8 + roll % 8, drift: roll % 3 - 1 };
}

export function repairLocalMagma(data) {
  const population = data?.population, eruption = population?.eruption;
  let repaired;
  for (const [id, c] of Object.entries(eruption?.particles || {})) {
    if (c?.drift !== 0 || !Number.isFinite(c.cx) || c.cx <= 1) continue;
    const index = Number(id.slice(id.lastIndexOf(':') + 1));
    if (!Number.isInteger(index) || index < 0 || index >= eruption.emitted || id !== `${eruption.id}:${index}`) continue;
    const source = magmaOrigin(eruption.x, id);
    // Old writers added at most one second on emission, then a quarter cell
    // per active second. Vertical particles never left their emission column.
    const age = Math.min(population.at - c.born, POPULATION.cooling);
    if (source.drift !== 0 || source.x !== c.x || !(age >= 0 && c.cx <= (age / 1000 + 1) * .25)) continue;
    repaired ??= { ...eruption.particles };
    repaired[id] = { ...c, cx: 0 };
  }
  return repaired ? { ...data, population: { ...population, eruption: { ...eruption, particles: repaired } } } : data;
}

function updateVolcano(world, now, dt, transition, resume = false) {
  const state = world.data.population, slot = Math.floor(now / POPULATION.volcanoPeriod);
  if (!resume && world.ambient && slot > state.volcanoSlot) {
    state.volcanoSlot = slot;
    const plan = volcanoPlan(world.data, slot), old = state.eruption;
    if (plan && (!old || now - old.at >= POPULATION.volcanoCooldown) && Object.keys(world.data.rocks).length <= POPULATION.rockLimit - POPULATION.magmaLimit) {
      const monument = world.monument;
      if (Math.abs(deltaX(plan.x, monument.x + 4)) > 24) state.eruption = { ...plan, at: now, emitted: 0, nextAt: now + POPULATION.warning, particles: {} };
    }
  }
  const e = state.eruption; if (!e) return;
  const emitting = !resume && now >= e.nextAt && e.emitted < POPULATION.magmaLimit &&
    now - e.at <= POPULATION.warning + POPULATION.emission * POPULATION.magmaLimit + 2000;
  if (!emitting && !Object.keys(e.particles).length) return;
  const groups = world.fishGroups(), scenery = world.sceneryMap(), occupancy = world.movementGrid(groups);
  const hit = c => { for (const id of occupancy.get(c.x, c.y) || []) if (world.data.fishes[id]) killFish(world, id, now, 'magma', transition, groups); };
  if (emitting) {
    const id = `${e.id}:${e.emitted++}`, { x, rise, drift } = magmaOrigin(e.x, id), y = world.floorAt(x) - 1;
    e.nextAt = now + POPULATION.emission;
    if (!scenery.has(key(x, y))) e.particles[id] = { id, x, y, born: now, rise, drift, cx: 0, cy: 0, settled: false };
  }
  const hot = new Set(Object.values(e.particles).map(c => key(c.x, c.y)));
  for (const [id, c] of Object.entries(e.particles)) {
    if (now < c.born) continue;
    if (world.data.rocks[id]) { delete e.particles[id]; continue; }
    // Restoring a suspended world cools existing lava but never replays damage.
    const cooled = now >= c.born + POPULATION.cooling;
    const moving = !resume && !cooled && !c.settled;
    // Vertical particles have no horizontal progress. This also corrects the
    // unused remainder left on stationary particles by older checkpoints.
    if (c.drift === 0) c.cx = 0;
    else if (moving) c.cx += dt * .25;
    if (!resume && !cooled) hit(c);
    if (moving) {
      const rising = c.rise > 0;
      c.cy += dt * (rising ? 2 : .25);
      if (c.cx >= 1) { const x = wrapX(c.x + c.drift); if (world.waterAt(x, c.y) && !scenery.has(key(x, c.y)) && !hot.has(key(x, c.y))) { hot.delete(key(c.x, c.y)); c.x = x; hot.add(key(c.x, c.y)); hit(c); } c.cx = 0; }
      while (c.cy >= 1 && !c.settled) {
        const y = c.y + (c.rise > 0 ? -1 : 1);
        if (!world.waterAt(c.x, y) || scenery.has(key(c.x, y)) || hot.has(key(c.x, y))) { if (c.rise > 0) c.rise = 0; else c.settled = true; c.cy = 0; break; }
        hot.delete(key(c.x, c.y)); c.y = y; hot.add(key(c.x, c.y)); c.cy--; if (c.rise > 0) c.rise--; hit(c);
      }
    }
    if (!cooled) continue;
    // Rock is always supported on the seabed/scenery, never suspended in water.
    let y = c.y;
    while (world.waterAt(c.x, y + 1) && !scenery.has(key(c.x, y + 1))) y++;
    if (Object.keys(world.data.rocks).length < POPULATION.rockLimit && y >= 60 && !scenery.has(key(c.x, y)) && !occupancy.get(c.x, y)) {
      world.data.rocks[id] = { id, seed: e.seed, slot: e.slot, index: +id.split(':').at(-1), x: c.x, y, at: c.born + POPULATION.cooling };
      populationScenery({ rocks: { [id]: world.data.rocks[id] } }, scenery, { predators: false });
    } else if (Object.keys(world.data.rocks).length < POPULATION.rockLimit && y >= 60 && !scenery.has(key(c.x, y))) {
      c.settled = true; continue; // A cold grain waits for an occupied landing cell to clear.
    }
    delete e.particles[id]; world.dirty = true;
  }
}
export function updatePopulation(world, now, transition, { resume = false } = {}) {
  world.data.population ||= newPopulation(now); world.data.rocks ||= {};
  const state = world.data.population, dt = Math.min(1, Math.max(0, (now - state.at) / 1000));
  settleIllness(world, now, transition);
  if (resume) {
    state.illnessSlot = Math.max(state.illnessSlot, Math.floor(now / POPULATION.check));
    state.volcanoSlot = Math.max(state.volcanoSlot, Math.floor(now / POPULATION.volcanoPeriod));
  } else { checkIllness(world, now); if (world.ambient) updatePredators(world, now, dt, transition); }
  updateVolcano(world, now, dt, transition, resume);
  state.at = Math.max(state.at, now);
}
export function mergePopulation(a, b, now) {
  a ||= newPopulation(now); b ||= newPopulation(now);
  const winner = latest(a, b), illnesses = {};
  for (const id of new Set([...Object.keys(a.illnesses), ...Object.keys(b.illnesses)])) {
    const x = a.illnesses[id], y = b.illnesses[id], r = latest(x, y);
    illnesses[id] = { ...r, curedAt: x?.at === y?.at ? Math.max(x.curedAt, y.curedAt) : r.curedAt,
      nextLossAt: x?.at === y?.at ? Math.max(x.nextLossAt ?? x.at + POPULATION.dissolveEvery, y.nextLossAt ?? y.at + POPULATION.dissolveEvery) : r.nextLossAt ?? r.at + POPULATION.dissolveEvery };
  }
  return { ...winner, at: Math.max(a.at, b.at), illnessSlot: Math.max(a.illnessSlot, b.illnessSlot),
    volcanoSlot: Math.max(a.volcanoSlot, b.volcanoSlot), huntAt: Math.max(a.huntAt, b.huntAt), illnesses,
    eruption: latest(a.eruption, b.eruption, 'at')?.id === winner.eruption?.id ? winner.eruption : latest(a.eruption, b.eruption, 'at') };
}
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function validPopulation(state, data, max = Date.now() + 60000) {
  if (state === undefined) return true;
  const time = n => Number.isFinite(n) && n >= 0 && n <= max;
  const point = p => Number.isInteger(p.x) && p.x >= 0 && p.x < 1000 && Number.isInteger(p.y) && p.y >= 0 && p.y < 101;
  if (!object(state) || !time(state.at) || !time(state.huntAt) || !Number.isInteger(state.illnessSlot) || state.illnessSlot < 0 || state.illnessSlot > Math.floor(max / POPULATION.check)
    || !Number.isInteger(state.volcanoSlot) || state.volcanoSlot < 0 || state.volcanoSlot > Math.floor(max / POPULATION.volcanoPeriod) || !object(state.illnesses) || !object(state.predators) || Object.keys(state.predators).length > POPULATION.predators || Object.keys(state.illnesses).length > 100000) return false;
  for (const [id, r] of Object.entries(state.illnesses)) if (!object(r) || !time(r.at) || r.deadline !== undefined && r.deadline !== r.at + 8 * 3600000 || r.nextLossAt === undefined && r.deadline === undefined || r.nextLossAt !== undefined && (!Number.isFinite(r.nextLossAt) || r.nextLossAt < r.at + POPULATION.dissolveEvery || r.nextLossAt > max + POPULATION.dissolveEvery || (r.nextLossAt - r.at) % POPULATION.dissolveEvery !== 0) || !time(r.curedAt) || r.curedAt && r.curedAt < r.at || !data.fishes?.[id] && !data.ops?.[id] && !data.breeding?.[id.slice(5)]) return false;
  for (const [id, p] of Object.entries(state.predators)) if (!object(p) || id !== p.id || !/^[0-3]$/.test(id) || !point(p) || ![1, -1].includes(p.facing) || !time(p.created) || !time(p.lastBite) || !Number.isFinite(p.cx) || p.cx < 0 || p.cx > 1 || !Number.isFinite(p.cy) || p.cy < 0 || p.cy > 1) return false;
  const e = state.eruption;
  if (e) {
    const plan = volcanoPlan({ roots: data.roots, terrain: { seed: e.seed } }, e.slot);
    if (!object(e) || !plan || e.id !== plan.id || e.x !== plan.x || !time(e.at) || e.at < e.slot * POPULATION.volcanoPeriod || e.at >= (e.slot + 1) * POPULATION.volcanoPeriod || !Number.isInteger(e.emitted) || e.emitted < 0 || e.emitted > POPULATION.magmaLimit || !Number.isFinite(e.nextAt) || e.nextAt < e.at + POPULATION.warning || !object(e.particles) || Object.keys(e.particles).length > e.emitted) return false;
    for (const [id, c] of Object.entries(e.particles)) if (!object(c) || id !== c.id || !id.startsWith(e.id + ':') || !Number.isInteger(+id.slice(e.id.length + 1)) || +id.slice(e.id.length + 1) < 0 || +id.slice(e.id.length + 1) >= e.emitted || !point(c) || !time(c.born) || c.born < e.at + POPULATION.warning || c.born > e.at + POPULATION.warning + POPULATION.emission * POPULATION.magmaLimit + 2000 || !Number.isInteger(c.rise) || c.rise < 0 || c.rise > 15 || ![-1, 0, 1].includes(c.drift) || !Number.isFinite(c.cx) || c.cx < 0 || c.cx > 1 || !Number.isFinite(c.cy) || c.cy < 0 || c.cy > 2 || typeof c.settled !== 'boolean') return false;
  }
  return true;
}
export function validRocks(rocks, data, max = Date.now() + 60000) {
  if (rocks === undefined) return true;
  if (!object(rocks) || Object.keys(rocks).length > POPULATION.rockLimit) return false;
  const positions = new Set();
  for (const [id, r] of Object.entries(rocks)) {
    const plan = volcanoPlan({ roots: data.roots, terrain: { seed: r?.seed } }, r?.slot);
    if (!plan || r.id !== id || id !== `${plan.id}:${r.index}` || !Number.isInteger(r.index) || r.index < 0 || r.index >= POPULATION.magmaLimit || !Number.isInteger(r.x) || r.x < 0 || r.x >= 1000 || Math.abs(deltaX(r.x, plan.x)) > 24 || !Number.isInteger(r.y) || r.y < 60 || r.y >= 100 || !Number.isFinite(r.at) || r.at < r.slot * POPULATION.volcanoPeriod + POPULATION.warning + POPULATION.cooling || r.at > (r.slot + 1) * POPULATION.volcanoPeriod + POPULATION.warning + POPULATION.emission * POPULATION.magmaLimit + POPULATION.cooling + 2000 || r.at > max || positions.has(key(r.x, r.y))) return false;
    positions.add(key(r.x, r.y));
  }
  return true;
}
export function mergeRocks(a = {}, b = {}) {
  const result = {}, positions = new Set();
  for (const [id, r] of Object.entries({ ...a, ...b }).sort(([x], [y]) => x.localeCompare(y))) {
    const chosen = latest(a[id], b[id]), p = key(chosen.x, chosen.y); if (positions.has(p) || positions.size >= POPULATION.rockLimit) continue;
    result[id] = chosen; positions.add(p);
  }
  return result;
}
