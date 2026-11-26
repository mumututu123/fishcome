import { components, cellPosition, hash, key } from './engine.js';
import { wrapX, deltaX, makeTerrain } from './geography.js';
import { modelCells, legendaryModel, atomicPhase } from './legendary-models.js';
import { recordStory } from './life.js';
import { cancelBreeding } from './breeding.js';

export const LEGENDS = Object.freeze({ period: 600000, cooldown: 7200000, opening: 2000, warning: 20000, limit: 64 });
const terrains = new Map();
const labels = { cthulhu: '克苏鲁', godzilla: '哥斯拉', ship: '幽灵船' };
export const legendTitle = kind => labels[kind] || '';
export const newLegends = at => ({ at, through: {}, events: {}, burns: {}, deaths: {} });
function terrain(roots, seed) { const id = `${seed}:${roots[seed]}`; if (!terrains.has(id)) { terrains.set(id, makeTerrain(seed, roots[seed])); if (terrains.size > 64) terrains.delete(terrains.keys().next().value); } return terrains.get(id); }
export function legendSchedule(roots, seed, slot) {
  if (!Object.hasOwn(roots, seed) || !Number.isInteger(slot) || slot < 0 || !Number.isFinite(roots[seed]) || slot * LEGENDS.period < roots[seed]) return null;
  const id = `legend:${seed}:${slot}`, roll = hash(`awakening:${id}`) % 10000;
  const kind = roll < 20 ? 'cthulhu' : roll < 40 ? 'godzilla' : roll < 140 ? 'ship' : null; if (!kind) return null;
  const depths = terrain(roots, seed).depths, deepest = Math.max(...depths), candidates = depths.map((d, x) => d === deepest ? x : -1).filter(x => x >= 0);
  const x = kind === 'ship' ? hash(`route:${id}`) % 1000 : candidates[hash(`rift:${id}`) % candidates.length];
  const started = slot * LEGENDS.period, duration = kind === 'ship' ? 3600000 : 600000;
  return { id, seed, slot, kind, x, floor: depths[x], started, duration, ends: started + duration, direction: (hash(`wind:${id}`) >>> 24) % 2 ? 1 : -1 };
}
export function activeLegend(data, now = data.tick) {
  const candidates = [];
  for (const e of Object.values(data.legends?.events || {})) { if (now < e.at || now >= e.slot * LEGENDS.period + 3600000) continue; const s = legendSchedule(data.roots, e.seed, e.slot); if (s && now < s.ends) candidates.push({ ...e, ...s }); }
  return candidates.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))[0] || null;
}
export function capturedFish(data, fish, now = data.tick) {
  for (const e of Object.values(data.legends?.events || {}).sort((a, b) => a.at - b.at || a.seed.localeCompare(b.seed))) {
    if (now >= e.slot * LEGENDS.period + 600000 || !Object.keys(e.arms).length) continue;
    const s = legendSchedule(data.roots, e.seed, e.slot); if (s?.kind !== 'cthulhu' || now >= s.ends) continue;
    for (const [arm, capture] of Object.entries(e.arms)) if (capture.fish === fish && capture.at <= now) return { ...capture, arm: +arm, event: e, schedule: s };
  }
  return null;
}
export function retargetCapture(data, fish, now) {
  const held = capturedFish(data, fish, now), f = data.fishes[fish]; if (!held || !f) return;
  const c = held.event.arms[held.arm], dx = deltaX(f.x, c.pose.x), dy = f.y - c.pose.y;
  c.x = wrapX(c.x + dx); c.y += dy; c.pose = { x: f.x, y: f.y, facing: f.facing }; c.migratedAt = now;
}
export function legendPosition(roots, event, now) {
  const s = legendSchedule(roots, event.seed, event.slot), age = (now - s.started) / 1000;
  const x = wrapX(s.x + (s.kind === 'ship' ? age * .2 * s.direction : s.kind === 'godzilla' ? Math.sin(Math.max(0, age - 20) / 60) * 20 : 0));
  if (s.kind === 'ship') return { x, y: 0 };
  const floor = terrain(roots, s.seed).depths[Math.floor(x)], progress = Math.max(0, Math.min(1, (age - 10) / 10));
  const height = modelCells(s.kind).reduce((h, c) => Math.max(h, -c.y), 0), sinking = Math.max(0, Math.min(1, (age - 570) / 30)) * (height + 2);
  return { x, y: (100 + height) * (1 - progress) + (floor - 1) * progress + sinking };
}
function direction(s, age) { const attack = Math.max(0, atomicPhase(age).attack), value = hash(`breath:${s.id}:${attack}`); return { direction: (value >>> 24) % 2 ? 1 : -1, upward: (value >>> 16) % 2 === 0 }; }
export function legendGeometry(data, event, now, scenery = null) {
  const s = legendSchedule(data.roots, event.seed, event.slot); if (!s || now < event.at || now >= s.ends) return [];
  const age = (now - s.started) / 1000, p = legendPosition(data.roots, event, now), bindings = {};
  const depths = data.terrain?.depths || terrain(data.roots, s.seed).depths;
  if (s.kind !== 'ship' && age >= 20) { const height = modelCells(s.kind).reduce((h, c) => Math.max(h, -c.y), 0); p.y = depths[Math.floor(p.x)] - 1 + Math.max(0, Math.min(1, (age - 570) / 30)) * (height + 2); }
  for (const [arm, capture] of Object.entries(event.arms || {})) bindings[arm] = { x: deltaX(capture.x, p.x), y: capture.y - p.y };
  const options = s.kind === 'godzilla' ? direction(s, age) : { direction: s.direction };
  const cells = legendaryModel(s.kind, age, { ...options, bindings, missing: (event.drops || []).map(d => d.index) });
  const result = [], stopped = new Set(); let beamStopped = false;
  for (const cell of cells) {
    const at = { ...cell, x: wrapX(Math.round(p.x + cell.x)), y: Math.round(p.y + cell.y) };
    if (scenery && ['arm', 'beam'].includes(cell.role)) {
      const blocked = at.y < 0 || at.y >= depths[Math.floor(at.x)] || scenery.has(key(at.x, at.y));
      if (cell.role === 'arm') { if (blocked) stopped.add(cell.arm); if (stopped.has(cell.arm)) continue; }
      else { if (blocked) beamStopped = true; if (beamStopped) continue; }
    }
    result.push(at);
  }
  return result;
}
function cancelPair(world, fish, now) {
  const r = world.breedingState(fish); if (!r) return;
  cancelBreeding(world.data, r, now, 'legend');
  for (const id of [r.male, r.female]) if (world.data.fishes[id]) { world.data.fishes[id].cx = world.data.fishes[id].cy = 0; }
}
function story(world, kind, fish, at, s) { recordStory(world, kind, fish, at, { legendary: s.id, legendSeed: s.seed, legendSlot: s.slot }); }
function burn(world, cell, proof, transition) {
  world.data.legends.burns[cell.id] ||= proof;
  if (cell.kind === 'burn' && cell.path.some(p => p.reason === 'legendBurn')) return;
  transition(cell, { kind: 'burn', entity: '' }, { ...proof, id: `legend-burn:${cell.id}:${proof.seed}:${proof.slot}`, t: proof.at, reason: 'legendBurn', legendReason: proof.reason }); world.dirty = true;
}
function injure(world, fish, at, s, transition) {
  const f = world.data.fishes[fish]; if (!f) return;
  cancelPair(world, fish, at);
  const cells = world.fishCells(fish), parts = components(cells).sort((a, b) => b.length - a.length || hash(`${s.id}:${a.map(c => c.id).sort()[0]}`) - hash(`${s.id}:${b.map(c => c.id).sort()[0]}`));
  const kept = parts[0]?.length >= 2 ? new Set(parts[0].map(c => c.id)) : new Set();
  for (const c of cells) if (!kept.has(c.id)) { const p = cellPosition(f, c); transition(c, { kind: 'food', entity: '', x: wrapX(p.x), y: p.y, born: at, fall: 0 }, { id: `legend-shed:${s.id}:${fish}:${at}`, t: at, reason: 'shed' }); }
  if (!kept.size) { world.data.legends.deaths[fish] ||= { seed: s.seed, slot: s.slot, at, reason: 'atomic' }; delete world.data.fishes[fish]; recordStory(world, 'depart', fish, at); }
  else story(world, 'atomicSurvivor', fish, at, s);
  world.foodRevision++; world.dirty = true;
}
export function enforceLegends(world, now, transition) {
  const state = world.data.legends; if (!state) return;
  for (const [id, proof] of Object.entries(state.burns)) if (world.data.chars[id]) burn(world, world.data.chars[id], proof, transition);
  for (const [id, death] of Object.entries(state.deaths)) if (world.data.fishes[id]) {
    cancelPair(world, id, death.at);
    const s = legendSchedule(world.data.roots, death.seed, death.slot);
    for (const c of world.fishCells(id)) {
      const p = cellPosition(world.data.fishes[id], c);
      if (death.reason === 'cthulhu') burn(world, c, { ...death, fish: id, x: wrapX(p.x), y: p.y }, transition);
      else transition(c, { kind: 'food', entity: '', x: wrapX(p.x), y: p.y, born: death.at, fall: 0 }, { id: `legend-remnant:${s.id}:${c.id}`, t: death.at, reason: 'shed' });
    }
    delete world.data.fishes[id]; recordStory(world, 'depart', id, death.at); world.dirty = true;
  }
}
function settleCaptures(world, now, transition) {
  for (const e of Object.values(world.data.legends.events)) {
    const s = legendSchedule(world.data.roots, e.seed, e.slot); if (s?.kind !== 'cthulhu') continue;
    for (const [arm, c] of Object.entries(e.arms)) {
      if (now >= s.ends) {
        for (const id of c.cells) if (world.data.chars[id]?.kind === 'fish' && world.data.chars[id].entity === c.fish) burn(world, world.data.chars[id], { seed: s.seed, slot: s.slot, at: s.ends, reason: 'cthulhu', arm: +arm, fish: c.fish, x: c.x, y: c.y }, transition);
        world.data.legends.deaths[c.fish] ||= { seed: s.seed, slot: s.slot, at: s.ends, reason: 'cthulhu' };
        if (world.data.fishes[c.fish]) { delete world.data.fishes[c.fish]; story(world, 'cthulhuDepart', c.fish, s.ends, s); recordStory(world, 'depart', c.fish, s.ends); world.dirty = true; }
      } else if (world.data.fishes[c.fish]) {
        cancelPair(world, c.fish, now); const f = world.data.fishes[c.fish]; Object.assign(f, c.pose, { cx: 0, cy: 0, posAt: now });
      }
    }
  }
}
export function settleLegendary(world, now, transition) { settleCaptures(world, now, transition); enforceLegends(world, now, transition); }
export function ghostRoll(seed, slot, minute) { return (hash(`maggot:${seed}:${slot}:${minute}`) >>> 8) % 100 === 0; }
export function ghostIndex(seed, slot, minute, prior = []) { const order = modelCells('ship').sort((a, b) => hash(`plank:${seed}:${slot}:${a.index}`) - hash(`plank:${seed}:${slot}:${b.index}`) || a.index - b.index); return order[minute - 1]?.index ?? null; }
export function ghostSource(roots, source) {
  const s = source && legendSchedule(roots, source.seed, source.slot); if (s?.kind !== 'ship' || !Number.isInteger(source.minute) || source.minute < 1 || source.minute > 60 || !ghostRoll(s.seed, s.slot, source.minute) || !Array.isArray(source.prior) || source.prior.length >= 60) return null;
  const prior = []; let last = 0;
  for (const d of source.prior) { if (!Number.isInteger(d.minute) || d.minute <= last || d.minute >= source.minute || !ghostRoll(s.seed, s.slot, d.minute) || d.index !== ghostIndex(s.seed, s.slot, d.minute, prior)) return null; prior.push(d); last = d.minute; }
  if (source.index !== ghostIndex(s.seed, s.slot, source.minute, prior)) return null;
  const born = s.started + source.minute * 60000, p = legendPosition(roots, s, born), plank = modelCells('ship').find(c => c.index === source.index);
  return { id: `worm:${s.id}:${source.minute}`, x: wrapX(Math.round(p.x + plank.x)), y: 0, born, ch: '蛆', color: '#b4c794' };
}
export function validGhostCell(c, roots) {
  const source = ghostSource(roots, c?.ghost); return !!source && c.id === source.id && c.created === source.born && c.payer === '' && Array.isArray(c.path) && ['food', 'fish', 'scene', 'burn'].includes(c.kind) && (['scene', 'burn'].includes(c.kind) || c.color === source.color);
}
export function processLegends(world, now, transition) {
  const state = world.data.legends ||= newLegends(world.data.tick), elapsed = now - state.at, continuous = elapsed > 0 && elapsed <= 2500;
  enforceLegends(world, now, transition);
  const seed = world.data.terrain.seed, slot = Math.floor(now / LEGENDS.period), schedule = legendSchedule(world.data.roots, seed, slot);
  if ((state.through[seed] ?? -1) < slot) {
    state.through[seed] = slot; const lastEnd = Math.max(0, ...Object.values(state.events).map(e => legendSchedule(world.data.roots, e.seed, e.slot)?.ends || 0));
    if (world.ambient && continuous && schedule && now - schedule.started < LEGENDS.opening && !activeLegend(world.data, now) && now >= lastEnd + LEGENDS.cooldown) state.events[schedule.id] = { seed, slot, at: now, arms: {}, minute: 0, drops: [] };
    world.dirty = true;
  }
  const events = Object.values(state.events).map(e => ({ e, s: legendSchedule(world.data.roots, e.seed, e.slot) })).filter(({ e, s }) => s && now >= e.at && state.at < s.ends).sort((a, b) => a.s.started - b.s.started || a.s.id.localeCompare(b.s.id));
  if (continuous && events.length) {
    const { e, s } = events[0], scenery = world.sceneryMap(), fishMap = world.fishMap(), until = Math.min(now, s.ends - 1), hurt = new Map();
    const from = Math.max(e.at, state.at + 1), samples = [];
    for (let sample = from; sample <= until; sample += 100) samples.push(Math.round(sample));
    if (until >= from && samples.at(-1) !== Math.round(until)) samples.push(Math.round(until));
    for (const t of samples) {
      const age = t - s.started; if (age < LEGENDS.warning || s.kind === 'ship') continue;
      for (const cell of legendGeometry(world.data, e, t, scenery)) {
        if (!['arm', 'beam'].includes(cell.role)) continue; const fish = fishMap.get(key(cell.x, cell.y)); if (!fish || !world.data.fishes[fish]) continue;
        if (cell.role === 'arm' && !e.arms[cell.arm] && !capturedFish(world.data, fish, t) && !Object.values(e.arms).some(c => c.fish === fish)) {
          const f = world.data.fishes[fish]; e.arms[cell.arm] = { fish, at: t, x: cell.x, y: cell.y, pose: { x: f.x, y: f.y, facing: f.facing }, cells: world.fishCells(fish).map(c => c.id).sort() }; cancelPair(world, fish, t); story(world, 'captured', fish, t, s); world.dirty = true;
        }
        if (cell.role === 'beam') for (const c of world.fishCells(fish)) { const p = cellPosition(world.data.fishes[fish], c); if (key(p.x, p.y) !== key(cell.x, cell.y)) continue; burn(world, c, { seed: s.seed, slot: s.slot, at: t, reason: 'atomic', attack: cell.attack, fish, x: cell.x, y: cell.y }, transition); hurt.set(fish, t); }
      }
    }
    for (const [fish, at] of hurt) injure(world, fish, at, s, transition);
    if (s.kind === 'ship') {
      const through = Math.min(60, Math.floor((now - s.started) / 60000));
      for (let minute = e.minute + 1; minute <= through; minute++) {
        const at = s.started + minute * 60000; if (at <= state.at || !ghostRoll(s.seed, s.slot, minute)) continue;
        const ghost = { seed: s.seed, slot: s.slot, minute, prior: e.drops.map(d => ({ ...d })), index: ghostIndex(s.seed, s.slot, minute, e.drops) }, source = ghostSource(world.data.roots, ghost);
        if (source && !world.data.chars[source.id]) { world.data.chars[source.id] = { ...source, created: at, payer: '', kind: 'food', entity: '', fall: 0, path: [], ghost }; e.drops.push({ minute, index: ghost.index }); world.dirty = true; }
      }
      e.minute = through;
    }
  }
  // A sleep skips new attacks/drops, but existing bindings retain their deadline.
  if (!continuous) for (const e of Object.values(state.events)) { const s = legendSchedule(world.data.roots, e.seed, e.slot); if (s?.kind === 'ship') e.minute = Math.max(e.minute, Math.min(60, Math.floor((now - s.started) / 60000))); }
  settleCaptures(world, now, transition); enforceLegends(world, now, transition);
  state.at = now; state.events = Object.fromEntries(Object.entries(state.events).sort(([a, x], [b, y]) => y.at - x.at || a.localeCompare(b)).slice(0, LEGENDS.limit));
}
const select = (a, b) => !a ? b : !b ? a : JSON.stringify(a) <= JSON.stringify(b) ? a : b;
export function mergeLegends(a, b, now) {
  a ||= newLegends(now); b ||= newLegends(now); const result = newLegends(Math.max(a.at, b.at));
  for (const seed of new Set([...Object.keys(a.through), ...Object.keys(b.through)])) result.through[seed] = Math.max(a.through[seed] ?? -1, b.through[seed] ?? -1);
  for (const id of new Set([...Object.keys(a.events), ...Object.keys(b.events)])) {
    const x = a.events[id], y = b.events[id], chosen = select(x, y), arms = {};
    for (const arm of new Set([...Object.keys(x?.arms || {}), ...Object.keys(y?.arms || {})])) {
      const left = x?.arms[arm], right = y?.arms[arm];
      arms[arm] = left?.fish === right?.fish && (left?.migratedAt || 0) !== (right?.migratedAt || 0) ? (left?.migratedAt || 0) > (right?.migratedAt || 0) ? left : right : select(left, right);
    }
    const used = new Set(); for (const arm of Object.keys(arms).sort()) { if (used.has(arms[arm].fish)) delete arms[arm]; else used.add(arms[arm].fish); }
    const drops = new Map(); for (const d of [...x?.drops || [], ...y?.drops || []]) drops.set(d.minute, select(drops.get(d.minute), d));
    result.events[id] = { ...chosen, arms, minute: Math.max(x?.minute || 0, y?.minute || 0), drops: [...drops.values()].sort((p, q) => p.minute - q.minute) };
  }
  result.events = Object.fromEntries(Object.entries(result.events).sort(([a, x], [b, y]) => y.at - x.at || a.localeCompare(b)).slice(0, LEGENDS.limit));
  for (const field of ['burns', 'deaths']) for (const id of new Set([...Object.keys(a[field]), ...Object.keys(b[field])])) result[field][id] = { ...select(a[field][id], b[field][id]) };
  return result;
}
export function validLegendStory(r, roots) {
  const s = legendSchedule(roots, r.legendSeed, r.legendSlot); if (!s || r.legendary !== s.id) return false;
  return r.kind === 'shipMeal' ? s.kind === 'ship' && r.at >= s.started + 60000 : r.kind === 'cthulhuDepart' ? s.kind === 'cthulhu' && r.at === s.ends : r.kind === 'captured' ? s.kind === 'cthulhu' && r.at >= s.started + LEGENDS.warning && r.at < s.ends : r.kind === 'atomicSurvivor' && s.kind === 'godzilla' && atomicPhase((r.at - s.started) / 1000).firing;
}
export function validLegends(state, sources, now = Date.now() + 60000) {
  if (state === undefined) return true;
  const map = (o, max) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length <= max, time = n => Number.isFinite(n) && n >= 0 && n <= now;
  const fish = id => typeof id === 'string' && (sources.ops?.[id]?.kind === 'fish' || id.startsWith('born:') && sources.breeding?.[id.slice(5)]?.status === 'born' && sources.breeding[id.slice(5)].baby?.id === id);
  if (!state || !time(state.at) || !map(state.through, 100000) || !map(state.events, LEGENDS.limit) || !map(state.burns, 1000000) || !map(state.deaths, 100000)) return false;
  for (const [seed, slot] of Object.entries(state.through)) if (!Object.hasOwn(sources.roots, seed) || !Number.isInteger(slot) || slot < 0 || slot > Math.floor(now / LEGENDS.period)) return false;
  for (const [id, e] of Object.entries(state.events)) {
    const s = e && legendSchedule(sources.roots, e.seed, e.slot);
    if (!s || id !== s.id || !time(e.at) || e.at < s.started || e.at >= s.started + LEGENDS.opening || !map(e.arms, 8) || !Number.isInteger(e.minute) || e.minute < 0 || e.minute > 60 || !Array.isArray(e.drops) || e.drops.length > 60) return false;
    if (s.kind !== 'cthulhu' && Object.keys(e.arms).length || s.kind !== 'ship' && (e.minute || e.drops.length)) return false;
    const used = new Set();
    for (const [arm, c] of Object.entries(e.arms)) {
      if (!/^[0-7]$/.test(arm) || !c || !fish(c.fish) || used.has(c.fish) || !time(c.at) || c.at < s.started + LEGENDS.warning || c.at >= s.ends || !Number.isInteger(c.x) || c.x < 0 || c.x >= 1000 || !Number.isInteger(c.y) || c.y < 0 || c.y > 100 || !c.pose || !Number.isInteger(c.pose.x) || c.pose.x < 0 || c.pose.x >= 1000 || !Number.isInteger(c.pose.y) || c.pose.y < 0 || c.pose.y > 100 || ![1, -1].includes(c.pose.facing) || !Array.isArray(c.cells) || c.cells.length < 2 || c.cells.length > 10000 || new Set(c.cells).size !== c.cells.length || !c.cells.every(id => typeof id === 'string' && id.length < 240)) return false;
      used.add(c.fish);
      if (c.migratedAt !== undefined && (!time(c.migratedAt) || c.migratedAt < c.at)) return false;
    }
    const prior = []; for (const d of e.drops) { if (!ghostSource(sources.roots, { seed: e.seed, slot: e.slot, minute: d.minute, index: d.index, prior }) || d.minute > e.minute) return false; prior.push(d); }
  }
  for (const [id, p] of Object.entries(state.burns)) { const s = p && legendSchedule(sources.roots, p.seed, p.slot); if (!s || typeof id !== 'string' || id.length > 240 || !fish(p.fish) || !time(p.at) || !Number.isInteger(p.x) || p.x < 0 || p.x >= 1000 || !Number.isInteger(p.y) || p.y < 0 || p.y > 100 || !['atomic', 'cthulhu'].includes(p.reason) || (p.reason === 'cthulhu' ? s.kind !== 'cthulhu' || p.at !== s.ends : s.kind !== 'godzilla' || !atomicPhase((p.at - s.started) / 1000).firing || p.attack !== atomicPhase((p.at - s.started) / 1000).attack)) return false; }
  for (const [id, p] of Object.entries(state.deaths)) { const s = p && legendSchedule(sources.roots, p.seed, p.slot); if (!s || !fish(id) || !time(p.at) || (p.reason === 'cthulhu' ? s.kind !== 'cthulhu' || p.at !== s.ends : p.reason !== 'atomic' || s.kind !== 'godzilla' || !atomicPhase((p.at - s.started) / 1000).firing)) return false; }
  return true;
}
