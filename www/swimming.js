import { CONFIG, EYES, key, hash, bounds, sightRadius, cellPosition } from './engine.js';
import { LIFE, idleMotion, wanderDirection } from './life.js';
import { POPULATION, illnessOf } from './population.js';
import { motionOrder, commitUnit } from './breeding.js';
import { WORLD_WIDTH, MAX_FLOOR, wrapX, deltaX } from './geography.js';
import { shanghaiDay } from './fish-status.js';
import { fitsHullAt, sweepsHullAt } from './motion-hull.js';
import { packedGrid, swimOne, singlePose } from './swim-kernel.js';

const DIAGONAL_SWIM = Math.hypot(1, 1);

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
// Hungry swimmers sharing a creation-time offset turn over their intentions
// together. Eating or changing a fish replaces the roster supplied by the grid.
function planFreeSwimming(grid, singles, now) {
  let plan = grid.intentPlan;
  if (!plan || plan.singles !== singles || now < plan.last || now >= plan.fedDeadline) {
    const byCreation = new Map();
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
      let bucket = byCreation.get(fish.created);
      if (!bucket) {
        const residue = ((fish.created % LIFE.wanderPeriod) + LIFE.wanderPeriod) % LIFE.wanderPeriod;
        bucket = { swimmers: [], due: -Infinity, created: fish.created, residue };
        byCreation.set(fish.created, bucket);
        plan.buckets.push(bucket);
      }
      bucket.swimmers.push(swimmer);
    }
  }
  if (now >= plan.next) {
    plan.next = Infinity;
    for (const bucket of plan.buckets) {
      if (now >= bucket.due) {
        const phase = Math.floor((now - bucket.created) / LIFE.wanderPeriod), text = String(phase);
        for (const swimmer of bucket.swimmers) {
          if (swimmer.wanderId !== swimmer.fish.id) {
            swimmer.wanderId = swimmer.fish.id;
            swimmer.wanderSeed = hash(swimmer.wanderId + ':');
          }
          swimmer.intended = wanderDirection(swimmer.wanderSeed, text);
        }
        bucket.due = (Math.floor((now - bucket.residue) / LIFE.wanderPeriod) + 1) * LIFE.wanderPeriod + bucket.residue;
      }
      plan.next = Math.min(plan.next, bucket.due);
    }
  }
  plan.last = now;
}
export function foodSight(edible) {
  if (!edible.length) return null;
  const bins = new Map(), views = new Map(), width = CONFIG.width / 10;
  for (const food of edible) {
    const bin = key(Math.floor(wrapX(food.x) / 10), Math.floor(food.y / 10));
    if (!bins.has(bin)) bins.set(bin, []);
    bins.get(bin).push(food);
  }
  // Eyes in the same ten-cell square visit the same bins in the same order.
  // The exact distance from each eye is still checked before choosing a meal.
  return (x, y, radius) => {
    const bx = Math.floor(x / 10), by = Math.floor(y / 10), bin = key(bx, by);
    let view = views.get(bin);
    if (view) return view;
    view = [];
    const reach = radius / 10;
    for (let i = bx - reach; i <= bx + reach; i++) for (let j = by - reach; j <= by + reach; j++) {
      const foods = bins.get(key((i % width + width) % width, j));
      if (foods) for (const food of foods) view.push(food);
    }
    views.set(bin, view);
    return view;
  };
}
function chooseDirection(world, id, fish, cells, pair, center, now, ambient, foodsNear, canEat, planned) {
  const midX = fish.x + fish.facing * (center.minX + center.maxX) / 2, midY = fish.y + (center.minY + center.maxY) / 2;
  if (foodsNear && (pair ? pair.members.some(member => canEat(member.id)) : canEat(id))) {
    let best, distance, needsRemedy;
    for (const eye of cells) if (EYES.has(eye.ch)) {
      const p = cellPosition(fish, eye), radius = sightRadius(p.y);
      for (const food of foodsNear(p.x, p.y, radius)) {
        if (food === best || Math.max(Math.abs(deltaX(food.x, p.x)), Math.abs(food.y - p.y)) > radius) continue;
        const nextDistance = Math.abs(deltaX(food.x, midX)) + Math.abs(food.y - midY);
        if (best) {
          needsRemedy ??= pair ? pair.members.some(member => illnessOf(world.data, member.id)) : !!illnessOf(world.data, id);
          const rank = (needsRemedy ? Number(best.ch === POPULATION.remedy) - Number(food.ch === POPULATION.remedy) : 0) ||
            nextDistance - distance || food.id.localeCompare(best.id);
          if (rank >= 0) continue;
        }
        best = food; distance = nextDistance;
      }
    }
    if (best) return { dx: Math.sign(deltaX(best.x, midX)), dy: Math.sign(best.y - midY) };
  }
  if (planned) return planned;
  if (ambient) return idleMotion(world, fish, now, ambient, { x: midX, y: midY });
  const phase = Math.floor((now - fish.created) / LIFE.wanderPeriod), r = hash(`${id}:${phase}`);
  return { dx: r % 3 - 1, dy: Math.floor(r / 3) % 3 - 1 };
}
// Pair membership changes collision order. Intersect the new order with the
// native rows that really ran last time. Each surviving range can run in place.
function unchangedRuns(old, packed, ordered, order, groups, inputs, waiting, captured) {
  if (!old || old.shapes !== packed.shapes || !inputs) return;
  if (old.order === order && old.groups === groups && !inputs.size && !waiting.size && !captured.size) return old.byOrder;
  const matched = [];
  let cursor = 0, current, source;
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i], swimmer = entry[3];
    if (!swimmer) continue;
    const rank = swimmer.rank;
    while (cursor < old.list.length && old.list[cursor].lastRank <= rank) cursor++;
    const before = old.list[cursor], id = entry[0];
    if (!before || rank < before.rank || packed.swimmers[rank] !== swimmer || packed.hulls[rank] !== swimmer.hull ||
        inputs.has(id) || waiting.has(id) || captured.has(id)) continue;
    if (current?.end === i && current.lastRank === rank && source === before) {
      current.end++;
      current.lastRank++;
    } else {
      current = matched[i] = { rank, lastRank: rank + 1, end: i + 1, allWander: before.allWander };
      source = before;
    }
  }
  return matched;
}
export function advanceSwimming(world, now, dt, grid, groups, ambient, captured, waitingToEat, foodsNear, canEat, scenery,
  foodPositions, turningObstacles, edible, magma, magmaVictims, swims, paths) {
  const layout = grid.layout, { fishes, breeding } = world.data;
  const singles = grid.swimmers(world, CONFIG.speed);
  const freeIntents = ambient && world.stableFishRoster;
  const nearFood = freeIntents && foodsNear && grid.ownersNear(edible, Math.max(CONFIG.sightShallow, CONFIG.sightDeep));
  if (freeIntents) planFreeSwimming(grid, singles, now);
  const ordered = motionOrder(world, groups, layout, singles);
  const prior = world.currentSwimColumns?.(), batch = world.beginSwimBatch?.();
  const packed = Number.isFinite(dt) && ambient && batch && ordered.length && !magma.size && !grid.overlapped
    ? packedGrid(grid, singles.length) : null;
  if (packed) batch.nativeIndex = new Int32Array(batch.poseIndex.length);
  const previous = packed && prior?.grid === packed ? prior.index : undefined;
  const phase = String(Math.floor(now / 12000));
  const avoidance = [0, 1, 2, 3].map(seed => hash(phase, seed) & 3);
  const schedule = grid.intentPlan, order = ordered === singles ? singles : layout.pairOrder?.entries;
  const oldRuns = packed && previous && packed.runs;
  const runs = oldRuns && unchangedRuns(oldRuns, packed, ordered, order, layout.groups, batch.inputs, waitingToEat, captured);
  const sameDirections = runs && oldRuns.schedule === schedule && oldRuns.next === schedule.next && oldRuns.phase === phase;
  const list = packed && [], byOrder = packed && [];
  let start = 0, count = 0, rank = 0, allWander = true, travelDay;

  function publishPose(fish, ordinal, rank) {
    const { x, y, facing, cx, cy } = fish;
    if (ordinal !== undefined) {
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(facing) && Number.isFinite(cx) && Number.isFinite(cy)) {
        const offset = batch.poses.length * 5;
        batch.poseIndex[ordinal] = batch.poses.push(ordinal);
        batch.motion[offset] = x;
        batch.motion[offset + 1] = y;
        batch.motion[offset + 2] = facing;
        batch.motion[offset + 3] = cx;
        batch.motion[offset + 4] = cy;
        if (packed) {
          batch.nativeIndex[ordinal] = rank + 1;
          const at = packed.poseOffset / 8 + rank * 5;
          packed.doubles.set(batch.motion.subarray(offset, offset + 5), at);
          packed.swimmers[rank] = undefined;
        }
      } else world.movingFish(fish);
    }
  }
  function recordTrail(id, pair, ordinal, trail, facing, oldFacing) {
    if (trail === 4) return;
    if (swims && !pair && oldFacing === facing) (paths[trail] ||= []).push(id);
    travelDay ??= shanghaiDay(now);
    const distance = (trail & 1) ? 1 : DIAGONAL_SWIM;
    if (pair) {
      for (const member of pair.members) world.recordMovement(member.id, distance, now, travelDay);
    } else {
      const days = ordinal === undefined ? undefined : batch.daysByOrdinal[ordinal] ?? batch.readDays(id, ordinal);
      if (days) {
        const distanceToday = (days[travelDay] || 0) + distance;
        days[travelDay] = distanceToday;
        batch.distances[batch.travel.length] = distanceToday;
        batch.tripIndex[ordinal] = batch.travel.push(ordinal);
      } else world.recordMovement(id, distance, now, travelDay);
    }
  }
  function aimSingle(entry, row, prepare) {
    const [id, cells, , swimmer] = entry, fish = swimmer.fish;
    const sight = foodsNear && (!nearFood || swimmer.slot === undefined || nearFood[swimmer.slot]) ? foodsNear : null;
    const planned = freeIntents && now - fish.lastFed >= CONFIG.hunger && swimmer.intended;
    const wander = !sight && planned;
    const direction = wander || chooseDirection(world, id, fish, cells, null, swimmer.hull.bounds, now, ambient, sight, canEat, planned);
    const avoid = avoidance[swimmer.avoidanceSeed ??= hash('avoid:' + id + ':') & 3];
    if (prepare) packed.put(row, swimmer, direction, avoid, previous);
    else packed.aim(row, direction, avoid);
    return !!wander;
  }
  function flush() {
    if (!count) return;
    const first = batch.poses.length;
    const finished = { rank, lastRank: rank + count, end: start + count, allWander };
    list.push(finished);
    byOrder[start] = finished;
    allWander = true;
    packed.advance(count, dt, rank);
    const poses = packed.doubles, trails = packed.words, base = packed.poseOffset / 8 + rank * 5;
    batch.motion.set(poses.subarray(base, base + count * 5), first * 5);
    for (let i = 0; i < count; i++) {
      const entry = ordered[start + i], swimmer = entry[3], f = swimmer.fish;
      const p = base + i * 5, oldFacing = f.facing;
      f.x = poses[p]; f.y = poses[p + 1]; f.facing = poses[p + 2]; f.cx = poses[p + 3]; f.cy = poses[p + 4]; f.posAt = now;
      batch.nativeIndex[swimmer.ordinal] = rank + i + 1;
      batch.poseIndex[swimmer.ordinal] = batch.poses.push(swimmer.ordinal);
      recordTrail(entry[0], null, swimmer.ordinal, trails[packed.trailsOffset / 4 + rank + i], f.facing, oldFacing);
    }
    count = 0;
  }
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index], id = entry[0], cells = entry[1], pair = entry[2], swimmer = entry[3];
    const run = runs?.[index];
    if (run && !grid.overlapped) {
      flush();
      allWander = run.allWander;
      if (!sameDirections || !run.allWander || foodsNear) {
        let all = true;
        for (let k = index; k < run.end; k++) {
          if (sameDirections && run.allWander && nearFood && !nearFood[ordered[k][3].slot]) continue;
          if (!aimSingle(ordered[k], run.rank + k - index, false)) all = false;
        }
        allWander = all;
      }
      start = index; rank = run.rank; count = run.end - index; flush();
      index = run.end - 1;
      continue;
    }
    let f = pair ? pair.fish : swimmer?.fish ?? fishes[id];
    if (!f || !cells.length || (captured.size && (pair ? pair.members.some(member => captured.has(member.id)) : captured.has(id)))) {
      flush();
      continue;
    }
    const ordinal = swimmer?.ordinal;
    const waiting = waitingToEat.size && (pair ? pair.members.some(member => waitingToEat.has(member.id)) : waitingToEat.has(id));
    const oldX = f.x, oldY = f.y, oldFacing = f.facing;
    const canonical = Number.isSafeInteger(oldX) && Math.abs(oldX) <= 2 * WORLD_WIDTH &&
      Number.isSafeInteger(oldY) && Math.abs(oldFacing) === 1;
    const hull = canonical && !waiting ? (swimmer ? swimmer.hull : layout.hull(cells)) : null;
    const slot = hull && !pair && breeding[id]?.status !== 'active' ? swimmer?.slot ?? grid.slots.get(id) : undefined;
    const bulk = packed && !grid.overlapped && !waiting && ordinal !== undefined && slot !== undefined && !hull.duplicate &&
      Number.isFinite(f.cx || 0) && Number.isFinite(f.cy || 0) &&
      oldY + hull.bounds.minY >= 0 && oldY + hull.bounds.maxY < MAX_FLOOR;
    if (bulk) {
      if (count && swimmer.rank !== rank + count) flush();
      if (!count) { start = index; rank = swimmer.rank; }
      count++;
      if (!aimSingle(entry, swimmer.rank, true)) allWander = false;
      continue;
    }
    const sight = foodsNear && (!nearFood || swimmer?.slot === undefined || nearFood[swimmer.slot]) ? foodsNear : null;
    const planned = freeIntents && now - f.lastFed >= CONFIG.hunger && swimmer?.intended;
    // Food and school points are fixed before movement. The next geometry probe needs the current grid.
    flush();
    if (ordinal === undefined && !pair && world.movingFish) f = world.movingFish(f);
    let trail = 4;
    if (!waiting) {
      const center = hull?.bounds || bounds(cells);
      const direction = !sight && planned || chooseDirection(world, id, f, cells, pair, center, now, ambient, sight, canEat, planned);
      const avoid = swimmer ? avoidance[swimmer.avoidanceSeed ??= hash('avoid:' + id + ':') & 3] : hash('avoid:' + id + ':' + phase) & 3;
      if (pair) for (const member of pair.members) grid.update(member, groups.get(member.id) || [], true);
      const legacy = slot === undefined ? { world, id, cells, scenery, foodPositions, turningObstacles, center } : null;
      const speedX = hull && swimmer ? swimmer.speedX : CONFIG.speed * center.width / cells.length;
      const speedY = hull && swimmer ? swimmer.speedY : CONFIG.speed * center.height / cells.length;
      const pivot = oldX + oldFacing * (center.minX + center.maxX);
      const result = swimOne(f, pivot, dt, speedX, speedY, direction, avoid, !!ambient && !pair, {
        fits: (x, y, facing) => positionFits(hull, x, y, facing, grid, slot, legacy),
        turns: (x, y, facing) => canFlip(hull, x, y, facing, grid, slot, legacy)
      });
      trail = result & 15;
      const x = singlePose[0], facing = singlePose[2];
      if (magma.size) {
        if (result & 16) noteMagmaContact(magma, magmaVictims, groups, f, cells, pair, facing !== oldFacing ? pivot : oldX, oldY, facing);
        if (trail % 3 !== 1) noteMagmaContact(magma, magmaVictims, groups, f, cells, pair, x, oldY, facing);
      }
      f.y = singlePose[1]; f.facing = facing; f.cx = singlePose[3]; f.cy = singlePose[4]; f.x = pair ? x : wrapX(x);
    } else if (!pair) f.x = wrapX(oldX);
    if (pair) {
      commitUnit(pair, now);
      if (!waiting) for (const member of pair.members) grid.update(member, groups.get(member.id) || []);
    } else {
      f.posAt = now;
      if (!waiting && (oldX !== f.x || oldY !== f.y || oldFacing !== f.facing)) grid.moveFish(f, cells, oldX, oldY, oldFacing, hull, slot);
    }
    if (!waiting && magma.size) noteMagmaContact(magma, magmaVictims, groups, f, cells, pair, f.x, f.y, f.facing);
    publishPose(f, ordinal, swimmer?.rank);
    recordTrail(id, pair, ordinal, trail, f.facing, oldFacing);
  }
  flush();
  if (packed) {
    packed.runs = order && schedule ? { order, groups: layout.groups, shapes: packed.shapes, schedule, next: schedule.next, phase, list, byOrder } : undefined;
  }
  if (batch) world.completeSwimBatch(batch, travelDay, packed);
}
