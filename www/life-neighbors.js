import { WORLD_WIDTH, deltaX } from './geography.js';

const size = 10, columns = WORLD_WIDTH / size;
export function fishNeighbors(geometry, canSeeLine) {
  const { points, ordered, ranks } = geometry;
  const n = ordered.length, stride = 2 ** Math.ceil(Math.log2(Math.max(1, n)));
  const halfGrid = ordered.every(p => Number.isInteger(2 * p.x) && Number.isInteger(2 * p.y));
  const uniqueRanks = n === 0 || ranks.get(ordered[n - 1]) === n - 1;
  // Twice the distance is exact on a half-cell grid. Unique ranks fit below the stride.
  const numericOrder = halfGrid && uniqueRanks && stride * 25 < 2 ** 32;
  const scratch = geometry.scratch ??= {
    index: uniqueRanks ? ranks : new Map(ordered.map((p, i) => [p, i])),
    insertion: Array.from(points.values()), heads: [], next: new Int32Array(n),
    candidates: new Uint32Array(n), hits: new Uint32Array(n), distances: new Float64Array(n)
  };
  const { index, insertion, heads, next, candidates, hits, distances } = scratch;
  for (const row of Object.values(heads)) row.fill(-1);
  // Reverse insertion preserves the original order inside each ten-cell bin.
  for (let i = n - 1; i >= 0; i--) {
    const p = insertion[i], j = index.get(p);
    const row = heads[Math.floor(p.y / size)] ??= new Int32Array(columns).fill(-1);
    const col = Math.floor(p.x / size);
    next[j] = row[col]; row[col] = j;
  }
  function collect(p, radius) {
    const extent = radius + Number.EPSILON * WORLD_WIDTH * 4;
    const lo = Math.floor((p.y - extent) / size), hi = Math.floor((p.y + extent) / size);
    let count = 0;
    for (let bx = Math.floor((p.x - extent) / size); bx <= Math.floor((p.x + extent) / size); bx++) {
      const column = (bx + columns) % columns;
      for (let by = lo; by <= hi; by++) {
        const row = heads[by];
        if (row) for (let i = row[column]; i >= 0; i = next[i]) candidates[count++] = i;
      }
    }
    return count;
  }
  function nearby(p, radius) {
    const count = collect(p, radius), out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = ordered[candidates[i]];
    return out;
  }
  function horizontalDistance(a, b) {
    if (!halfGrid) return Math.abs(deltaX(a, b));
    const gap = Math.abs(a - b);
    return Math.min(gap, WORLD_WIDTH - gap);
  }
  const compare = (a, b) => distances[a] - distances[b] || ranks.get(ordered[a]) - ranks.get(ordered[b]);
  function sorted(p, obstacle) {
    const count = collect(p, 12);
    let visible = 0;
    for (let k = 0; k < count; k++) {
      const j = candidates[k], q = ordered[j];
      if (q === p) continue;
      const distance = Math.max(horizontalDistance(p.x, q.x), Math.abs(q.y - p.y));
      if (distance > 12 || obstacle && !canSeeLine(p, q)) continue;
      if (numericOrder) hits[visible++] = distance * 2 * stride + j;
      else { hits[visible++] = j; distances[j] = distance; }
    }
    const keys = hits.subarray(0, visible), out = new Array(visible);
    if (numericOrder) {
      keys.sort();
      for (let i = 0; i < visible; i++) out[i] = ordered[keys[i] & (stride - 1)];
    } else {
      keys.sort(compare);
      for (let i = 0; i < visible; i++) out[i] = ordered[keys[i]];
    }
    return out;
  }
  function crowded(p, radius, obstacle) {
    const count = collect(p, radius);
    let best, bestGap = 2, bestRank = Infinity, bestDistance = Infinity;
    for (let k = 0; k < count; k++) {
      const j = candidates[k], q = ordered[j];
      if (q === p) continue;
      const horizontal = horizontalDistance(q.x, p.x), vertical = Math.abs(q.y - p.y);
      const gap = Math.max(horizontal - p.halfWidth - q.halfWidth, vertical - p.halfHeight - q.halfHeight);
      if (gap > bestGap) continue;
      const distance = Math.max(halfGrid ? horizontal : horizontalDistance(p.x, q.x), vertical);
      if (distance > 12 || obstacle && !canSeeLine(p, q)) continue;
      const rank = numericOrder ? j : ranks.get(q);
      if (gap < bestGap || rank < bestRank || rank === bestRank && distance < bestDistance) {
        best = q; bestGap = gap; bestRank = rank; bestDistance = distance;
      }
    }
    return best;
  }
  return { nearby, sorted, crowded };
}
