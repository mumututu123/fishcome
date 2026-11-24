import { WORLD_WIDTH, worldKey, wrapX, deltaX, nearX } from './geography.js';
import { validInitialWeed } from './genesis.js';
import { densityField, growthChance, weedExpires } from './ecology.js';
export const HOUR = 3600000;
export const GREENS = ['#3d9854', '#48aa5d', '#55bc68', '#66cb74', '#79da84', '#92e59a'];
const neighbors = [-1, 0, 1].flatMap(x => [-1, 0, 1].map(y => [x, y])).filter(([x, y]) => x || y);
const key = worldKey;
export function growthRoll(source, hour, hash) { return hash(`seaweed-roll:${source}:${hour}`) % 10000 < 100; }
export function weedId(source, hour, hash) { return `seaweed:${hour}:${hash(source).toString(16)}-${hash('id:' + source).toString(16)}`; }
export function validWildCell(cell, config, hash, initial) {
  const wild = cell.wild; let glyph = '草'; for (const event of cell.path || []) if (event.reason === 'birth') { if (event.before !== glyph) return false; glyph = event.after; }
  if (wild?.origin !== undefined) return validInitialWeed(cell, initial) && Array.isArray(cell.path) && ['seaweed', 'fish', 'food', 'scene', 'burn'].includes(cell.kind) && (['scene', 'burn'].includes(cell.kind) || cell.ch === glyph);
  return wild && Array.isArray(cell.path) && typeof wild.source === 'string' && /^(floor:|cell:|tip:)/.test(wild.source) && Number.isInteger(wild.hour) && wild.hour >= 0 && cell.id === weedId(wild.source, wild.hour, hash) && growthRoll(wild.source, wild.hour, hash) && typeof wild.plant === 'string' && wild.plant.startsWith('seaweed:') && Number.isInteger(wild.index) && wild.index >= 0 && wild.index < Math.max(config.depth, 120) && Number.isInteger(wild.x) && wild.x >= 0 && wild.x < config.width && Number.isInteger(wild.y) && wild.y >= 0 && wild.y < Math.max(config.depth, 120) && (['scene', 'burn'].includes(cell.kind) || (cell.ch === glyph && cell.color === GREENS[hash(cell.id) % GREENS.length])) && cell.payer === '' && cell.created === wild.hour * HOUR && ['seaweed', 'fish', 'food', 'scene', 'burn'].includes(cell.kind) && (cell.kind !== 'seaweed' || (cell.entity === wild.plant && cell.path.length === 0)) && (wild.index !== 0 || wild.plant === cell.id);
}
function plants(chars) {
  const groups = new Map();
  for (const cell of Object.values(chars)) if (cell.kind === 'seaweed') { if (!groups.has(cell.entity)) groups.set(cell.entity, []); groups.get(cell.entity).push(cell); }
  for (const cells of groups.values()) cells.sort((a, b) => a.wild.index - b.wild.index || a.id.localeCompare(b.id));
  return groups;
}
function occupied(world, config, monument) {
  const blocked = new Set(world.sceneryMap().keys());
  for (const p of world.fishMap().keys()) blocked.add(p);
  for (const cell of Object.values(world.data.chars)) if (cell.kind === 'food' || cell.kind === 'seaweed') blocked.add(key(cell.x, cell.y));
  monument.rows.forEach((row, dy) => Array.from(row).forEach((ch, dx) => { if (ch !== ' ') blocked.add(key(monument.x + dx, monument.y + dy)); }));
  return blocked;
}
export function updateSeaweed(world, now, config, monument, hash, transition) {
  const currentHour = Math.floor(now / HOUR);
  world.data.seaweedHour ??= currentHour;
  if (world.data.seaweedHour >= currentHour && !Object.values(world.data.chars).some(cell => cell.kind === 'seaweed')) return;
  const scenery = world.sceneryMap(), groups = plants(world.data.chars), blocked = occupied(world, config, monument);
  const circular = config.width === WORLD_WIDTH, canonical = x => circular ? wrapX(x) : x, bottom = x => circular ? world.floorAt(x) : config.depth;
  const fits = (x, y) => (circular || x >= 0 && x < config.width) && y >= 0 && y < bottom(x) && !blocked.has(key(x, y));
  const density = world.ambient ? densityField(world, scenery) : null;
  // A severed stem or removed support becomes loose, edible food.
  for (const cells of groups.values()) {
    const root = cells[0], source = root.wild.source, candidate = source.startsWith('cell:') ? world.data.chars[source.slice(5)] : null, support = candidate?.kind === 'scene' ? candidate : null;
    const scene = support && world.data.scenes[support.entity];
    const floorX = source.startsWith('floor:') ? +source.slice(6) : null;
    let connected = root.wild.index === 0 && (floorX !== null ? Math.max(Math.abs(deltaX(root.x, floorX)), Math.abs(root.y - bottom(floorX))) === 1 && root.y < bottom(root.x) : !!scene && Math.max(Math.abs(deltaX(root.x, scene.x + support.x)), Math.abs(root.y - scene.y - support.y)) === 1);
    for (const [index, cell] of cells.entries()) {
      if (index && (cell.wild.index !== cells[index - 1].wild.index + 1 || Math.max(Math.abs(deltaX(cell.x, cells[index - 1].x)), Math.abs(cell.y - cells[index - 1].y)) !== 1)) connected = false;
      if (blocked.has(key(cell.x, cell.y)) && scenery.has(key(cell.x, cell.y))) connected = false;
      if (!connected) { transition(cell, { kind: 'food', entity: '', born: now, fall: 0 }, { id: `uproot:${cell.id}`, t: now, reason: 'uproot' }); world.foodRevision++; world.dirty = true; }
    }
  }
  // Use one reproducible trial per source and hour; replicas do not reroll.
  for (let hour = world.data.seaweedHour + 1; hour <= currentHour; hour++) {
    const at = hour * HOUR, sources = [];
    for (let x = 0; x < config.width; x++) sources.push({ id: `floor:${x}`, x, y: bottom(x), created: 0 });
    for (const { cell, scene } of scenery.values()) sources.push({ id: `cell:${cell.id}`, x: scene.x + cell.x, y: scene.y + cell.y, created: Math.max(cell.created || 0, scene.posAt || 0) });
    for (const cells of plants(world.data.chars).values()) { const tip = cells.at(-1); sources.push({ id: `tip:${tip.id}`, x: tip.x, y: tip.y, created: tip.created, plant: tip.entity, index: tip.wild.index + 1 }); }
    sources.sort((a, b) => a.id.localeCompare(b.id));
    for (const source of sources) {
      if (source.created > at - HOUR || !growthRoll(source.id, hour, hash)) continue;
      if (density && hash(`seaweed-roll:${source.id}:${hour}`) % 10000 >= growthChance(density(source.x, source.y)) * 10000) continue;
      const id = weedId(source.id, hour, hash); if (world.data.chars[id]) continue;
      if (world.ambient && weedExpires({ id, created: at }, world.data.ecology) <= now) continue;
      const choices = (source.plant ? [[-1, -1], [0, -1], [1, -1]] : neighbors).map(([dx, dy]) => ({ x: canonical(source.x + dx), y: source.y + dy })).filter(p => fits(p.x, p.y));
      if (!choices.length) continue;
      const p = choices[hash(`seaweed-place:${id}`) % choices.length], plant = source.plant || id;
      world.data.chars[id] = { id, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], kind: 'seaweed', entity: plant, x: p.x, y: p.y, created: at, moveAt: now, path: [], wild: { source: source.id, hour, plant, index: source.index || 0, x: p.x, y: p.y } };
      blocked.add(key(p.x, p.y)); world.dirty = true;
    }
  }
  world.data.seaweedHour = Math.max(world.data.seaweedHour, currentHour);
  // Discrete bends keep adjacent segments together and check the swept path.
  const phase = Math.floor(now / 2000);
  for (const [id, cells] of plants(world.data.chars)) {
    if (cells.length <= 2) continue;
    for (const cell of cells) blocked.delete(key(cell.x, cell.y));
    const direction = hash(`seaweed-sway:${id}:${phase}`) % 3 - 1, proposed = [{ x: cells[0].x, y: cells[0].y }];
    let safe = fits(cells[0].x, cells[0].y);
    for (let index = 1; index < cells.length; index++) {
      const cell = cells[index], previous = proposed[index - 1], target = cells[0].x + Math.round(direction * Math.min(3, index) / 2), from = circular ? nearX(cell.x, cells[0].x) : cell.x;
      const x = Math.max(previous.x - 1, Math.min(previous.x + 1, from + Math.sign(target - from))), y = cell.y;
      for (let swept = Math.min(from, x); swept <= Math.max(from, x); swept++) if (!fits(swept, y)) safe = false;
      proposed.push({ x, y });
    }
    if (safe) for (const [index, cell] of cells.entries()) if (cell.x !== canonical(proposed[index].x)) { cell.swayFromX = cell.x; cell.swayAt = now; cell.x = canonical(proposed[index].x); cell.moveAt = now; world.dirty = true; }
    for (const cell of cells) blocked.add(key(cell.x, cell.y));
  }
}
