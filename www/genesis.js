import { hash, MONUMENT } from './engine.js';
import { makeTerrain, WORLD_WIDTH, wrapX, worldKey } from './geography.js';
import { GREENS, HOUR } from './seaweed.js';

export const INITIAL_FISH_NAME = '默默无名的鱼';
const DRAWINGS = [[' /\\ ', '<==o>', ' \\/ '], [' /\\ ', '<oo>', ' \\/ '], ['  __ ', '<===o>', '  -- ']];
const COLORS = ['#8be7df', '#f7ca79', '#c3a6ef', '#ef9fa8', '#97d899'];
function uuid(seed) {
  const hex = [0, 1, 2, 3].map(i => hash(`${seed}:${i}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

// Reproduce only the birth records. Living entities subsequently use the normal ecology.
export function initialLife(root, at) {
  const terrain = makeTerrain(root, at), chars = {}, ops = {}, occupied = new Set();
  const monumentWidth = Math.max(...MONUMENT.rows.map(row => Array.from(row).length));
  const monumentY = Math.min(...Array.from({ length: monumentWidth }, (_, i) => terrain.depths[wrapX(MONUMENT.x + i)])) - MONUMENT.rows.length;
  MONUMENT.rows.forEach((row, dy) => Array.from(row).forEach((ch, dx) => { if (ch !== ' ') occupied.add(worldKey(MONUMENT.x + dx, monumentY + dy)); }));
  for (let x = 0; x < WORLD_WIDTH; x++) {
    if (hash(`initial-grass:${root}:${x}`) % 10000 >= 100) continue;
    const y = terrain.depths[x] - 1;
    if (occupied.has(worldKey(x, y))) continue;
    const id = `seaweed:initial:${root}:${x}`;
    chars[id] = { id, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], kind: 'seaweed', entity: id, x, y, created: at, moveAt: at, path: [], wild: { source: `floor:${x}`, hour: Math.floor(at / HOUR), plant: id, index: 0, x, y, origin: root } };
    occupied.add(worldKey(x, y));
  }
  const count = 2 + hash(`initial-fish-count:${root}`) % 9;
  for (let index = 0; index < count; index++) {
    const seed = `initial-fish:${root}:${index}`, id = uuid(seed), rows = DRAWINGS[hash(`${seed}:body`) % DRAWINGS.length], color = COLORS[hash(`${seed}:color`) % COLORS.length];
    const cells = rows.flatMap((row, y) => Array.from(row).flatMap((ch, x) => ch === ' ' ? [] : [{ x, y, ch, color }]));
    const startX = hash(`${seed}:x`) % WORLD_WIDTH, startY = 5 + hash(`${seed}:y`) % 68;
    let position;
    // A deterministic search also handles the rare overlap with another initial fish.
    for (let attempt = 0; attempt < WORLD_WIDTH * 74; attempt++) {
      const x = wrapX(startX + attempt), y = 1 + (startY - 1 + Math.floor(attempt / WORLD_WIDTH)) % 74;
      if (cells.every(cell => y + cell.y < terrain.depths[wrapX(x + cell.x)] && !occupied.has(worldKey(x + cell.x, y + cell.y)))) { position = { x, y }; break; }
    }
    if (!position) throw new Error('初始鱼没有可用水域');
    ops[id] = { id, actor: `ocean:${root}:${index}`, nick: '海洋', name: INITIAL_FISH_NAME, gender: hash(`${seed}:gender`) % 2 ? 'male' : 'female', t: at, roots: [root], kind: 'fish', ...position, cells, cost: cells.length, genesis: root };
    for (const cell of cells) occupied.add(worldKey(position.x + cell.x, position.y + cell.y));
  }
  return { chars, ops };
}

export function initialSources(roots) {
  const cache = new Map();
  return root => {
    if (!Number.isFinite(roots?.[root])) return undefined;
    if (!cache.has(root)) cache.set(root, initialLife(root, roots[root]));
    return cache.get(root);
  };
}
export function validInitialOp(op, sources) {
  const expected = sources(op?.genesis)?.ops[op?.id];
  return !!expected && JSON.stringify(op) === JSON.stringify(expected);
}
export function validInitialWeed(cell, sources) {
  const expected = sources?.(cell?.wild?.origin)?.chars[cell?.id];
  return !!expected && cell.payer === '' && cell.created === expected.created && JSON.stringify(cell.wild) === JSON.stringify(expected.wild) && (['scene', 'burn'].includes(cell.kind) || cell.color === expected.color) && (cell.kind !== 'seaweed' || cell.entity === expected.entity && cell.path.length === 0);
}
