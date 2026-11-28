import { hash as random } from './world-hash.js';
export const WORLD_WIDTH = 1000;
export const MIN_FLOOR = 80, MAX_FLOOR = 100;
export function wrapX(x) {
  if (typeof x !== 'number' || x < -WORLD_WIDTH || x >= 2 * WORLD_WIDTH) return ((x % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
  // Retain the addition before reducing so fractional positions round exactly
  // as they did in older saves. Ordinary adjacent cells need no division.
  const shifted = (x >= WORLD_WIDTH ? x - WORLD_WIDTH : x) + WORLD_WIDTH;
  if (shifted >= 2 * WORLD_WIDTH) return shifted - 2 * WORLD_WIDTH;
  return shifted >= WORLD_WIDTH ? shifted - WORLD_WIDTH : shifted;
}
// Integer water cells recur across movement, contacts and sight. Reuse their
// string keys; old fractional coordinates keep the original wrap semantics.
const waterKeys = Array.from({ length: MAX_FLOOR }, () => []);
export function worldKey(x, y) {
  if (Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < MAX_FLOOR) {
    const column = x >= 0 && x < WORLD_WIDTH ? x : wrapX(x);
    return waterKeys[y][column] ??= `${column},${y}`;
  }
  return `${wrapX(x)},${y}`;
}
export const deltaX = (x, reference) => wrapX(x - reference + WORLD_WIDTH / 2) - WORLD_WIDTH / 2;
export const nearX = (x, reference) => reference + deltaX(x, reference);
export function makeTerrain(seed, createdAt) {
  const span = 50, anchors = Array.from({ length: WORLD_WIDTH / span }, (_, i) => MIN_FLOOR + random(`seabed:${seed}:${i}`) % (MAX_FLOOR - MIN_FLOOR + 1));
  const depths = Array.from({ length: WORLD_WIDTH }, (_, x) => { const index = Math.floor(x / span), fraction = (x % span) / span; return Math.round(anchors[index] * (1 - fraction) + anchors[(index + 1) % anchors.length] * fraction); });
  return { version: 1, seed, createdAt, depths };
}
export function terrainOf(data) {
  if (data.terrain) return data.terrain;
  const roots = Object.entries(data.roots || {}).sort(([a, at], [b, bt]) => at - bt || a.localeCompare(b));
  const [seed, at] = roots[0] || ['legacy-sea', 0]; return makeTerrain(seed, at);
}
export function validTerrain(terrain, roots) {
  return !!terrain && terrain.version === 1 && typeof terrain.seed === 'string' && roots?.[terrain.seed] === terrain.createdAt && JSON.stringify(terrain) === JSON.stringify(makeTerrain(terrain.seed, terrain.createdAt));
}
export function chooseTerrain(left, right) { return left.createdAt < right.createdAt || left.createdAt === right.createdAt && left.seed <= right.seed ? left : right; }
export function floorAt(data, x) { return terrainOf(data).depths[Math.floor(wrapX(x))]; }
export function waterAt(data, x, y) { return Number.isFinite(x) && Number.isFinite(y) && y >= 0 && y < floorAt(data, x); }
