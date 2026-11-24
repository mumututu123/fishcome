import { wrapX, deltaX, worldKey } from './geography.js';
import { EVENTS, updateEvents, validEvent, eventSchedule, eventNarration, eventMotion } from './random-events.js';

// Ambient life has no player commands. All randomness is tied to world/fish IDs.
export const LIFE = Object.freeze({ weatherPeriod: 180000, weatherDuration: 55000, familiar: 45, haunt: 45, reunion: 180000, storyLimit: 512, bondLimit: 4096, planktonLife: 75000 });
const TYPES = ['quiet', 'social', 'deep', 'curious'];
const HABITS = { quiet: '喜欢独自慢慢游', social: '喜欢往热闹的地方凑', deep: '喜欢在海底附近闲逛', curious: '喜欢绕着造景探索' };
const KINDS = new Set(['arrive', 'meal', 'grass', 'friend', 'reunion', 'haunt', 'birth', 'depart', 'revisit', 'rediscover', 'ambient']);
const hash = text => { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619); return n >>> 0; };
const choose = (a, b) => !a ? b : !b ? a : JSON.stringify(a) < JSON.stringify(b) ? a : b;
const trim = (map, limit, score = r => r.at) => Object.fromEntries(Object.entries(map).sort(([a, x], [b, y]) => score(y) - score(x) || a.localeCompare(b)).slice(0, limit));
const distance = (a, b) => Math.max(Math.abs(deltaX(a.x, b.x)), Math.abs(a.y - b.y));
export const personality = id => TYPES[hash(`habit:${id}`) % TYPES.length];
export const personalityText = id => HABITS[personality(id)];
export const lightDepth = weather => 18 + hash(`light:${weather.seed}:${weather.slot}`) % 22;
export const pairKey = (a, b) => [a, b].sort().join('|');
export function newLife(now) { return { at: now, bonds: {}, places: {}, haunts: {}, stories: {}, bloomThrough: {}, events: {}, eventThrough: {} }; }
function state(world, now) { return world.data.life ||= newLife(now); }
export function weatherAt(data, now = data.tick) {
  const seed = data.terrain?.seed || Object.keys(data.roots).sort()[0], slot = Math.floor(now / LIFE.weatherPeriod), started = slot * LIFE.weatherPeriod;
  const type = ['calm', 'current', 'light', 'plankton'][hash(`weather:${seed}:${slot}`) % 4], active = now >= started && now < started + LIFE.weatherDuration && type !== 'calm' && !(type === 'plankton' && started < data.roots[seed]);
  return { seed, slot, started, type: active ? type : 'calm', active, direction: hash(`current:${seed}:${slot}`) % 2 ? 1 : -1, label: active ? { current: '一阵轻轻的水流', light: '光带正在海里漫游', plankton: '浮游食物路过这片海' }[type] : '海里风平浪静' };
}
export function planktonSource(data, seed, slot, index) {
  const born = slot * LIFE.weatherPeriod, weather = weatherAt({ ...data, terrain: { seed } }, born);
  if (!Number.isInteger(slot) || slot < 0 || !Number.isInteger(index) || index < 0 || index >= 10 || data.roots[seed] === undefined || born < data.roots[seed] || weather.type !== 'plankton') return null;
  const id = `plankton:${seed}:${slot}:${index}`, r = hash(id);
  return { id, ch: '*', color: '#d8ebb1', x: r % 1000, y: 5 + Math.floor(r / 1000) % 24, born };
}
export function validPlankton(cell, roots) {
  const source = cell?.plankton, initial = source && planktonSource({ roots }, source.seed, source.slot, source.index);
  const eaten = cell?.path?.some(event => event.reason === 'eat');
  return !!initial && cell.id === initial.id && cell.created === initial.born && cell.payer === '' && (['scene', 'burn'].includes(cell.kind) && eaten || cell.color === initial.color) && ['burn', 'fish', 'food', 'scene'].includes(cell.kind) && (eaten || (cell.kind !== 'scene' && cell.ch === initial.ch && cell.born === initial.born));
}
export const freshPlankton = cell => !!cell.plankton && !cell.path.some(event => event.reason === 'eat');
export function recordStory(world, kind, fish, at, extra = {}) {
  const life = state(world, at), id = `${kind}:${fish}${extra.other ? ':' + extra.other : ''}${extra.scene ? ':' + extra.scene : ''}${kind === 'reunion' ? ':' + Math.floor(at / 600000) : ''}${extra.visit !== undefined ? ':' + extra.visit : ''}${extra.event ? ':' + extra.event : ''}`;
  const story = { id, kind, fish, at, ...extra };
  life.stories[id] = choose(life.stories[id], story);
  if (Object.keys(life.stories).length > LIFE.storyLimit) life.stories = trim(life.stories, LIFE.storyLimit); world.dirty = true;
}
function clearLine(a, b, scenery) {
  const dx = deltaX(b.x, a.x), dy = b.y - a.y, steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  for (let i = 1; i < steps; i++) if (scenery.has(worldKey(Math.round(a.x + dx * i / steps), Math.round(a.y + dy * i / steps)))) return false;
  return true;
}
function indexPoints(points) {
  const bins = new Map();
  for (const p of points) { const key = `${Math.floor(wrapX(p.x) / 10)},${Math.floor(p.y / 10)}`; if (!bins.has(key)) bins.set(key, []); bins.get(key).push(p); }
  return p => { const found = []; for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) found.push(...bins.get(`${(Math.floor(wrapX(p.x) / 10) + dx + 100) % 100},${Math.floor(p.y / 10) + dy}`) || []); return found; };
}
export function lifeContext(world, now, scenery, groups) {
  const points = new Map();
  for (const [id, cells] of groups) { const f = world.data.fishes[id]; if (!f || !cells.length) continue; const xs = cells.map(c => c.x), ys = cells.map(c => c.y); points.set(id, { id, x: wrapX(f.x + f.facing * (Math.min(...xs) + Math.max(...xs)) / 2), y: f.y + (Math.min(...ys) + Math.max(...ys)) / 2 }); }
  const nearby = indexPoints(points.values()), neighbors = new Map(), scenes = new Map();
  const scenePoints = [...scenery.values()].filter(({ scene }) => world.data.ops[scene.id]?.kind === 'scene').map(({ scene, cell }) => ({ id: scene.id, x: wrapX(scene.x + cell.x), y: scene.y + cell.y })), nearScene = indexPoints(scenePoints);
  for (const p of points.values()) {
    neighbors.set(p.id, nearby(p).filter(q => q.id !== p.id && distance(p, q) <= 12 && clearLine(p, q, scenery)).sort((a, b) => distance(p, a) - distance(p, b) || a.id.localeCompare(b.id)));
    const spots = nearScene(p).filter(q => distance(p, q) <= 16).sort((a, b) => distance(p, a) - distance(p, b) || a.id.localeCompare(b.id)); if (spots.length) scenes.set(p.id, spots[0]);
  }
  const school = new Map(), taken = new Set(), slot = Math.floor(now / 60000);
  if (now % 60000 < 18000) for (const p of [...points.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (taken.has(p.id) || world.breedingState(p.id)) continue;
    const group = [p, ...neighbors.get(p.id).filter(q => !taken.has(q.id) && !world.breedingState(q.id))].slice(0, 5);
    if (group.length < 3) continue;
    const r = hash(`school:${p.id}:${slot}`), motion = { dx: r % 2 ? 1 : -1, dy: [0, 0, -1, 1][Math.floor(r / 2) % 4], leader: p.id };
    for (const q of group) { taken.add(q.id); school.set(q.id, motion); }
  }
  const memories = new Map();
  for (const [id, home] of Object.entries(world.data.life?.haunts || {})) {
    const p = points.get(id); if (!p) continue;
    const spot = nearScene(p).filter(q => q.id === home.scene && distance(p, q) <= 7).sort((a, b) => distance(p, a) - distance(p, b) || a.x - b.x || a.y - b.y)[0];
    memories.set(id, { near: distance(p, home) <= 7, exists: nearScene(home).some(q => q.id === home.scene && distance(home, q) <= 7), spot });
  }
  return { points, neighbors, scenes, memories, school, weather: weatherAt(world.data, now) };
}
export function updateLife(world, now, context) {
  const life = state(world, now), elapsed = now - life.at;
  if (elapsed < 1000 && elapsed >= 0) return;
  const dt = elapsed > 0 && elapsed <= 2500 ? Math.min(1, elapsed / 1000) : 0, pairs = new Set();
  for (const [id, others] of context.neighbors) for (const other of others) {
    const key = pairKey(id, other.id); if (pairs.has(key)) continue; pairs.add(key);
    const [a, b] = [id, other.id].sort(), old = life.bonds[key], continuous = old && now - old.lastNear <= 2500;
    const seconds = Math.min(3600, (old?.seconds || 0) + dt);
    if ((old?.seconds || 0) < LIFE.familiar && seconds >= LIFE.familiar) recordStory(world, 'friend', a, now, { other: b });
    if (dt > 0 && old?.seconds >= LIFE.familiar && now - old.lastNear >= LIFE.reunion) recordStory(world, 'reunion', a, now, { other: b });
    life.bonds[key] = { a, b, seconds, at: now, lastNear: now, run: continuous ? Math.min(120, old.run + dt) : 0 };
  }
  for (const [id, spot] of context.scenes) {
    if (distance(context.points.get(id), spot) > 7) continue;
    const old = life.places[id], seconds = Math.min(3600, (old?.scene === spot.id ? old.seconds : 0) + dt);
    life.places[id] = { scene: spot.id, seconds, at: now };
    if ((old?.scene === spot.id ? old.seconds : 0) < LIFE.haunt && seconds >= LIFE.haunt) recordStory(world, 'haunt', id, now, { scene: spot.id });
    life.haunts ||= {};
    if (seconds >= LIFE.haunt && !life.haunts[id]) life.haunts[id] = { scene: spot.id, x: spot.x, y: spot.y, at: now, away: false, visited: false, found: false };
  }
  // A remembered place survives moving/deleting its scenery. Only actual return
  // trips produce stories; sleeping or standing beside a removal does not.
  if (dt > 0) for (const [id, memory] of context.memories || []) {
    const home = life.haunts[id];
    if (!memory.exists && home.displaced === undefined) { home.displaced = now; home.away = !memory.near; home.visited = home.found = false; }
    if (home.displaced === undefined) continue;
    if (!memory.near) home.away = true;
    if (home.away && memory.near && !memory.exists && !home.visited) { recordStory(world, 'revisit', id, now, { scene: home.scene, visit: home.displaced }); home.visited = true; }
    if (memory.exists && memory.spot && !home.found) { recordStory(world, 'rediscover', id, now, { scene: home.scene, visit: home.displaced }); home.found = true; }
    if (memory.spot && !memory.exists && !home.found) { recordStory(world, 'rediscover', id, now, { scene: home.scene, visit: home.displaced }); home.found = true; }
    if (memory.exists) { delete home.displaced; home.away = home.visited = home.found = false; }
    home.at = now; world.dirty = true;
  }
  updateEvents(world, now, context, dt > 0, recordStory);
  life.at = now;
  life.bonds = trim(life.bonds, LIFE.bondLimit);
  for (const id of Object.keys(life.places)) if (!world.data.fishes[id] || !world.data.scenes[life.places[id].scene]) delete life.places[id];
  life.haunts = trim(Object.fromEntries(Object.entries(life.haunts || {}).filter(([id]) => world.data.fishes[id])), LIFE.bondLimit);
}
export function idleMotion(world, fish, now, context, center) {
  const life = state(world, now), neighbors = context.neighbors.get(fish.id) || [], phase = Math.floor((now - fish.created) / 12000), r = hash(`${fish.id}:${phase}`);
  let dx = [-1, 0, 1][r % 3], dy = [-1, 0, 1][Math.floor(r / 3) % 3];
  if (now - fish.lastFed >= 86400000) return { dx, dy };
  if (!world.breedingState(fish.id)) { const motion = eventMotion(world.data, fish.id, now, context); if (motion) return motion; }
  const school = context.school.get(fish.id); if (school) return school;
  const familiar = neighbors.find(q => life.bonds[pairKey(fish.id, q.id)]?.seconds >= LIFE.familiar);
  if (familiar && now % 180000 < 45000) {
    const pair = pairKey(fish.id, familiar.id), motion = hash(`companion:${pair}:${Math.floor(now / 12000)}`);
    return { dx: motion % 2 ? 1 : -1, dy: [0, 0, -1, 1][Math.floor(motion / 2) % 4] };
  }
  const trait = personality(fish.id), spot = context.scenes.get(fish.id), point = context.points.get(fish.id) || center;
  if (trait === 'quiet') { if (neighbors.length && phase % 3 !== 0) { dx = -Math.sign(deltaX(neighbors[0].x, point.x)); dy = -Math.sign(neighbors[0].y - point.y); } else if (phase % 3 === 0) dx = dy = 0; }
  if (trait === 'social' && neighbors.length && phase % 3 !== 0) { dx = Math.sign(deltaX(neighbors[0].x, point.x)); dy = distance(point, neighbors[0]) > 5 ? Math.sign(neighbors[0].y - point.y) : 0; }
  if (trait === 'deep' && phase % 3 !== 0) dy = Math.sign(world.floorAt(point.x) - 10 - point.y);
  if (trait === 'curious' && spot && phase % 3 !== 0) { const near = distance(point, spot) <= 5; dx = near ? [1, 0, -1, 0][phase % 4] : Math.sign(deltaX(spot.x, point.x)); dy = near ? [0, 1, 0, -1][phase % 4] : Math.sign(spot.y - point.y); }
  const place = life.places[fish.id];
  if (place?.seconds >= LIFE.haunt && spot?.id === place.scene && phase % 4 === 1 && distance(point, spot) > 5) { dx = Math.sign(deltaX(spot.x, point.x)); dy = Math.sign(spot.y - point.y); }
  if (place?.seconds >= LIFE.haunt && spot?.id === place.scene && phase % 4 === 0 && distance(point, spot) <= 6) dx = dy = 0;
  const home = life.haunts?.[fish.id];
  if (home?.displaced !== undefined && !home.visited && phase % 8 < 2) { dx = Math.sign(deltaX(home.x, point.x)); dy = Math.sign(home.y - point.y); }
  if (context.weather.type === 'current' && phase % 3 === 0) dx = context.weather.direction;
  if (context.weather.type === 'light' && phase % 3 === 0) dy = Math.sign(lightDepth(context.weather) - point.y);
  return { dx, dy };
}
export function spawnPlankton(world, now) {
  const life = state(world, now), weather = weatherAt(world.data, now);
  if (weather.type !== 'plankton' || (life.bloomThrough[weather.seed] ?? -1) >= weather.slot) return;
  life.bloomThrough[weather.seed] = weather.slot;
  const occupied = new Set([...world.fishMap().keys(), ...world.sceneryMap().keys(), ...Object.values(world.data.chars).filter(c => ['food', 'seaweed'].includes(c.kind)).map(c => worldKey(c.x, c.y))]);
  for (let index = 0; index < 10; index++) {
    const initial = planktonSource(world.data, weather.seed, weather.slot, index); if (!initial || world.data.chars[initial.id] || !world.waterAt(initial.x, initial.y) || occupied.has(worldKey(initial.x, initial.y))) continue;
    world.data.chars[initial.id] = { ...initial, created: initial.born, payer: '', kind: 'food', entity: '', fall: 0, path: [], plankton: { seed: weather.seed, slot: weather.slot, index } }; world.dirty = true;
  }
}
export function validateLife(life, sources, now = Date.now() + 60000) {
  if (life === undefined) return true;
  const map = (m, max) => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length <= max;
  const time = n => Number.isFinite(n) && n >= 0 && n <= now;
  const origins = new Set([...Object.values(sources.ops).filter(op => op.kind === 'fish').map(op => op.id), ...Object.values(sources.breeding || {}).filter(r => r.status === 'born').map(r => r.baby.id)]);
  const fish = id => origins.has(id);
  if (!life || !time(life.at) || !map(life.bonds, LIFE.bondLimit) || !map(life.places, 100000) || !map(life.stories, LIFE.storyLimit) || !map(life.bloomThrough, 100000)) return false;
  for (const [key, r] of Object.entries(life.bonds)) if (!r || key !== pairKey(r.a, r.b) || r.a >= r.b || !fish(r.a) || !fish(r.b) || !time(r.at) || !time(r.lastNear) || r.lastNear > r.at || !Number.isFinite(r.seconds) || r.seconds < 0 || r.seconds > 3600 || !Number.isFinite(r.run) || r.run < 0 || r.run > 120) return false;
  for (const [id, r] of Object.entries(life.places)) if (!r || !fish(id) || sources.ops[r.scene]?.kind !== 'scene' || !time(r.at) || !Number.isFinite(r.seconds) || r.seconds < 0 || r.seconds > 3600) return false;
  if (life.haunts !== undefined && !map(life.haunts, LIFE.bondLimit)) return false;
  for (const [id, r] of Object.entries(life.haunts || {})) if (!r || !fish(id) || sources.ops[r.scene]?.kind !== 'scene' || !Number.isFinite(r.x) || r.x < 0 || r.x >= 1000 || !Number.isFinite(r.y) || r.y < 0 || r.y > 101 || !time(r.at) || (r.displaced !== undefined && (!time(r.displaced) || r.displaced > r.at)) || ['away', 'visited', 'found'].some(k => typeof r[k] !== 'boolean')) return false;
  for (const [id, r] of Object.entries(life.stories)) if (!r || id !== r.id || !KINDS.has(r.kind) || !fish(r.fish) || (r.other && !fish(r.other)) || (r.parents && (!Array.isArray(r.parents) || r.parents.length !== 2 || !r.parents.every(fish))) || (r.scene && sources.ops[r.scene]?.kind !== 'scene') || (['revisit', 'rediscover'].includes(r.kind) && (!r.scene || !time(r.visit) || r.visit > r.at)) || !time(r.at)) return false;
  for (const [seed, slot] of Object.entries(life.bloomThrough)) if (sources.roots[seed] === undefined || !Number.isInteger(slot) || slot < 0 || slot > Math.floor(now / LIFE.weatherPeriod)) return false;
  if (life.events !== undefined && !map(life.events, EVENTS.limit) || life.eventThrough !== undefined && !map(life.eventThrough, 100000)) return false;
  for (const [id, event] of Object.entries(life.events || {})) if (id !== event?.id || !validEvent(event, sources.roots, fish, now, sources.chars)) return false;
  for (const [seed, slot] of Object.entries(life.eventThrough || {})) if (!Object.hasOwn(sources.roots, seed) || !Number.isInteger(slot) || slot < 0 || slot > Math.floor(now / EVENTS.period)) return false;
  for (const story of Object.values(life.stories)) if (story.kind === 'ambient') {
    const schedule = eventSchedule(sources.roots, story.eventSeed, story.eventSlot);
    if (!schedule || story.event !== schedule.id || story.at < schedule.started || story.at >= schedule.started + EVENTS.opening) return false;
  }
  return true;
}
export function mergeLife(left, right, data) {
  const a = left || newLife(data.tick), b = right || newLife(data.tick), result = newLife(Math.max(a.at, b.at));
  for (const field of ['bonds', 'places']) {
    for (const id of new Set([...Object.keys(a[field]), ...Object.keys(b[field])])) {
      const x = a[field][id], y = b[field][id], fresh = !x ? y : !y ? x : x.at === y.at ? choose(x, y) : x.at > y.at ? x : y;
      result[field][id] = { ...fresh, seconds: field === 'bonds' || x?.scene === y?.scene ? Math.max(x?.seconds || 0, y?.seconds || 0) : fresh.seconds };
    }
  }
  result.bonds = trim(result.bonds, LIFE.bondLimit);
  for (const [id, r] of Object.entries(result.places)) if (!data.fishes[id] || !data.scenes[r.scene]) delete result.places[id];
  for (const id of new Set([...Object.keys(a.haunts || {}), ...Object.keys(b.haunts || {})])) {
    const x = a.haunts?.[id], y = b.haunts?.[id];
    if (data.fishes[id]) result.haunts[id] = { ...(!x ? y : !y ? x : x.at === y.at ? choose(x, y) : x.at > y.at ? x : y) };
  }
  result.haunts = trim(result.haunts, LIFE.bondLimit);
  for (const id of new Set([...Object.keys(a.stories), ...Object.keys(b.stories)])) result.stories[id] = choose(a.stories[id], b.stories[id]);
  result.stories = trim(result.stories, LIFE.storyLimit);
  for (const seed of new Set([...Object.keys(a.bloomThrough), ...Object.keys(b.bloomThrough)])) result.bloomThrough[seed] = Math.max(a.bloomThrough[seed] ?? -1, b.bloomThrough[seed] ?? -1);
  for (const id of new Set([...Object.keys(a.events || {}), ...Object.keys(b.events || {})])) result.events[id] = { ...choose(a.events?.[id], b.events?.[id]) };
  result.events = trim(result.events, EVENTS.limit);
  for (const seed of new Set([...Object.keys(a.eventThrough || {}), ...Object.keys(b.eventThrough || {})])) result.eventThrough[seed] = Math.max(a.eventThrough?.[seed] ?? -1, b.eventThrough?.[seed] ?? -1);
  return result;
}
export function fishLifeText(data, id, now = data.tick) {
  const life = data.life, friends = Object.values(life?.bonds || {}).filter(r => (r.a === id || r.b === id) && r.seconds >= LIFE.familiar && data.fishes[r.a === id ? r.b : r.a]);
  const near = friends.find(r => now - r.lastNear <= 2500), place = life?.places[id];
  return { habit: personalityText(id), friend: near && now % 180000 < 45000 ? (near.a === id ? near.b : near.a) : null, company: friends.length ? `已经认识 ${friends.length} 条熟鱼${near ? '，熟鱼就在附近' : ''}` : '正慢慢认识这片海', haunt: place?.seconds >= LIFE.haunt && data.scenes[place.scene] ? '常在那处造景附近停留' : '' };
}
export function storiesFor(data, catalog, actor) {
  return Object.values(data.life?.stories || {}).filter(r => catalog.get(r.fish)?.actor === actor || catalog.get(r.other)?.actor === actor || r.parents?.some(id => catalog.get(id)?.actor === actor)).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
export function storyText(story, name) {
  const fish = `「${name(story.fish)}」`, other = story.other ? `「${name(story.other)}」` : '';
  if (story.kind === 'ambient') { const schedule = eventSchedule({ [story.eventSeed]: 0 }, story.eventSeed, story.eventSlot); return `${fish}${eventNarration(schedule?.kind)}`; }
  return { arrive: `${fish}开始了自己的鱼生`, meal: `${fish}第一次吃到了鱼食`, grass: `${fish}第一次吃到了草`, friend: `${fish}和${other}成了熟鱼`, reunion: `${fish}又遇见了熟鱼${other}${hash(`greeting:${story.id}`) % 3 === 0 ? '，它们用自己的暗号打了招呼' : ''}`, haunt: `${fish}有了常去的造景`, birth: `${fish}出生了，海里多了一位小邻居`, depart: `${fish}的鱼生结束了，记忆还在鱼谱里`, revisit: `${fish}来看看常去的地方，发现风景换了`, rediscover: `${fish}又认出了那处造景：原来你搬到这里了` }[story.kind];
}
export function returnStory(stories, since) {
  const rank = { birth: 8, friend: 6, reunion: 5, rediscover: 5, revisit: 4, grass: 4, haunt: 3, ambient: 3, meal: 2, depart: 1, arrive: 0 };
  return stories.filter(r => r.at > since).sort((a, b) => rank[b.kind] - rank[a.kind] || b.at - a.at || a.id.localeCompare(b.id))[0];
}
