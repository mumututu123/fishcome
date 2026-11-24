import { CONFIG, EYES, NEIGHBORS, bounds, cellPosition, components, hash, clone, key } from './engine.js';
import { defaultFishName, fishNameError } from './fish-profile.js';

export const CONTACT_TIME = 5000;
export const BREEDING_TIME = 3600000;
export function breedingId(male, female, started) { const pair = `${male}:${female}`; return `breed:${started}:${hash(pair).toString(16)}-${hash('pair:' + pair).toString(16)}`; }
export function fishOrigin(data, id) {
  const op = data.ops[id]; if (op?.kind === 'fish') return { actor: op.actor, nick: op.nick, gender: op.gender, created: op.t, name: op.name, size: op.cells.length };
  const record = typeof id === 'string' && id.startsWith('born:') ? data.breeding?.[id.slice(5)] : null;
  return record?.status === 'born' && record.baby?.id === id ? record.baby : undefined;
}
export function activeBreeding(data, id) { return Object.values(data.breeding || {}).find(record => record.status === 'active' && (record.male === id || record.female === id)); }
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
function cancel(record, now, reason) { record.status = 'cancelled'; record.reason = reason; record.at = now; }
export function normalizeBreeding(world, now) {
  world.data.breeding ||= {}; world.data.contacts ||= {};
  const taken = new Set();
  for (const record of Object.values(world.data.breeding).sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))) {
    if (record.status !== 'active') continue;
    if (!world.data.fishes[record.male] || !world.data.fishes[record.female]) { cancel(record, now, 'parent-gone'); continue; }
    if (taken.has(record.male) || taken.has(record.female)) { cancel(record, now, 'conflicting-pair'); continue; }
    taken.add(record.male); taken.add(record.female);
    if (record.pose) { Object.assign(world.data.fishes[record.male], record.pose.male); Object.assign(world.data.fishes[record.female], record.pose.female); }
  }
}
export function chooseOwner(record, fatherCount, motherCount, fatherRemaining, motherRemaining) {
  if (fatherCount !== motherCount) return fatherCount > motherCount ? record.male : record.female;
  if (fatherRemaining !== motherRemaining) return fatherRemaining > motherRemaining ? record.male : record.female;
  return hash(`owner:${record.id}`) % 2 ? record.male : record.female;
}
export function finishBreeding(world, now, transition) {
  normalizeBreeding(world, now);
  for (const record of Object.values(world.data.breeding)) {
    if (record.status !== 'active' || now < record.ends) continue;
    const father = world.data.fishes[record.male], mother = world.data.fishes[record.female], fatherCells = world.fishCells(record.male), motherCells = world.fishCells(record.female);
    const selectedFather = fatherCells.filter(cell => record.contact.male.includes(cell.id)), selectedMother = motherCells.filter(cell => record.contact.female.includes(cell.id));
    const selected = [...selectedFather, ...selectedMother], removed = new Set(selected.map(cell => cell.id)), remainingFather = fatherCells.filter(cell => !removed.has(cell.id)), remainingMother = motherCells.filter(cell => !removed.has(cell.id));
    const placed = selected.map(cell => ({ ...cell, ...cellPosition(cell.entity === father.id ? father : mother, cell) }));
    const occupants = world.fishOccupants(), parents = new Set([father.id, mother.id]);
    const viable = remainingFather.length >= 2 && remainingMother.length >= 2 && components(remainingFather).length === 1 && components(remainingMother).length === 1 && selectedFather.length > 0 && selectedMother.length > 0 && selected.length >= 2 && new Set(placed.map(cell => key(cell.x, cell.y))).size === placed.length && components(placed).length === 1 && placed.every(cell => [...(occupants.get(key(cell.x, cell.y)) || [])].every(id => parents.has(id)));
    if (!viable) { cancel(record, now, 'incomplete-bodies'); father.cx = father.cy = mother.cx = mother.cy = 0; world.dirty = true; continue; }
    const id = `born:${record.id}`, owner = chooseOwner(record, selectedFather.length, selectedMother.length, remainingFather.length, remainingMother.length), parent = owner === father.id ? father : mother;
    const body = bounds(placed), gender = hash(`gender:${id}`) % 2 ? 'male' : 'female';
    const eye = placed.some(cell => EYES.has(cell.ch)) ? null : [...placed].sort((a, b) => a.id.localeCompare(b.id))[hash(`eye-cell:${id}`) % placed.length].id;
    const eyes = [...EYES], eyeGlyph = eyes[hash(`eye-glyph:${id}`) % eyes.length];
    const bornCells = [];
    for (const cell of selected) {
      const p = cellPosition(cell.entity === father.id ? father : mother, cell), from = cell.entity, before = cell.ch, after = cell.id === eye ? eyeGlyph : before;
      bornCells.push({ id: cell.id, parent: from, before, after, color: cell.color, x: p.x - body.minX, y: p.y - body.minY });
      transition(cell, { kind: 'fish', entity: id, x: p.x - body.minX, y: p.y - body.minY, ch: after, editAt: now }, { id: `birth:${record.id}:${cell.id}`, t: now, reason: 'birth', birth: record.id, from, before, after });
    }
    record.baby = { id, actor: fishOrigin(world.data, parent.id)?.actor || parent.actor, nick: parent.nick, gender, created: now, parents: [father.id, mother.id], owner, fatherCount: selectedFather.length, motherCount: selectedMother.length, fatherRemaining: remainingFather.length, motherRemaining: remainingMother.length, cells: bornCells };
    const number = Object.values(world.data.fishes).filter(fish => fishOrigin(world.data, fish.id)?.actor === record.baby.actor).length + 1;
    Object.assign(record.baby, { name: defaultFishName(parent.nick || '鱼', number, selected.length), nameAuto: true, nameOrdinal: number });
    record.status = 'born'; record.at = now;
    world.data.fishes[id] = { id, actor: record.baby.actor, nick: record.baby.nick, gender, birth: record.id, parents: record.baby.parents, x: body.minX, y: body.minY, facing: 1, created: now, lastFed: now, hungerAt: now + CONFIG.hunger, cx: 0, cy: 0, posAt: now };
    world.data.fishes[id].name = record.baby.name;
    world.data.travel[id] = { since: now, days: {} };
    father.cx = father.cy = mother.cx = mother.cy = 0; father.posAt = mother.posAt = now;
    world.foodRevision++; world.dirty = true;
  }
}
export function updateContacts(world, now, groups, scenery) {
  world.data.contacts ||= {}; world.data.breeding ||= {};
  const taken = new Set(Object.values(world.data.breeding).filter(record => record.status === 'active').flatMap(record => [record.male, record.female]));
  const at = new Map(), eligible = new Map(), pairs = new Map();
  for (const [id, cells] of groups) {
    const fish = world.data.fishes[id], gender = fishOrigin(world.data, id)?.gender;
    if (!fish || taken.has(id) || !['male', 'female'].includes(gender)) continue;
    eligible.set(id, { fish, gender, cells });
    for (const cell of cells) { const p = cellPosition(fish, cell), k = key(p.x, p.y); if (!at.has(k)) at.set(k, new Set()); at.get(k).add(id); }
  }
  for (const [id, { fish, gender, cells }] of eligible) {
    if (gender !== 'male') continue;
    for (const cell of cells) {
      const p = cellPosition(fish, cell);
      for (const [dx, dy] of NEIGHBORS) {
        if (dx && dy && (scenery.has(key(p.x + dx, p.y)) || scenery.has(key(p.x, p.y + dy)))) continue;
        for (const other of at.get(key(p.x + dx, p.y + dy)) || []) if (eligible.get(other).gender === 'female') pairs.set(`${id}|${other}`, { male: id, female: other });
      }
    }
  }
  const contacts = {};
  for (const [key, pair] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
    if (taken.has(pair.male) || taken.has(pair.female)) continue;
    const prior = world.data.contacts[key], since = prior && now >= prior.lastAt && now - prior.lastAt <= CONFIG.step * 2 ? prior.since : now;
    contacts[key] = { ...pair, since, lastAt: now };
    if (now - since < CONTACT_TIME) continue;
    const father = world.data.fishes[pair.male], mother = world.data.fishes[pair.female], fc = groups.get(pair.male), mc = groups.get(pair.female), all = [...fc.map(cell => cellPosition(father, cell)), ...mc.map(cell => cellPosition(mother, cell))];
    if (new Set(all.map(p => `${p.x},${p.y}`)).size !== all.length) continue;
    const started = now, id = breedingId(pair.male, pair.female, started), initialPose = { male: pose(father), female: pose(mother) };
    world.data.breeding[id] = { id, ...pair, started, ends: started + BREEDING_TIME, at: now, status: 'active', contact: contactCells(father, fc, mother, mc, scenery), initialPose, pose: clone(initialPose), motion: { cx: 0, cy: 0 } };
    taken.add(pair.male); taken.add(pair.female); delete contacts[key]; world.dirty = true;
  }
  world.data.contacts = Object.fromEntries(Object.entries(contacts).filter(([, pair]) => !taken.has(pair.male) && !taken.has(pair.female)));
  world.data.contactAt = now;
}
export function motionUnits(world, groups) {
  const result = [], paired = new Set();
  for (const record of Object.values(world.data.breeding || {}).sort((a, b) => a.id.localeCompare(b.id))) {
    if (record.status !== 'active') continue;
    const members = [world.data.fishes[record.male], world.data.fishes[record.female]];
    if (members.some(fish => !fish)) continue;
    const placed = members.flatMap(fish => (groups.get(fish.id) || []).map(cell => ({ ...cell, ...cellPosition(fish, cell) }))), b = bounds(placed);
    const fish = { id: record.id, x: b.minX, y: b.minY, facing: 1, created: record.started, ...record.motion };
    result.push({ id: record.id, fish, cells: placed.map(cell => ({ ...cell, x: cell.x - b.minX, y: cell.y - b.minY })), members, offsets: members.map(member => ({ x: member.x - b.minX, y: member.y - b.minY, facing: member.facing })), record });
    for (const member of members) paired.add(member.id);
  }
  for (const [id, cells] of groups) if (!paired.has(id) && world.data.fishes[id]) result.push({ id, cells, fish: world.data.fishes[id], members: [world.data.fishes[id]] });
  return result;
}
export function commitUnit(unit, now) {
  if (unit.record) {
    unit.members.forEach((fish, index) => { const offset = unit.offsets[index]; fish.x = unit.fish.x + unit.fish.facing * offset.x; fish.y = unit.fish.y + offset.y; fish.facing = unit.fish.facing * offset.facing; });
    unit.record.pose = { male: pose(unit.members[0]), female: pose(unit.members[1]) }; unit.record.motion = { cx: unit.fish.cx, cy: unit.fish.cy }; unit.record.at = now;
  }
  for (const fish of unit.members) fish.posAt = now;
}
export function mergeBreeding(world, other) {
  world.data.breeding ||= {};
  for (const [id, record] of Object.entries(other.breeding || {})) {
    const old = world.data.breeding[id], terminal = record.status !== 'active', oldTerminal = old && old.status !== 'active';
    const born = record.status === 'born', oldBorn = old?.status === 'born';
    if (!old || born && !oldBorn || !oldBorn && terminal && !oldTerminal || born === oldBorn && terminal === oldTerminal && ((born ? record.at < old.at : record.at > old.at) || record.at === old.at && JSON.stringify(record).localeCompare(JSON.stringify(old)) > 0)) world.data.breeding[id] = clone(record);
  }
  if ((other.contactAt || 0) > (world.data.contactAt || 0)) { world.data.contacts = clone(other.contacts || {}); world.data.contactAt = other.contactAt; }
}
export function normalizeBirthCells(world) {
  for (const cell of Object.values(world.data.chars)) {
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
  if (current.female.facing * initial.female.facing !== reflection || current.male.x - current.female.x !== reflection * (initial.male.x - initial.female.x) || current.male.y - current.female.y !== initial.male.y - initial.female.y) return false;
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
