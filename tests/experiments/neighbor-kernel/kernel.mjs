const width = 1000, binSize = 10, columns = width / binSize;
const extent = 12 + Number.EPSILON * width * 4;
const sceneExtent = 16 + Number.EPSILON * width * 4;
function delta(a, b) {
  let d = a - b + 500;
  if (d >= 1000) d -= 1000;
  d += 1000;
  if (d >= 2000) d -= 2000; else if (d >= 1000) d -= 1000;
  return d - 500;
}
const columnAt = x => (x + columns) % columns;

// The source points and their collation ranks are already known at this boundary.
export function prepare({ points, scenery }) {
  return { points: points.map(([x, y, rank], index) => ({ x, y, rank, index })), scenery };
}

class Output {
  constructor(count) {
    this.offsets = new Uint32Array(count + 1);
    this.indices = new Uint32Array(Math.max(16, count * 32));
    this.length = 0;
  }
  append(index) {
    if (this.length === this.indices.length) {
      const larger = new Uint32Array(2 * this.length);
      larger.set(this.indices);
      this.indices = larger;
    }
    this.indices[this.length++] = index;
  }
  finish() { return { offsets: this.offsets, indices: this.indices.subarray(0, this.length) }; }
}

// A scenery cell can force a line-of-sight walk only from a queried scenery bin,
// exactly as in lifeContext. Fractional scenery still enables the walk, but never blocks a pixel.
function visibility(scenery) {
  const occupiedBins = new Set(), blocked = new Map();
  for (const [x, y] of scenery) {
    occupiedBins.add(Math.floor(y / binSize) * columns + Math.floor(x / binSize));
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    let line = blocked.get(y);
    if (!line) blocked.set(y, line = new Uint8Array(width));
    line[x] = 1;
  }
  function near(x, y) {
    if (!occupiedBins.size) return false;
    for (let bx = Math.floor((x - sceneExtent) / binSize); bx <= Math.floor((x + sceneExtent) / binSize); bx++) {
      for (let by = Math.floor((y - sceneExtent) / binSize); by <= Math.floor((y + sceneExtent) / binSize); by++) {
        if (occupiedBins.has(by * columns + columnAt(bx))) return true;
      }
    }
    return false;
  }
  function clear(x, y, dx, dy) {
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    for (let k = 1; k < steps; k++) {
      const line = blocked.get(Math.round(y + dy * k / steps));
      if (!line) continue;
      const col = Math.round(x + dx * k / steps);
      if (line[col < 0 ? col + width : col >= width ? col - width : col]) return false;
    }
    return true;
  }
  return { near, clear };
}

export function objects({ points, scenery }) {
  const bins = new Map(), sight = visibility(scenery), out = new Output(points.length);
  for (const p of points) {
    const key = Math.floor(p.y / binSize) * columns + Math.floor(p.x / binSize);
    let list = bins.get(key);
    if (!list) bins.set(key, list = []);
    list.push(p);
  }
  for (const p of points) {
    const hits = [], obstacles = sight.near(p.x, p.y);
    for (let bx = Math.floor((p.x - extent) / binSize); bx <= Math.floor((p.x + extent) / binSize); bx++) {
      for (let by = Math.floor((p.y - extent) / binSize); by <= Math.floor((p.y + extent) / binSize); by++) {
        const bin = bins.get(by * columns + columnAt(bx));
        if (!bin) continue;
        for (const q of bin) {
          if (q === p) continue;
          const distance = Math.max(Math.abs(delta(p.x, q.x)), Math.abs(p.y - q.y));
          if (distance <= 12 && (!obstacles || sight.clear(p.x, p.y, delta(q.x, p.x), q.y - p.y))) hits.push({ q, distance });
        }
      }
    }
    hits.sort((a, b) => a.distance - b.distance || a.q.rank - b.q.rank);
    for (const h of hits) out.append(h.q.index);
    out.offsets[p.index + 1] = out.length;
  }
  return out.finish();
}

export function flat({ points, scenery }, integerSort = false) {
  const n = points.length, xs = new Float64Array(n), ys = new Float64Array(n), ranks = new Uint32Array(n);
  const sight = visibility(scenery), out = new Output(n);
  const byRank = integerSort ? new Int32Array(n).fill(-1) : null, stride = 2 ** Math.ceil(Math.log2(n));
  let minRow = Infinity, maxRow = -Infinity;
  for (const { x, y, rank, index } of points) {
    xs[index] = x; ys[index] = y; ranks[index] = rank;
    if (integerSort) {
      if (rank >= n || byRank[rank] !== -1 || !Number.isInteger(x * 2) || !Number.isInteger(y * 2)) integerSort = false;
      else byRank[rank] = index;
    }
    const row = Math.floor(y / binSize);
    minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
  }
  const head = new Int32Array((maxRow - minRow + 1) * columns).fill(-1), next = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const key = (Math.floor(ys[i] / binSize) - minRow) * columns + Math.floor(xs[i] / binSize);
    next[i] = head[key]; head[key] = i;
  }
  const hits = new Uint32Array(n), distances = new Float64Array(n);
  const compare = (a, b) => distances[a] - distances[b] || ranks[a] - ranks[b];
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], obstacles = sight.near(x, y);
    let count = 0;
    const first = Math.max(minRow, Math.floor((y - extent) / binSize)), last = Math.min(maxRow, Math.floor((y + extent) / binSize));
    for (let bx = Math.floor((x - extent) / binSize); bx <= Math.floor((x + extent) / binSize); bx++) {
      for (let by = first; by <= last; by++) {
        for (let j = head[(by - minRow) * columns + columnAt(bx)]; j !== -1; j = next[j]) {
          if (i === j) continue;
          const distance = Math.max(Math.abs(delta(x, xs[j])), Math.abs(y - ys[j]));
          if (distance > 12 || (obstacles && !sight.clear(x, y, delta(xs[j], x), ys[j] - y))) continue;
          if (integerSort) hits[count++] = distance * 2 * stride + ranks[j];
          else { hits[count++] = j; distances[j] = distance; }
        }
      }
    }
    const sorted = hits.subarray(0, count);
    if (integerSort) {
      sorted.sort();
      for (let k = 0; k < count; k++) out.append(byRank[sorted[k] & (stride - 1)]);
    } else {
      sorted.sort(compare);
      for (let k = 0; k < count; k++) out.append(sorted[k]);
    }
    out.offsets[i + 1] = out.length;
  }
  return out.finish();
}

// Little-endian input: two counts, then (float64 x, float64 y, uint32 rank) per fish
// and (float64 x, float64 y) per scenery cell. Output: (N+1) offsets then neighbor indices.
export function encode({ points, scenery }) {
  const buf = new ArrayBuffer(8 + 20 * points.length + 16 * scenery.length);
  const v = new DataView(buf);
  v.setUint32(0, points.length, true); v.setUint32(4, scenery.length, true);
  let k = 8;
  for (const { x, y, rank } of points) {
    v.setFloat64(k, x, true); v.setFloat64(k + 8, y, true); v.setUint32(k + 16, rank, true); k += 20;
  }
  for (const [x, y] of scenery) { v.setFloat64(k, x, true); v.setFloat64(k + 8, y, true); k += 16; }
  return buf;
}
export function decode(buf, n) {
  const offsets = new Uint32Array(buf, 0, n + 1), indices = new Uint32Array(buf, offsets.byteLength);
  if (offsets[n] !== indices.length) throw Error('邻鱼响应的条目数不符');
  return { offsets, indices };
}
