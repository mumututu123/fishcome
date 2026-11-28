import { WORLD_WIDTH, MAX_FLOOR } from './geography.js';
import { swimProgram } from './swim-program.js';

const poseBytes = 5 * Float64Array.BYTES_PER_ELEMENT;
const inputBytes = 40;
const pageBytes = 65536;
const grids = new WeakMap();

// Non-integer positions and breeding units retain their existing geometry
// predicates. Movement order, remainders and turn decisions live in the module.
let geometry;
const scalar = new WebAssembly.Instance(swimProgram, { geometry: {
  fits: (x, y, facing) => geometry.fits(x, y, facing),
  turns: (x, y, facing) => geometry.turns(x, y, facing)
} }).exports;
const scalarOffset = Number(scalar.__heap_base.value);
const scalarPose = new Float64Array(scalar.memory.buffer, scalarOffset, 5);
export function swimOne(fish, pivot, dt, speedX, speedY, direction, offset, avoid, probes) {
  scalarPose[0] = fish.x; scalarPose[1] = fish.y; scalarPose[2] = fish.facing;
  scalarPose[3] = fish.cx || 0; scalarPose[4] = fish.cy || 0;
  geometry = probes;
  try {
    return scalar.swim_one(scalarOffset, pivot, dt, speedX, speedY, direction.dx, direction.dy, offset, avoid);
  } finally {
    geometry = undefined;
  }
}
export const singlePose = scalarPose;

export function packedGrid(grid, count) {
  let packed = grids.get(grid);
  if (!packed) {
    packed = new PackedGrid(grid);
    grids.set(grid, packed);
  }
  packed.prepare(count);
  return packed;
}

// Numeric grid operations use compiled hulls. Only single legacy moves call back into world geometry.
export function gridProgram() {
  const missingHull = () => { throw new Error('Missing packed fish hull'); };
  return new WebAssembly.Instance(swimProgram, { geometry: { fits: missingHull, turns: missingHull } }).exports;
}

class PackedGrid {
  constructor(grid) {
    this.program = gridProgram();
    this.grid = grid;
    this.ownersOffset = Number(this.program.__heap_base.value);
    this.maskOffset = this.ownersOffset + grid.cells.byteLength;
    this.poseOffset = Math.ceil((this.maskOffset + WORLD_WIDTH * MAX_FLOOR) / 8) * 8;
    this.capacity = 0;
    this.ownersLength = grid.cells.length;
  }
  reserve(bytes) {
    const { memory } = this.program;
    const pages = Math.ceil((bytes - memory.buffer.byteLength) / pageBytes);
    if (pages > 0) memory.grow(pages);
    if (this.bytes?.buffer === memory.buffer) return;
    const oldCells = this.grid.cells;
    this.bytes = new Uint8Array(memory.buffer);
    this.words = new Int32Array(memory.buffer);
    this.doubles = new Float64Array(memory.buffer);
    this.grid.cells = new Int32Array(memory.buffer, this.ownersOffset, this.ownersLength);
    if (oldCells.length && oldCells.buffer !== memory.buffer) this.grid.cells.set(oldCells);
  }
  prepare(count) {
    if (this.capacity < count || this.shapes?.size > this.grid.layout.geometryLimit) {
      this.capacity = Math.max(this.capacity, count);
      this.inputOffset = this.poseOffset + this.capacity * poseBytes;
      this.trailsOffset = this.inputOffset + this.capacity * inputBytes;
      this.shapeEnd = this.trailsOffset + this.capacity * 4;
      this.shapes = new Map();
      this.swimmers = [];
      this.hulls = [];
      this.reserve(this.shapeEnd);
    }
    if (this.grid.obstacles && this.mask !== this.grid.obstacles) {
      this.mask = this.grid.obstacles;
      this.bytes.set(this.mask, this.maskOffset);
    }
  }
  shape(hull) {
    let ptr = this.shapes.get(hull);
    if (ptr !== undefined) return ptr;
    ptr = this.shapeEnd;
    const { xy, sweep, bounds } = hull;
    this.shapeEnd += 4 * (6 + xy.length + sweep.length);
    this.reserve(this.shapeEnd);
    const word = ptr / 4;
    this.words.set([xy.length / 2, bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, sweep.length / 3], word);
    this.words.set(xy, word + 6);
    this.words.set(sweep, word + 6 + xy.length);
    this.shapes.set(hull, ptr);
    return ptr;
  }
  put(index, swimmer, intent, avoid, previous) {
    const fish = swimmer.fish, pose = this.poseOffset / 8 + index * 5;
    const input = this.inputOffset / 8 + index * 5, word = input * 2;
    if (!previous || this.swimmers[index] !== swimmer || this.hulls[index] !== swimmer.hull) {
      const hull = this.shape(swimmer.hull);
      this.swimmers[index] = swimmer;
      this.hulls[index] = swimmer.hull;
      this.doubles[input] = swimmer.speedX;
      this.doubles[input + 1] = swimmer.speedY;
      this.words[word + 4] = swimmer.slot;
      this.words[word + 5] = hull;
    }
    const doubles = this.doubles;
    if (!previous || previous[swimmer.ordinal] !== index + 1) {
      doubles[pose] = fish.x;
      doubles[pose + 1] = fish.y;
      doubles[pose + 2] = fish.facing;
    }
    doubles[pose + 3] = fish.cx || 0;
    doubles[pose + 4] = fish.cy || 0;
    this.words[word + 6] = intent.dx;
    this.words[word + 7] = intent.dy;
    this.words[word + 8] = avoid;
  }
  advance(count, dt, start = 0) {
    this.program.swim(count, this.ownersOffset, this.maskOffset, WORLD_WIDTH, MAX_FLOOR,
      this.poseOffset + start * poseBytes, this.inputOffset + start * inputBytes, this.trailsOffset + start * 4, dt);
  }
}
