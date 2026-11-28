import { WORLD_WIDTH, MAX_FLOOR, deltaX } from './geography.js';

export function fishNeighbors(geometry, canSeeLine) {
  const { points, ordered, ranks } = geometry;
  const n = ordered.length, stride = 2 ** Math.ceil(Math.log2(Math.max(1, n)));
  const halfGrid = ordered.every(p => Number.isInteger(2 * p.x) && Number.isInteger(2 * p.y));
  const uniqueRanks = n === 0 || ranks.get(ordered[n - 1]) === n - 1;
  const size = uniqueRanks ? 5 : 10, columns = WORLD_WIDTH / size;
  // Twice the distance is exact on a half-cell grid. Unique ranks fit below the stride.
  const numericOrder = halfGrid && uniqueRanks && stride * 25 < 2 ** 32;
  const scratch = geometry.scratch ??= {
    rows: [], bins: [], found: [], hits: new Uint32Array(n), distances: new Float64Array(n)
  };
  const { rows, bins, found, hits, distances } = scratch;
  for (const bin of bins) bin.length = 0;
  for (const p of points.values()) {
    const row = rows[Math.floor(p.y / size)] ??= [];
    const col = Math.floor(p.x / size);
    if (!row[col]) { row[col] = []; bins.push(row[col]); }
    row[col].push(p);
  }
  function collect(p, radius) {
    const extent = radius + Number.EPSILON * WORLD_WIDTH * 4;
    const lo = Math.floor((p.y - extent) / size), hi = Math.floor((p.y + extent) / size);
    found.length = 0;
    for (let bx = Math.floor((p.x - extent) / size); bx <= Math.floor((p.x + extent) / size); bx++) {
      const column = (bx + columns) % columns;
      for (let by = lo; by <= hi; by++) {
        const bin = rows[by]?.[column];
        if (bin?.length) found.push(bin);
      }
    }
    return found;
  }
  function visitPairPartners(p, remaining, obstacles, visit) {
    let count = 0;
    for (const bin of collect(p, 12)) for (const q of bin) {
      if (geometry.ordinalIds ? p.slot >= q.slot : p.id >= q.id) continue;
      if (Math.abs(p.y - q.y) > 12) continue;
      const forward = horizontalDistance(p.x, q.x) <= 12;
      if (forward && (!obstacles[p.slot] || canSeeLine(p, q)) ||
          (halfGrid ? forward : horizontalDistance(q.x, p.x) <= 12) && (!obstacles[q.slot] || canSeeLine(q, p))) {
        hits[count++] = q.slot;
      }
    }
    const partners = hits.subarray(0, count).sort();
    count = Math.min(count, remaining);
    for (let i = 0; i < count; i++) visit(p, ordered[partners[i]]);
    return count;
  }
  function horizontalDistance(a, b) {
    if (!halfGrid) return Math.abs(deltaX(a, b));
    const gap = Math.abs(a - b);
    return Math.min(gap, WORLD_WIDTH - gap);
  }
  const compare = (a, b) => distances[a] - distances[b] || ranks.get(ordered[a]) - ranks.get(ordered[b]);
  function sorted(p, obstacle, available) {
    const bins = collect(p, 12);
    // School formation takes just four neighbors. The packed rank is unique,
    // so a farther candidate cannot displace a confirmed visible companion.
    const topFour = numericOrder && available;
    let visible = 0;
    for (const bin of bins) for (const q of bin) {
      const j = q.slot;
      if (q === p || available && !available[j]) continue;
      const distance = Math.max(horizontalDistance(p.x, q.x), Math.abs(q.y - p.y));
      if (distance > 12) continue;
      const rank = distance * 2 * stride + j;
      if (topFour && visible === 4 && rank >= hits[3]) continue;
      if (obstacle && !canSeeLine(p, q)) continue;
      if (topFour) {
        const last = Math.min(visible, 3);
        let i = last;
        while (i > 0 && hits[i - 1] > rank) { hits[i] = hits[i - 1]; i--; }
        hits[i] = rank;
        visible = last + 1;
      } else if (numericOrder) hits[visible++] = rank;
      else { hits[visible++] = j; distances[j] = distance; }
    }
    const keys = hits.subarray(0, visible), out = new Array(available ? Math.min(4, visible) : visible);
    if (numericOrder) {
      if (!topFour) keys.sort();
      for (let i = 0; i < out.length; i++) out[i] = ordered[keys[i] & (stride - 1)];
    } else {
      keys.sort(compare);
      for (let i = 0; i < out.length; i++) out[i] = ordered[keys[i]];
    }
    return out;
  }
  function crowded(p, radius, obstacle) {
    const bins = collect(p, radius);
    let best, bestGap = 2, bestRank = Infinity, bestDistance = Infinity;
    for (const bin of bins) for (const q of bin) {
      const j = q.slot;
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
  let crowdIndex;
  function crowdedHalfGrid(p, radius, obstacle) {
    const binRows = Math.ceil(MAX_FLOOR / size) + 1;
    if (crowdIndex === undefined) {
      crowdIndex = geometry.crowdIndex ??= {
        heads: new Uint32Array(binRows * columns), next: new Uint32Array(n), bounds: new Float64Array(4 * n),
        edges: new Float64Array(binRows * columns * 4)
      };
      const { heads, next, bounds, edges } = crowdIndex;
      heads.fill(0);
      for (let j = 0; j < n; j++) {
        const q = ordered[j], b = j * 4;
        if (!(q.x >= 0 && q.x < WORLD_WIDTH && q.y >= 0 && q.y <= MAX_FLOOR) ||
            !Number.isInteger(2 * q.halfWidth) || !Number.isInteger(2 * q.halfHeight) ||
            q.halfWidth >= WORLD_WIDTH || q.halfHeight >= WORLD_WIDTH) {
          crowdIndex = false;
          break;
        }
        const bin = Math.floor(q.y / size) * columns + Math.floor(q.x / size);
        const e = 4 * bin;
        const left = q.x - q.halfWidth, right = q.x + q.halfWidth;
        const top = q.y - q.halfHeight, bottom = q.y + q.halfHeight;
        edges[e] = heads[bin] ? Math.min(edges[e], left) : left;
        edges[e + 1] = heads[bin] ? Math.max(edges[e + 1], right) : right;
        edges[e + 2] = heads[bin] ? Math.min(edges[e + 2], top) : top;
        edges[e + 3] = heads[bin] ? Math.max(edges[e + 3], bottom) : bottom;
        next[j] = heads[bin];
        heads[bin] = j + 1;
        bounds[b] = q.x;
        bounds[b + 1] = q.y;
        bounds[b + 2] = q.halfWidth;
        bounds[b + 3] = q.halfHeight;
      }
    }
    if (!crowdIndex) return crowded(p, radius, obstacle);
    const { heads, next, bounds, edges } = crowdIndex;
    const px = p.x, py = p.y, pw = p.halfWidth, ph = p.halfHeight, i = p.slot;
    const extent = radius + Number.EPSILON * WORLD_WIDTH * 4;
    const lo = Math.max(0, Math.floor((py - extent) / size));
    const hi = Math.min(binRows - 1, Math.floor((py + extent) / size));
    const first = Math.floor((px - extent) / size), last = Math.floor((px + extent) / size);
    let best = Infinity, bestGap = 2;
    for (let by = lo; by <= hi; by++) {
      const row = by * columns;
      for (let bx = first; bx <= last; bx++) {
        const col = bx < 0 ? bx + columns : bx >= columns ? bx - columns : bx;
        const nearX = bx < 0 ? px + WORLD_WIDTH : bx >= columns ? px - WORLD_WIDTH : px;
        let link = heads[row + col];
        if (!link) continue;
        const e = 4 * (row + col), xLimit = pw + bestGap, yLimit = ph + bestGap;
        if (edges[e] > nearX + xLimit || edges[e + 1] < nearX - xLimit ||
            edges[e + 2] > py + yLimit || edges[e + 3] < py - yLimit) continue;
        for (; link; link = next[link - 1]) {
          const j = link - 1;
          if (i === j) continue;
          const b = j * 4;
          const dx = Math.abs(bounds[b] - nearX), dy = Math.abs(bounds[b + 1] - py);
          if (dx > 12 || dy > 12) continue;
          const gap = Math.max(dx - pw - bounds[b + 2], dy - ph - bounds[b + 3]);
          if (gap > bestGap || gap === bestGap && j >= best || obstacle && !canSeeLine(p, ordered[j])) continue;
          best = j;
          bestGap = gap;
        }
      }
    }
    return ordered[best];
  }

  return { visitPairPartners, sorted, crowded: numericOrder ? crowdedHalfGrid : crowded };
}
