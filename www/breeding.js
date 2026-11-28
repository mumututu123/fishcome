import { CONFIG, EYES, NEIGHBORS, bounds, cellPosition, components, hash, clone, key, touching } from './engine.js';
import { defaultFishName, fishNameError } from './fish-profile.js';
import { wrapX, nearX, deltaX } from './geography.js';
import { recordStory } from './life.js';
import { capturedFishIds } from './legends.js';
import { densityField, contactTime } from './ecology.js';
import { collectGridPairs, hasNamedGlyphs } from './breeding-contacts.js';

export const CONTACT_TIME = 5000;
export const BREEDING_TIME = 3600000;
const activeIndexes = new WeakMap();

export function breedingId(male, female, started) { const pair = `${male}:${female}`; return `breed:${started}:${hash(pair).toString(16)}-${hash('pair:' + pair).toString(16)}`; }
export function fishOrigin(data, id) {
  const op = data.ops[id]; if (op?.kind === 'fish') return { actor: op.actor, nick: op.nick, gender: op.gender, created: op.t, name: op.name, size: op.cells?.length };
  const record = typeof id === 'string' && id.startsWith('born:') ? data.breeding?.[id.slice(5)] : null;
  return record?.status === 'born' && record.baby?.id === id ? record.baby : data.archivedCatalog?.[id];
}
function activeIndex(table) {
  let index = activeIndexes.get(table);
  if (!index) {
    const records = new Map();
    for (const id of Object.keys(table)) {
      const record = table[id];
      if (record.status === 'active') records.set(id, record);
    }
    index = { records, byFish: null };
    activeIndexes.set(table, index);
  }
  return index;
}
export function activeBreeding(data, id) {
  if (!data.breeding) return;
  const index = activeIndex(data.breeding);
  if (!index.byFish) {
    index.byFish = new Map();
    for (const record of index.records.values()) {
      if (!index.byFish.has(record.male)) index.byFish.set(record.male, record);
      if (!index.byFish.has(record.female)) index.byFish.set(record.female, record);
    }
  }
  return index.byFish.get(id);
}
function activeRecords(data) { return data.breeding ? [...activeIndex(data.breeding).records.values()] : []; }
export function breedingForBroadcast(table, full) {
  const index = activeIndex(table), pending = index.pendingTerminal;
  // Start tracking the next packet before signing or sending this one.
  index.pendingTerminal = new Set();
  if (full || !pending) return table;
  const records = Object.fromEntries(index.records);
  for (const id of pending) if (Object.hasOwn(table, id)) records[id] = table[id];
  return records;
}
export function stopBreedingBroadcast(table) {
  const index = activeIndexes.get(table);
  if (index) index.pendingTerminal = null;
}
function markTerminal(index, id) {
  index.pendingTerminal?.add(id);
  if (index.records.delete(id)) index.byFish = null;
}
export function writeBreedingRecord(table, id, record) {
  const index = activeIndexes.get(table);
  const active = record?.status === 'active';
  const reactivates = index && active && Object.hasOwn(table, id) && !index.records.has(id);
  table[id] = record;

  if (!index) return;
  if (reactivates) activeIndexes.delete(table);
  else if (active) { index.records.set(id, table[id]); index.byFish = null; }
  else markTerminal(index, id);
}
export function contactCells(male, mc, female, fc, scenery) {
  const at = new Map(fc.map(cell => { const p = cellPosition(female, cell); return [key(p.x, p.y), cell]; }));
  const fathers = new Set(), mothers = new Set();
  for (const cell of mc) {
    const p = cellPosition(male, cell);
    for (const [dx, dy] of NEIGHBORS) {
      const other = at.get(key(p.x + dx, p.y + dy));
      if (other && !(dx && dy && (scenery.has(key(p.x + dx, p.y)) || scenery.has(key(p.x, p.y + dy))))) { fathers.add(cell.id); mothers.add(other.id); }
    }
  }
  return { male: [...fathers].sort(), female: [...mothers].sort() };
}
function pose(fish) { return { x: fish.x, y: fish.y, facing: fish.facing }; }
function settleRecord(data, record, status, now) {
  record.status = status; record.at = now;
  const index = activeIndexes.get(data.breeding);
  if (!index) return;
  if (data.breeding[record.id] !== record) activeIndexes.delete(data.breeding);
  else markTerminal(index, record.id);
}
export function cancelBreeding(data, record, now, reason) {
  settleRecord(data, record, 'cancelled', now); record.reason = reason;
}
export function normalizeBreeding(world, now, posed) {
  world.data.breeding ||= {}; world.data.contacts ||= {};
  const taken = new Set();
  for (const record of activeRecords(world.data).sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))) {
    if (!world.data.fishes[record.male] || !world.data.fishes[record.female]) { cancelBreeding(world.data, record, now, 'parent-gone'); continue; }
    if (taken.has(record.male) || taken.has(record.female)) { cancelBreeding(world.data, record, now, 'conflicting-pair'); continue; }
    taken.add(record.male); taken.add(record.female);
    if (record.pose) {
      Object.assign(world.data.fishes[record.male], record.pose.male);
      Object.assign(world.data.fishes[record.female], record.pose.female);
      posed?.add(record.male);
      posed?.add(record.female);
    }
  }
}
export function chooseOwner(record, fatherCount, motherCount, fatherRemaining, motherRemaining) {
  if (fatherCount !== motherCount) return fatherCount > motherCount ? record.male : record.female;
  if (fatherRemaining !== motherRemaining) return fatherRemaining > motherRemaining ? record.male : record.female;
  return hash(`owner:${record.id}`) % 2 ? record.male : record.female;
}
export function finishBreeding(world, now, transition) {
  normalizeBreeding(world, now);
  for (const record of activeRecords(world.data)) {
    if (record.status !== 'active' || now < record.ends) continue;
    const father = world.data.fishes[record.male], mother = world.data.fishes[record.female], fatherCells = world.fishCells(record.male), motherCells = world.fishCells(record.female);
    const selectedFather = fatherCells.filter(cell => record.contact.male.includes(cell.id)), selectedMother = motherCells.filter(cell => record.contact.female.includes(cell.id));
    const selected = [...selectedFather, ...selectedMother], removed = new Set(selected.map(cell => cell.id)), remainingFather = fatherCells.filter(cell => !removed.has(cell.id)), remainingMother = motherCells.filter(cell => !removed.has(cell.id));
    const placed = selected.map(cell => { const p = cellPosition(cell.entity === father.id ? father : mother, cell); return { ...cell, x: nearX(p.x, father.x), y: p.y }; });
    const occupants = world.fishOccupants(), parents = new Set([father.id, mother.id]);
    const viable = remainingFather.length >= 2 && remainingMother.length >= 2 && components(remainingFather).length === 1 && components(remainingMother).length === 1 && selectedFather.length > 0 && selectedMother.length > 0 && selected.length >= 2 && new Set(placed.map(cell => key(cell.x, cell.y))).size === placed.length && components(placed).length === 1 && placed.every(cell => [...(occupants.get(key(cell.x, cell.y)) || [])].every(id => parents.has(id)));
    if (!viable) { cancelBreeding(world.data, record, now, 'incomplete-bodies'); father.cx = father.cy = mother.cx = mother.cy = 0; world.dirty = true; continue; }
    const id = `born:${record.id}`, owner = chooseOwner(record, selectedFather.length, selectedMother.length, remainingFather.length, remainingMother.length), parent = owner === father.id ? father : mother;
    const body = bounds(placed), gender = hash(`gender:${id}`) % 2 ? 'male' : 'female';
    const eye = placed.some(cell => EYES.has(cell.ch)) ? null : [...placed].sort((a, b) => a.id.localeCompare(b.id))[hash(`eye-cell:${id}`) % placed.length].id;
    const eyes = [...EYES], eyeGlyph = eyes[hash(`eye-glyph:${id}`) % eyes.length];
    const bornCells = [];
    for (const cell of selected) {
      const raw = cellPosition(cell.entity === father.id ? father : mother, cell), p = { x: nearX(raw.x, father.x), y: raw.y }, from = cell.entity, before = cell.ch, after = cell.id === eye ? eyeGlyph : before;
      bornCells.push({ id: cell.id, parent: from, before, after, color: cell.color, x: p.x - body.minX, y: p.y - body.minY });
      transition(cell, { kind: 'fish', entity: id, x: p.x - body.minX, y: p.y - body.minY, ch: after, editAt: now }, { id: `birth:${record.id}:${cell.id}`, t: now, reason: 'birth', birth: record.id, from, before, after });
    }
    record.baby = { id, actor: fishOrigin(world.data, parent.id)?.actor || parent.actor, nick: parent.nick, gender, created: now, parents: [father.id, mother.id], owner, fatherCount: selectedFather.length, motherCount: selectedMother.length, fatherRemaining: remainingFather.length, motherRemaining: remainingMother.length, cells: bornCells };
    const number = Object.values(world.data.fishes).filter(fish => fishOrigin(world.data, fish.id)?.actor === record.baby.actor).length + 1;
    Object.assign(record.baby, { name: defaultFishName(parent.nick || '鱼', number, selected.length), nameAuto: true, nameOrdinal: number });
    settleRecord(world.data, record, 'born', now);
    world.data.fishes[id] = { id, actor: record.baby.actor, nick: record.baby.nick, gender, birth: record.id, parents: record.baby.parents, x: wrapX(body.minX), y: body.minY, facing: 1, created: now, lastFed: now, hungerAt: now + CONFIG.hunger, cx: 0, cy: 0, posAt: now };
    world.data.fishes[id].name = record.baby.name;
    world.data.travel[id] = { since: now, days: {} };
    recordStory(world, 'birth', id, now, { parents: record.baby.parents });
    father.cx = father.cy = mother.cx = mother.cy = 0; father.posAt = mother.posAt = now;
    world.foodRevision++; world.dirty = true;
  }
}
function contactWait(density, father, fatherCells, mother, motherCells, scenery, firstMaleId) {
  if (!density) return CONTACT_TIME;
  const maleId = firstMaleId ?? contactCells(father, fatherCells, mother, motherCells, scenery).male[0];
  const maleCell = fatherCells.find(cell => cell.id === maleId);
  if (!maleCell) return CONTACT_TIME;
  const maleCells = [maleCell];
  let femaleCell, q;
  // Fractional positions can touch the selected male cell without matching a grid neighbor.
  for (const cell of motherCells) {
    if (femaleCell && cell.id.localeCompare(femaleCell.id) >= 0) continue;
    const position = cellPosition(mother, cell);
    if (touching(father, maleCells, position, scenery)) { femaleCell = cell; q = position; }
  }
  if (!q) return CONTACT_TIME;
  const p = cellPosition(father, maleCell);
  return contactTime(density((p.x + nearX(q.x, p.x)) / 2, (p.y + q.y) / 2));
}
const contactRosters = new WeakMap();
export function contactRoster(world, groups) {
  const revision = world.originRevision?.(), previous = contactRosters.get(world);
  if (previous && previous.revision === revision && previous.groups === groups) return previous;
  const changed = previous && previous.revision === revision && world.bodyEdits?.(previous.groups, groups);
  if (changed?.sameOrder) {
    for (const id of changed.ids) {
      const before = previous.maleSizes.get(id);
      if (before === undefined) continue;
      const size = groups.get(id).length;
      previous.probeCount += (size - before) * NEIGHBORS.length;
      previous.maleSizes.set(id, size);
    }
    previous.groups = groups;
    return previous;
  }
  const males = [], females = new Set(), maleSizes = new Map();
  let ambiguousIds = false, probeCount = 0;
  for (const [id, cells] of groups) {
    const fish = world.readFish(id);
    if (!fish) continue;
    if (typeof id !== 'string' || id.includes('|')) ambiguousIds = true;
    const gender = fishOrigin(world.data, id)?.gender;
    if (gender === 'male') { males.push(fish); maleSizes.set(id, cells.length); probeCount += cells.length * NEIGHBORS.length; }
    if (gender === 'female') females.add(id);
  }
  const roster = { revision, groups, males, females, maleSizes, probeCount, ambiguousIds };
  if (revision !== undefined) contactRosters.set(world, roster);
  return roster;
}
export function updateContacts(world, now, groups, scenery, captured = capturedFishIds(world.data, now), occupancy) {
  world.data.contacts ||= {}; world.data.breeding ||= {};
  const taken = new Set(activeRecords(world.data).flatMap(record => [record.male, record.female]));
  const roster = contactRoster(world, groups);
  const { males, females, ambiguousIds } = roster, pairs = new Map();
  let density;
  if (males.length && females.size) occupancy ||= world.movementGrid(groups);
  const scanned = !ambiguousIds && collectGridPairs(world, occupancy, scenery, roster, taken, captured, pairs);
  if (!scanned && females.size) for (const fish of males) {
    const id = fish.id;
    if (taken.has(id) || captured.has(id)) continue;
    const cells = groups.get(id);
    const hull = density && occupancy.integerCells && !ambiguousIds && occupancy.layout?.hull(cells);
    if (hull && hasNamedGlyphs(cells)) {
      const b = hull.bounds;
      const left = fish.x + fish.facing * (fish.facing === 1 ? b.minX : b.maxX);
      // For integer cells the rounded midpoint lies on the cell or one step right/down.
      if ((b.width + 1) * (b.height + 1) <= cells.length * NEIGHBORS.length &&
          density.crowdedRegion(left, fish.y + b.minY, left + b.width, fish.y + b.maxY + 1)) continue;
    }
    for (const cell of cells) {
      const p = cellPosition(fish, cell);
      for (const [dx, dy] of NEIGHBORS) {
        const x = p.x + dx, y = p.y + dy, occupants = occupancy.get(x, y);
        if (!occupants || dx && dy && (scenery.has(key(x, p.y)) || scenery.has(key(p.x, y)))) continue;
        const cellId = typeof cell.id === 'string' ? cell.id : null;
        for (const other of occupants) {
          if (!females.has(other) || taken.has(other) || captured.has(other)) continue;
          if (world.ambient && !density) density = densityField(world, scenery, occupancy.integerCells ? occupancy.cells : undefined);
          const pairKey = `${id}|${other}`, pair = pairs.get(pairKey);
          if (!pair) pairs.set(pairKey, { male: id, female: other, firstMaleId: cellId });
          else if (pair.male !== id || pair.female !== other) pairs.set(pairKey, { male: id, female: other, firstMaleId: null });
          else if (cellId === null || pair.firstMaleId !== null && cellId < pair.firstMaleId) pair.firstMaleId = cellId;
        }
      }
    }
  }
  const contacts = {}, previousContacts = world.readContacts?.() ?? world.data.contacts;
  const alreadyTaken = taken.size;
  for (const [key, { male, female, firstMaleId, wait: gridWait }] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
    if (taken.has(male) || taken.has(female)) continue;
    const father = world.readFish(male), mother = world.readFish(female), fc = groups.get(male), mc = groups.get(female);
    const wait = gridWait ?? contactWait(density, father, fc, mother, mc, scenery, firstMaleId);
    if (!Number.isFinite(wait)) continue;
    const prior = previousContacts[key], since = prior && now >= prior.lastAt && now - prior.lastAt <= CONFIG.step * 2 ? prior.since : now;
    contacts[key] = { male, female, since, lastAt: now };
    if (now - since < wait) continue;
    const all = [...fc.map(cell => cellPosition(father, cell)), ...mc.map(cell => cellPosition(mother, cell))];
    if (new Set(all.map(p => `${p.x},${p.y}`)).size !== all.length) continue;
    const started = now, id = breedingId(male, female, started), initialPose = { male: pose(father), female: pose(mother) };
    writeBreedingRecord(world.data.breeding, id, { id, male, female, started, ends: started + BREEDING_TIME, at: now, status: 'active', contact: contactCells(father, fc, mother, mc, scenery), initialPose, pose: clone(initialPose), motion: { cx: 0, cy: 0 } });
    taken.add(male); taken.add(female); delete contacts[key]; world.dirty = true;
  }
  if (taken.size !== alreadyTaken) for (const key of Object.keys(contacts)) {
    const pair = contacts[key];
    if (taken.has(pair.male) || taken.has(pair.female)) delete contacts[key];
  }
  world.data.contacts = contacts;
  world.data.contactAt = now;
}
function integralPose(fish) {
  return Number.isInteger(fish.x) && Math.abs(fish.x) < 2 * CONFIG.width &&
    Number.isInteger(fish.y) && Math.abs(fish.y) < 2 * CONFIG.depth && Math.abs(fish.facing) === 1;
}

function pairBody(record, members, layout, cache) {
  const [male, female] = members, maleBody = layout.groups.get(male.id), femaleBody = layout.groups.get(female.id);
  const reusable = cache && integralPose(male) && integralPose(female);
  const old = reusable && cache.get(record);
  if (old && old.maleBody === maleBody && old.femaleBody === femaleBody) {
    const [a, b] = old.offsets;
    if (male.facing === a.facing && female.facing === b.facing &&
        deltaX(female.x, male.x) === b.x - a.x && female.y - male.y === b.y - a.y) {
      return { cells: old.cells, offsets: old.offsets, x: male.x - a.x, y: male.y - a.y };
    }
  }
  const cells = [];
  for (const fish of members) for (const cell of layout.groups.get(fish.id) || []) {
    cells.push({ ...cell, x: nearX(fish.x + fish.facing * cell.x, male.x), y: fish.y + cell.y });
  }
  const { minX, minY } = bounds(cells);
  for (const cell of cells) { cell.x -= minX; cell.y -= minY; }
  const offsets = members.map(fish => ({ x: nearX(fish.x, male.x) - minX, y: fish.y - minY, facing: fish.facing }));
  // Translation changes only the pair's anchor. A turn or an edit to either
  // body builds its new shape; legacy fractional geometry retains its original rounding.
  if (reusable && cells.length && maleBody && femaleBody && layout.hull(maleBody) && layout.hull(femaleBody)) {
    cache.set(record, { cells, offsets, maleBody, femaleBody });
  }
  return { cells, offsets, x: minX, y: minY };
}

export function motionOrder(world, groups, layout = world.bodyLayout(groups), singles = layout.ordered) {
  const active = activeRecords(world.data);
  if (!active.length) return singles;
  const result = [];
  const cache = world.stableFishRoster && (layout.pairBodies ??= new WeakMap());
  for (const record of active.sort((a, b) => a.id.localeCompare(b.id))) {
    const members = [world.data.fishes[record.male], world.data.fishes[record.female]];
    if (members.some(fish => !fish)) continue;
    const { cells, offsets, x, y } = pairBody(record, members, layout, cache);
    const fish = { id: record.id, x, y, facing: 1, created: record.started, ...record.motion };
    result.push([record.id, cells, { id: record.id, fish, cells, members, offsets, record }]);
  }
  if (!result.length) return singles;
  // Only the membership and fish order determine the slots. Rebuild each
  // pair's live pose above even when its slot in the collision order is fixed.
  const previous = layout.pairOrder;
  if (cache && previous?.singles === singles && previous.slots.length === result.length &&
      result.every(([id, , { members }], i) => {
        const slot = previous.slots[i];
        return slot.id === id && slot.male === members[0].id && slot.female === members[1].id;
      })) {
    const units = previous.entries.slice();
    for (let i = 0; i < result.length; i++) units[previous.slots[i].index] = result[i];
    return units;
  }
  const paired = new Set(), slots = [], units = [];
  for (const [, , { members }] of result) for (const member of members) paired.add(member.id);
  let index = 0;
  function insertPair() {
    const pair = result[index++], [male, female] = pair[2].members;
    slots.push({ id: pair[0], male: male.id, female: female.id, index: units.length });
    units.push(pair);
  }
  for (const entry of singles) {
    const [id] = entry;
    if (paired.has(id)) continue;
    while (index < result.length && result[index][0].localeCompare(id) <= 0) insertPair();
    units.push(entry);
  }
  while (index < result.length) insertPair();
  if (cache) {
    const entries = units.slice();
    for (const slot of slots) entries[slot.index] = null;
    layout.pairOrder = { singles, slots, entries };
  }
  return units;
}
export function motionUnits(world, groups) {
  const units = [], fishes = world.data.fishes;
  for (const [id, cells, pair] of motionOrder(world, groups)) {
    if (pair) units.push(pair);
    else if (fishes[id]) units.push({ id, cells, fish: fishes[id], members: [fishes[id]] });
  }
  return units;
}
export function commitUnit(unit, now) {
  if (unit.record) {
    unit.members.forEach((fish, index) => { const offset = unit.offsets[index]; fish.x = wrapX(unit.fish.x + unit.fish.facing * offset.x); fish.y = unit.fish.y + offset.y; fish.facing = unit.fish.facing * offset.facing; });
    unit.record.pose = { male: pose(unit.members[0]), female: pose(unit.members[1]) }; unit.record.motion = { cx: unit.fish.cx, cy: unit.fish.cy }; unit.record.at = now;
  }
  for (const fish of unit.members) { fish.x = wrapX(fish.x); fish.posAt = now; }
}
export function mergeBreeding(world, other, archived = {}) {
  world.data.breeding ||= {};
  for (const [id, record] of Object.entries(other.breeding || {})) {
    const old = world.data.breeding[id] || archived[id], terminal = record.status !== 'active', oldTerminal = old && old.status !== 'active';
    const born = record.status === 'born', oldBorn = old?.status === 'born';
    if (!old || born && !oldBorn || !oldBorn && terminal && !oldTerminal || born === oldBorn && terminal === oldTerminal && ((born ? record.at < old.at : record.at > old.at) || record.at === old.at && JSON.stringify(record).localeCompare(JSON.stringify(old)) > 0)) writeBreedingRecord(world.data.breeding, id, clone(record));
  }
  if ((other.contactAt || 0) > (world.data.contactAt || 0)) { world.data.contacts = clone(other.contacts || {}); world.data.contactAt = other.contactAt; }
}
// Birth certificates are selected independently of movement. Keep the immutable
// origin coherent without resetting position, later feeding or user edits.
export function canonicalBirthFish(fish, record) {
  const baby = record?.baby;
  if (record?.status !== 'born' || baby?.id !== fish.id || !Number.isFinite(baby.created)) return fish;
  const { actor, created, gender, nick, parents } = baby;
  if (fish.created === created && fish.actor === actor && fish.birth === record.id &&
      fish.gender === gender && fish.nick === nick && JSON.stringify(fish.parents) === JSON.stringify(parents)) return fish;
  const result = { ...fish, actor, created, gender, nick, parents: [...parents], birth: record.id };
  if (fish.lastFed === fish.created && fish.lastMealAt == null) {
    result.lastFed = created;
    if (fish.hungerAt === fish.created + CONFIG.hunger) result.hungerAt = created + CONFIG.hunger;
  }
  return result;
}

// Only rebase equivalent inheritance events. A different cell, parent or glyph
// is not evidence of the same transition; full validation still rejects it.
export function canonicalBirthPath(cell, breeding, alternatives = {}) {
  const path = cell.path;
  if (!Array.isArray(path)) return cell;
  let changed = false, glyph = cell.ch;
  const next = path.map((event, index) => {
    if (event?.reason !== 'birth' || !Object.hasOwn(breeding, event.birth)) return event;
    const record = breeding[event.birth], baby = record?.baby;
    if (record?.status !== 'born' || !Number.isFinite(baby?.created) || !Array.isArray(baby.cells)) return event;
    const inherited = baby.cells.find(item => item.id === cell.id);
    if (!inherited || event.id !== `birth:${record.id}:${cell.id}` || event.target !== baby.id ||
        event.from !== inherited.parent || event.before !== inherited.before || !Number.isFinite(event.t) ||
        event.t < baby.created || baby.created < (path[index - 1]?.t ?? -Infinity) ||
        event.t > (path[index + 1]?.t ?? Infinity)) return event;
    const sameShape = event.x === inherited.x && event.y === inherited.y && event.after === inherited.after;
    if (!sameShape) {
      // Only a second birth certificate can justify changing shape during a merge.
      const alternate = alternatives[event.birth]?.baby;
      const previous = alternate?.cells.find(c => c.id === cell.id);
      if (event.t !== alternate?.created || !previous || previous.parent !== event.from ||
          previous.before !== event.before || previous.after !== event.after ||
          previous.x !== event.x || previous.y !== event.y) return event;
    } else if (event.t === baby.created) return event;
    changed = true;
    if (!sameShape && glyph === event.after && ['fish', 'food'].includes(cell.kind) && !path.slice(index + 1).some(e => e.reason === 'birth')) glyph = inherited.after;
    return { ...event, t: baby.created, x: inherited.x, y: inherited.y, after: inherited.after };
  });
  return changed ? { ...cell, ch: glyph, path: next } : cell;
}

// Legacy local snapshots may contain the later branch's birth time. Repair
// only this recognizable mismatch and let the caller verify the full result.
export function repairLocalBirthTimes(data, archived = {}) {
  if (!data?.ops || !data.fishes || !data.chars) return data;
  const breeding = { ...archived.breeding, ...data.breeding };
  const fishes = { ...data.fishes }, chars = { ...data.chars };
  const sources = { ops: { ...archived.ops, ...data.ops }, breeding };
  const validated = new Map();
  const isValid = record => {
    if (!validated.has(record.id)) validated.set(record.id, validBreedingRecord(record, sources));
    return validated.get(record.id);
  };
  let changed = false;
  for (const [id, fish] of Object.entries(fishes)) {
    if (!fish || !id.startsWith('born:')) continue;
    const record = breeding[id.slice(5)], baby = record?.baby;
    if (fish.id !== id || fish.birth !== record?.id || baby?.id !== id || fish.actor !== baby.actor ||
        !Number.isFinite(fish.created) || fish.created <= baby.created ||
        !isValid(record)) continue;
    const normalized = canonicalBirthFish(fish, record);
    fishes[id] = { ...fish, created: normalized.created, lastFed: normalized.lastFed, hungerAt: normalized.hungerAt };
    changed = true;
  }
  for (const [id, cell] of Object.entries(chars)) {
    if (!Array.isArray(cell?.path) || !cell.path.some(event => event?.reason === 'birth')) continue;
    const trusted = Object.fromEntries(cell.path.filter(event => event?.reason === 'birth' && Object.hasOwn(breeding, event.birth) && breeding[event.birth] && isValid(breeding[event.birth])).map(event => [event.birth, breeding[event.birth]]));
    const normalized = canonicalBirthPath(cell, trusted);
    if (normalized !== cell) { chars[id] = normalized; changed = true; }
  }
  return changed ? { ...data, fishes, chars } : data;
}

export function normalizeBirthCells(world, cells = Object.values(world.data.chars)) {
  for (const cell of cells) {
    const event = cell.path?.at(-1); if (cell.kind !== 'fish' || event?.reason !== 'birth') continue;
    const record = world.data.breeding?.[event.birth], inherited = record?.baby?.cells.find(item => item.id === cell.id);
    if (record?.status === 'born' && inherited && cell.entity === record.baby.id) Object.assign(cell, { x: inherited.x, y: inherited.y, ch: inherited.after });
  }
}

export function validBreedingRecord(record, data) {
  if (!record || typeof record.male !== 'string' || typeof record.female !== 'string' || record.male === record.female || !Number.isFinite(record.started) || record.started < 0 || record.id !== breedingId(record.male, record.female, record.started) || record.ends !== record.started + BREEDING_TIME || !Number.isFinite(record.at) || record.at < record.started || !['active', 'born', 'cancelled'].includes(record.status)) return false;
  const father = fishOrigin(data, record.male), mother = fishOrigin(data, record.female);
  if (father?.gender !== 'male' || mother?.gender !== 'female' || father.created > record.started || mother.created > record.started) return false;
  for (const gender of ['male', 'female']) {
    const ids = record.contact?.[gender], initial = record.initialPose?.[gender], current = record.pose?.[gender];
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string') || !initial || !current || ![initial.x, initial.y, current.x, current.y].every(Number.isInteger) || ![initial.facing, current.facing].every(facing => facing === 1 || facing === -1)) return false;
  }
  const initial = record.initialPose, current = record.pose, reflection = current.male.facing * initial.male.facing;
  if (current.female.facing * initial.female.facing !== reflection || deltaX(current.male.x, current.female.x) !== reflection * deltaX(initial.male.x, initial.female.x) || current.male.y - current.female.y !== initial.male.y - initial.female.y) return false;
  if (!record.motion || ![record.motion.cx, record.motion.cy].every(value => Number.isFinite(value) && value >= 0 && value <= 2)) return false;
  if (record.status !== 'born') return record.baby === undefined;
  const baby = record.baby;
  if (baby?.name !== undefined && fishNameError(baby.name, baby.cells?.length || 0)) return false;
  if (baby?.nameAuto !== undefined && (baby.nameAuto !== true || !Number.isInteger(baby.nameOrdinal) || baby.nameOrdinal < 1 || baby.name !== defaultFishName(baby.nick || '鱼', baby.nameOrdinal, baby.cells?.length || 0))) return false;
  if (!baby || baby.id !== `born:${record.id}` || !Number.isFinite(baby.created) || baby.created < record.ends || baby.created !== record.at || JSON.stringify(baby.parents) !== JSON.stringify([record.male, record.female]) || baby.gender !== (hash(`gender:${baby.id}`) % 2 ? 'male' : 'female') || !Array.isArray(baby.cells) || baby.cells.length < 2 || new Set(baby.cells.map(cell => cell.id)).size !== baby.cells.length) return false;
  const fc = baby.cells.filter(cell => cell.parent === record.male).length, mc = baby.cells.filter(cell => cell.parent === record.female).length;
  if (!fc || !mc || fc !== baby.fatherCount || mc !== baby.motherCount || fc + mc !== baby.cells.length || ![baby.fatherRemaining, baby.motherRemaining].every(count => Number.isInteger(count) && count >= 2)) return false;
  const owner = chooseOwner(record, fc, mc, baby.fatherRemaining, baby.motherRemaining), origin = owner === record.male ? father : mother;
  if (baby.owner !== owner || baby.actor !== origin.actor || baby.nick !== origin.nick) return false;
  const eyes = [...EYES], eye = baby.cells.some(cell => EYES.has(cell.before)) ? null : [...baby.cells].sort((a, b) => a.id.localeCompare(b.id))[hash(`eye-cell:${baby.id}`) % baby.cells.length].id;
  for (const cell of baby.cells) if (!record.contact[cell.parent === record.male ? 'male' : 'female'].includes(cell.id) || typeof cell.before !== 'string' || !/^#[0-9a-f]{6}$/i.test(cell.color) || ![cell.x, cell.y].every(Number.isInteger) || cell.x < 0 || cell.y < 0 || cell.after !== (cell.id === eye ? eyes[hash(`eye-glyph:${baby.id}`) % eyes.length] : cell.before)) return false;
  if (components(baby.cells).length !== 1 || new Set(baby.cells.map(cell => key(cell.x, cell.y))).size !== baby.cells.length) return false;
  return baby.cells.some(cell => EYES.has(cell.after));
}
export function inheritedGlyph(cell, initial, data) {
  let glyph = initial;
  for (const event of cell.path || []) if (event.reason === 'birth') {
    const record = data.breeding?.[event.birth], inherited = record?.baby?.cells?.find(item => item.id === cell.id);
    if (record?.status !== 'born' || !inherited || event.target !== record.baby.id || event.from !== inherited.parent || event.before !== glyph || inherited.before !== glyph || event.after !== inherited.after || event.t !== record.baby.created) return null;
    glyph = event.after;
  }
  return glyph;
}
