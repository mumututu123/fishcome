import { bounds } from './engine.js';
import { fishNeighbors } from './life-neighbors.js';
import { WORLD_WIDTH, wrapX, deltaX, worldKey } from './geography.js';
import { EVENTS, activeEvent, updateEvents, validEvent, eventSchedule, eventNarration, eventMotion } from './random-events.js';
import { validLegendStory } from './legends.js';

// Ambient life has no player commands. All randomness is tied to world/fish IDs.
export const LIFE = Object.freeze({ weatherPeriod: 180000, weatherDuration: 55000, familiar: 45, haunt: 45, reunion: 180000, storyLimit: 512, bondLimit: 4096, planktonLife: 75000 });
const TYPES = ['quiet', 'social', 'deep', 'curious'];
const HABITS = { quiet: '喜欢独自慢慢游', social: '喜欢往热闹的地方凑', deep: '喜欢在海底附近闲逛', curious: '喜欢绕着造景探索' };
const KINDS = new Set(['arrive', 'meal', 'grass', 'friend', 'reunion', 'haunt', 'birth', 'depart', 'revisit', 'rediscover', 'ambient', 'captured', 'cthulhuDepart', 'atomicSurvivor', 'shipMeal', 'depressed', 'recovered']);
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
function makeStory(kind, fish, at, extra) {
  const id = `${kind}:${fish}${extra.other ? ':' + extra.other : ''}${extra.scene ? ':' + extra.scene : ''}${kind === 'reunion' ? ':' + Math.floor(at / 600000) : ''}${extra.visit !== undefined ? ':' + extra.visit : ''}${extra.event ? ':' + extra.event : ''}${extra.legendary ? ':' + extra.legendary : ''}`;
  return { id, kind, fish, at, ...extra };
}
export function recordStory(world, kind, fish, at, extra = {}) {
  const life = state(world, at), story = makeStory(kind, fish, at, extra);
  life.stories[story.id] = choose(life.stories[story.id], story);
  if (Object.keys(life.stories).length > LIFE.storyLimit) life.stories = trim(life.stories, LIFE.storyLimit);
  world.dirty = true;
}
function clearLine(a, b, blockedRows) {
  const dx = deltaX(b.x, a.x), dy = b.y - a.y, steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  for (let i = 1; i < steps; i++) {
    const row = blockedRows[Math.round(a.y + dy * i / steps)];
    if (!row) continue;
    const x = Math.round(a.x + dx * i / steps);
    const column = x < 0 ? x + WORLD_WIDTH : x >= WORLD_WIDTH ? x - WORLD_WIDTH : x;
    if (row[column]) return false;
  }
  return true;
}
function indexPoints(points) {
  const size = 10, columns = WORLD_WIDTH / size, bins = Array(columns);
  for (const p of points) {
    const column = Math.floor(wrapX(p.x) / size), row = Math.floor(p.y / size);
    const rows = bins[column] ??= new Map();
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(p);
  }
  return (p, radius) => {
    // Include boundary cells even when deltaX rounds a saved fractional coordinate.
    const extent = radius + Number.EPSILON * WORLD_WIDTH * 4;
    const x = wrapX(p.x), row = Math.floor(p.y / size);
    const firstColumn = Math.floor((x - extent) / size), lastColumn = Math.floor((x + extent) / size);
    const firstOffset = Math.floor((p.y - extent) / size) - row, lastOffset = Math.floor((p.y + extent) / size) - row;
    const found = [];
    for (let column = firstColumn; column <= lastColumn; column++) {
      const rows = bins[(column + columns) % columns];
      if (!rows) continue;
      for (let offset = firstOffset; offset <= lastOffset; offset++) {
        const bin = rows.get(row + offset);
        if (bin) for (const point of bin) found.push(point);
      }
    }
    return found;
  };
}
function schoolGeometry(world, layout, roster) {
  const points = new Map(), centers = [], ordered = [], ranks = new Map(), ordinary = new Set();
  let maxRadius = 0, rank = 0;
  for (const [id, cells] of layout.groups) {
    const fish = world.readFish(id);
    if (!fish || !cells.length) continue;
    const box = layout.hull(cells)?.bounds ?? bounds(cells);
    const halfWidth = (box.maxX - box.minX) / 2, halfHeight = (box.maxY - box.minY) / 2;
    maxRadius = Math.max(maxRadius, halfWidth, halfHeight);
    const point = { id, x: 0, y: 0, halfWidth, halfHeight };
    points.set(id, point);
    centers.push({ fish, point, localX: (box.minX + box.maxX) / 2, localY: (box.minY + box.maxY) / 2 });
  }
  for (const [id] of layout.ordered) {
    const point = points.get(id);
    if (!point) continue;
    if (ordered.length && ordered.at(-1).id.localeCompare(id)) rank++;
    ranks.set(point, rank);
    ordered.push(point);
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) ordinary.add(point);
  }
  return { roster, points, centers, ordered, ranks, ordinary, rank, maxRadius };
}

export function lifeContext(world, now, scenery, groups, sharedLayout) {
  const layout = sharedLayout || world.bodyLayout(groups), roster = world.fishValues();
  // Only the simulation loop lends its workspace to the next tick. Public
  // contexts requested by tools and the renderer retain their own positions.
  const geometry = sharedLayout?.school?.roster === roster ? sharedLayout.school : schoolGeometry(world, layout, roster);
  if (sharedLayout) sharedLayout.school = geometry;
  const { points, ordered, ranks, rank, ordinary, maxRadius } = geometry;
  for (const { fish, point, localX, localY } of geometry.centers) {
    point.x = wrapX(fish.x + fish.facing * localX);
    point.y = fish.y + localY;
  }
  const sortedNeighbors = new Map(), scenes = new Map();
  const sceneryPoints = [], blockedRows = [];
  for (const [key, { scene, cell }] of scenery) {
    sceneryPoints.push({ id: scene.id, x: wrapX(scene.x + cell.x), y: scene.y + cell.y });
    const comma = key.indexOf(','), x = Number(key.slice(0, comma)), y = Number(key.slice(comma + 1));
    if (Number.isInteger(x) && Number.isInteger(y)) (blockedRows[y] ??= new Uint8Array(WORLD_WIDTH))[x] = 1;
  }
  const nearScenery = sceneryPoints.length ? indexPoints(sceneryPoints) : null;
  const nearObstacle = new Set();
  for (const p of points.values()) {
    const spots = nearScenery?.(p, 16) || [];
    if (spots.length) nearObstacle.add(p);
    let closest, closestDistance = 16;
    for (const q of spots) {
      if (world.data.ops[q.id]?.kind !== 'scene') continue;
      const separation = distance(p, q);
      if (separation <= closestDistance && (!closest || separation < closestDistance || q.id.localeCompare(closest.id) < 0)) {
        closest = q;
        closestDistance = separation;
      }
    }
    if (closest) scenes.set(p.id, closest);
  }
  const { nearby, sorted, crowded } = fishNeighbors(geometry, (p, q) => clearLine(p, q, blockedRows));
  const neighbors = {
    get(id) {
      if (sortedNeighbors.has(id)) return sortedNeighbors.get(id);
      const p = points.get(id);
      if (!p) return;
      const result = sorted(p, nearObstacle.has(p));
      sortedNeighbors.set(id, result);
      return result;
    },
    *[Symbol.iterator]() { for (const id of points.keys()) yield [id, this.get(id)]; }
  };
  function crowdedNeighbor(p) {
    if (!p) return;
    const radius = Math.min(12, 2 + maxRadius + Math.max(p.halfWidth, p.halfHeight));
    return crowded(p, radius, nearObstacle.has(p));
  }
  const school = new Map(), taken = new Set(), slot = Math.floor(now / 60000);
  if (now % 60000 < 18000) for (const p of ordered) {
    if (taken.has(p.id) || world.breedingState(p.id)) continue;
    const group = [p];
    for (const q of neighbors.get(p.id)) {
      if (taken.has(q.id) || world.breedingState(q.id)) continue;
      group.push(q);
      if (group.length === 5) break;
    }
    if (group.length < 3) continue;
    const r = hash(`school:${p.id}:${slot}`), motion = { dx: r % 2 ? 1 : -1, dy: [0, 0, -1, 1][Math.floor(r / 2) % 4], leader: p.id };
    for (const q of group) { taken.add(q.id); school.set(q.id, motion); }
  }
  const memories = new Map();
  for (const [id, home] of Object.entries(world.data.life?.haunts || {})) {
    const p = points.get(id); if (!p) continue;
    const sceneExists = nearScenery && world.data.ops[home.scene]?.kind === 'scene';
    let spot, closestDistance = 7;
    if (sceneExists) for (const q of nearScenery(p, 7)) {
      if (q.id !== home.scene) continue;
      const separation = distance(p, q);
      if (separation <= closestDistance && (!spot || separation < closestDistance || (q.x - spot.x || q.y - spot.y) < 0)) {
        spot = q;
        closestDistance = separation;
      }
    }
    const exists = !!sceneExists && nearScenery(home, 7).some(q => q.id === home.scene && distance(home, q) <= 7);
    memories.set(id, { near: distance(p, home) <= 7, exists, spot });
  }
  function visibleFrom(p, q) {
    return distance(p, q) <= 12 && (!nearObstacle.has(p) || clearLine(p, q, blockedRows));
  }
  function* socialNeighbors(bonds) {
    // UUIDs have equal length and identical punctuation. Every key starting with one
    // UUID sorts before every key starting with the next. Other fish IDs can interleave.
    if (!ordinary.size || rank + 1 !== ordered.length || ordered.some(p => !ordinary.has(p) && !/^[a-zA-Z0-9:-]+$/.test(p.id))) {
      yield* neighbors; return;
    }
    let ordinaryPairs = 0, lastOrdinaryRank = -1;
    for (const p of ordered) {
      const standard = ordinary.has(p);
      if (standard && ordinaryPairs >= LIFE.bondLimit) continue;
      const candidates = [];
      for (const q of nearby(p, 12)) {
        if (p === q) continue;
        const otherStandard = ordinary.has(q);
        if (standard && !otherStandard || standard === otherStandard && p.id > q.id) continue;
        if (!visibleFrom(p, q) && !visibleFrom(q, p)) continue;
        candidates.push(q);
      }
      if (standard) { ordinaryPairs += candidates.length; lastOrdinaryRank = ranks.get(p); }
      yield [p.id, candidates];
    }
    // Beyond the admission cutoff a previously recorded pair can still gain
    // familiarity or have a reunion. All earlier groups were already examined.
    for (const old of bonds) {
      const p = points.get(old.a), q = points.get(old.b);
      if (!ordinary.has(p) || !ordinary.has(q) || ranks.get(p) <= lastOrdinaryRank) continue;
      if (visibleFrom(p, q) || visibleFrom(q, p)) yield [p.id, [q]];
    }
  }
  return { points, neighbors, socialNeighbors, crowdedNeighbor, scenes, memories, school, weather: weatherAt(world.data, now), event: activeEvent(world.data, now) };
}
export function updateLife(world, now, context) {
  const life = state(world, now), elapsed = now - life.at;
  if (elapsed < 1000 && elapsed >= 0) return;
  const dt = elapsed > 0 && elapsed <= 2500 ? Math.min(1, elapsed / 1000) : 0;
  let stories, storyOrder, storyCount, orderChanged = false;
  const compareStories = (a, b) => stories[b].at - stories[a].at || a.localeCompare(b);
  function record(_, kind, fish, at, extra) {
    if (!stories) { stories = { ...life.stories }; storyCount = Object.keys(stories).length; }
    const story = makeStory(kind, fish, at, extra), id = story.id, old = stories[id];
    if (old) {
      stories[id] = choose(old, story);
      if (old.at !== stories[id].at) orderChanged = true;
    } else { stories[id] = story; storyCount++; }
    if (storyCount <= LIFE.storyLimit) return;
    if (!storyOrder) storyOrder = Object.keys(stories).sort(compareStories);
    else if (orderChanged) { if (!old) storyOrder.push(id); storyOrder.sort(compareStories); }
    else if (!old) {
      let low = 0, high = storyOrder.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (compareStories(id, storyOrder[mid]) < 0) high = mid; else low = mid + 1;
      }
      storyOrder.splice(low, 0, id);
    }
    while (storyOrder.length > LIFE.storyLimit) delete stories[storyOrder.pop()];
    storyCount = storyOrder.length; orderChanged = false;
  }
  const encounters = new Map();
  const next = new Map(world.bondEntries?.() ?? Object.entries(life.bonds));
  const updated = new Set();
  let fresh = new Map(), lastKey;
  for (const [id, others] of context.socialNeighbors?.(next.values()) || context.neighbors) for (const other of others) {
    const a = id < other.id ? id : other.id, b = id < other.id ? other.id : id;
    const key = a + '|' + b, old = next.get(key);
    if (old) {
      if (updated.has(key)) continue;
      const continuous = now - old.lastNear <= 2500;
      const previousSeconds = old.seconds || 0, seconds = Math.min(3600, previousSeconds + dt);
      if (previousSeconds < LIFE.familiar && seconds >= LIFE.familiar) encounters.set(key, { kind: 'friend', a, b });
      if (dt > 0 && old.seconds >= LIFE.familiar && now - old.lastNear >= LIFE.reunion) encounters.set(key, { kind: 'reunion', a, b });
      next.set(key, { a, b, seconds, at: now, lastNear: now, run: continuous ? Math.min(120, old.run + dt) : 0 });
      updated.add(key);
      continue;
    }
    if (fresh.has(key) || lastKey && key.localeCompare(lastKey) > 0) continue;
    fresh.set(key, a);
    // All fresh contacts have the same timestamp, so only the first bondLimit keys can survive the final trim.
    if (fresh.size === LIFE.bondLimit * 2) {
      const keys = [...fresh.keys()].sort((x, y) => x.localeCompare(y)).slice(0, LIFE.bondLimit);
      lastKey = keys.at(-1);
      fresh = new Map(keys.map(key => [key, fresh.get(key)]));
    }
  }
  for (const [key, a] of fresh) next.set(key, { a, b: key.slice(a.length + 1), seconds: dt, at: now, lastNear: now, run: 0 });
  if (encounters.size && context.socialNeighbors) {
    // A previously pruned story can be created again. Apply simultaneous stories
    // in their original encounter order, including one-way lines of sight.
    const involved = new Set();
    for (const { a, b } of encounters.values()) { involved.add(a); involved.add(b); }
    for (const id of context.points.keys()) {
      if (!involved.has(id)) continue;
      for (const q of context.neighbors.get(id)) {
        const key = id < q.id ? id + '|' + q.id : q.id + '|' + id;
        const story = encounters.get(key);
        if (story) { record(world, story.kind, story.a, now, { other: story.b }); encounters.delete(key); }
      }
      if (!encounters.size) break;
    }
  } else {
    for (const { kind, a, b } of encounters.values()) record(world, kind, a, now, { other: b });
  }
  for (const [id, spot] of context.scenes) {
    if (distance(context.points.get(id), spot) > 7) continue;
    const old = life.places[id], seconds = Math.min(3600, (old?.scene === spot.id ? old.seconds : 0) + dt);
    life.places[id] = { scene: spot.id, seconds, at: now };
    if ((old?.scene === spot.id ? old.seconds : 0) < LIFE.haunt && seconds >= LIFE.haunt) record(world, 'haunt', id, now, { scene: spot.id });
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
    if (home.away && memory.near && !memory.exists && !home.visited) { record(world, 'revisit', id, now, { scene: home.scene, visit: home.displaced }); home.visited = true; }
    if (memory.exists && memory.spot && !home.found) { record(world, 'rediscover', id, now, { scene: home.scene, visit: home.displaced }); home.found = true; }
    if (memory.spot && !memory.exists && !home.found) { record(world, 'rediscover', id, now, { scene: home.scene, visit: home.displaced }); home.found = true; }
    if (memory.exists) { delete home.displaced; home.away = home.visited = home.found = false; }
    home.at = now; world.dirty = true;
  }
  updateEvents(world, now, context, dt > 0, record, key => next.get(key));
  if (stories) {
    life.stories = storyOrder ? Object.fromEntries(storyOrder.map(id => [id, stories[id]])) : stories;
    world.dirty = true;
  }
  life.at = now;
  life.bonds = Object.fromEntries([...next].sort(([a, x], [b, y]) => y.at - x.at || a.localeCompare(b)).slice(0, LIFE.bondLimit));
  for (const id of Object.keys(life.places)) if (!world.data.fishes[id] || !world.data.scenes[life.places[id].scene]) delete life.places[id];
  life.haunts = trim(Object.fromEntries(Object.entries(life.haunts || {}).filter(([id]) => world.data.fishes[id])), LIFE.bondLimit);
}
const wandering = new WeakMap();
function swimPattern(fish, now) {
  const phase = Math.floor((now - fish.created) / 12000), previous = wandering.get(fish);
  if (previous?.id === fish.id && previous.phase === phase) return previous;
  const r = hash(`${fish.id}:${phase}`), pattern = {
    id: fish.id, phase, trait: previous?.id === fish.id ? previous.trait : personality(fish.id),
    dx: r % 3 - 1, dy: Math.floor(r / 3) % 3 - 1
  };
  wandering.set(fish, pattern);
  return pattern;
}
export function idleMotion(world, fish, now, context, center) {
  const life = state(world, now);
  if (now - fish.lastFed >= 86400000) {
    const { dx, dy } = swimPattern(fish, now);
    return { dx, dy };
  }
  const breeding = world.breedingState(fish.id);
  if (!breeding) { const motion = eventMotion(fish.id, now, context); if (motion) return motion; }
  const point = context.points.get(fish.id) || center;
  // Leave water between bodies before following friends or a school. Center
  // distance alone makes larger fish keep trying to swim into each other.
  const gap = q => Math.max(Math.abs(deltaX(q.x, point.x)) - (point.halfWidth || 0) - (q.halfWidth || 0), Math.abs(q.y - point.y) - (point.halfHeight || 0) - (q.halfHeight || 0));
  const crowded = !breeding && context.crowdedNeighbor(context.points.get(fish.id));
  if (crowded) return { dx: Math.sign(deltaX(point.x, crowded.x)), dy: Math.sign(point.y - crowded.y) };
  const school = context.school.get(fish.id); if (school) return school;
  let neighbors;
  if (now % 180000 < 45000) for (const q of neighbors = context.neighbors.get(fish.id) || []) {
    const pair = fish.id < q.id ? fish.id + '|' + q.id : q.id + '|' + fish.id;
    if (!(life.bonds[pair]?.seconds >= LIFE.familiar)) continue;
    const motion = hash(`companion:${pair}:${Math.floor(now / 12000)}`);
    return { dx: motion % 2 ? 1 : -1, dy: [0, 0, -1, 1][Math.floor(motion / 2) % 4] };
  }
  const pattern = swimPattern(fish, now), { trait, phase } = pattern, spot = context.scenes.get(fish.id);
  let { dx, dy } = pattern;
  if ((trait === 'quiet' || trait === 'social') && phase % 3 !== 0) neighbors ??= context.neighbors.get(fish.id) || [];
  if (trait === 'quiet') { if (phase % 3 !== 0 && neighbors.length) { dx = -Math.sign(deltaX(neighbors[0].x, point.x)); dy = -Math.sign(neighbors[0].y - point.y); } else if (phase % 3 === 0) dx = dy = 0; }
  if (trait === 'social' && phase % 3 !== 0 && neighbors.length && gap(neighbors[0]) > 4) { dx = Math.sign(deltaX(neighbors[0].x, point.x)); dy = Math.sign(neighbors[0].y - point.y); }
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
  const fish = world.movementGrid(world.fishGroups()), occupied = world.sceneryMap();
  for (const cell of world.charValues('food', 'seaweed')) occupied.set(worldKey(cell.x, cell.y), cell);
  for (let index = 0; index < 10; index++) {
    const initial = planktonSource(world.data, weather.seed, weather.slot, index); if (!initial || world.data.chars[initial.id] || !world.waterAt(initial.x, initial.y) || fish.get(initial.x, initial.y) || occupied.has(worldKey(initial.x, initial.y))) continue;
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
  for (const r of Object.values(life.stories)) if (['captured', 'cthulhuDepart', 'atomicSurvivor', 'shipMeal'].includes(r.kind) && !validLegendStory(r, sources.roots)) return false;
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
  if (story.kind === 'depressed') return `${fish}因拥挤而抑郁了，每小时会消散一块鱼元，吃到「乐」字鱼食就能康复`;
  if (story.kind === 'recovered') return `${fish}吃到了「乐」，从抑郁中康复了`;
  if (story.kind === 'depart' && story.cause) return `${fish}${{ depression: '未能及时吃到「乐」，因抑郁离世', predator: '被食肉鱼捕食了', magma: '碰到了炽热的岩浆' }[story.cause] || '的鱼生结束了'}，记忆还在鱼谱里`;
  if (story.kind === 'captured') return `${fish}被克苏鲁的触须缠住`;
  if (story.kind === 'cthulhuDepart') return `${fish}随克苏鲁沉回了深海`;
  if (story.kind === 'atomicSurvivor') return `${fish} · 哥斯拉原子吐息幸存者`;
  if (story.kind === 'shipMeal') return `${fish} · 吞下过幽灵船上生长的船蛆`;
  if (story.kind === 'ambient') { const schedule = eventSchedule({ [story.eventSeed]: 0 }, story.eventSeed, story.eventSlot); return `${fish}${eventNarration(schedule?.kind)}`; }
  return { arrive: `${fish}开始了自己的鱼生`, meal: `${fish}第一次吃到了鱼食`, grass: `${fish}第一次吃到了草`, friend: `${fish}和${other}成了熟鱼`, reunion: `${fish}又遇见了熟鱼${other}${hash(`greeting:${story.id}`) % 3 === 0 ? '，它们用自己的暗号打了招呼' : ''}`, haunt: `${fish}有了常去的造景`, birth: `${fish}出生了，海里多了一位小邻居`, depart: `${fish}的鱼生结束了，记忆还在鱼谱里`, revisit: `${fish}来看看常去的地方，发现风景换了`, rediscover: `${fish}又认出了那处造景：原来你搬到这里了` }[story.kind];
}
export function returnStory(stories, since) {
  const rank = { birth: 8, depressed: 8, recovered: 7, captured: 7, atomicSurvivor: 7, shipMeal: 6, cthulhuDepart: 6, friend: 6, reunion: 5, rediscover: 5, revisit: 4, grass: 4, haunt: 3, ambient: 3, meal: 2, depart: 1, arrive: 0 };
  return stories.filter(r => r.at > since).sort((a, b) => rank[b.kind] - rank[a.kind] || b.at - a.at || a.id.localeCompare(b.id))[0];
}
