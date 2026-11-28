import { WORLD_WIDTH } from './geography.js';
import { gridProgram, packedGrid } from './swim-kernel.js';

const rowBlock = 8;
const align = value => Math.ceil(value / 8) * 8;

// The moving grid already owns the live fish cells. This workspace borrows its
// spare memory after all hulls for the synchronous contact pass.
export class ContactField {
  constructor(grid, roles, scenery) {
    const core = packedGrid(grid, 1);
    this.program = core.program;
    this.owners = core.ownersOffset;
    const cells = grid.cells.length;
    this.rows = cells / WORLD_WIDTH;
    this.walls = align(core.shapeEnd);
    this.occupiedPtr = this.walls + cells;
    this.floorPtr = align(this.occupiedPtr + cells);
    this.prefixPtr = this.floorPtr + WORLD_WIDTH * 8;
    this.rolesPtr = this.prefixPtr + (WORLD_WIDTH + 1) * (this.rows + 1) * 4;
    this.edges = align(this.rolesPtr + roles.length);
    this.roles = roles.length;
    this.nextShape = this.edges + 4 * WORLD_WIDTH * rowBlock * 8;
    // Each eligible glyph occupies a different cell. Distinct ordered bodies
    // therefore need at most one pair of coordinates per cell.
    core.reserve(this.nextShape + cells * 8);
    this.buffer = core.program.memory.buffer;
    this.shapes = new Map();
    this.xy = new Int32Array(this.buffer, this.nextShape, 2 * cells);
    this.output = new Float64Array(this.buffer, this.edges, 4 * WORLD_WIDTH * rowBlock);
    this.occupied = new Uint8Array(this.buffer, this.occupiedPtr, cells);
    this.totals = new Uint32Array(this.buffer, this.prefixPtr, (WORLD_WIDTH + 1) * (this.rows + 1));
    const walls = new Uint8Array(this.buffer, this.walls, cells);
    walls.fill(0);
    for (const key of scenery.keys()) {
      const sep = key.indexOf(','), x = Number(key.slice(0, sep)), y = Number(key.slice(sep + 1));
      if (Number.isInteger(x) && x >= 0 && x < WORLD_WIDTH && Number.isInteger(y) && y >= 0 && y < this.rows) {
        walls[y * WORLD_WIDTH + x] = 1;
      }
    }
    new Uint8Array(this.buffer, this.rolesPtr, roles.length).set(roles);
  }
  prefix(floors, height, scale) {
    this.height = height;
    new Float64Array(this.buffer, this.floorPtr, WORLD_WIDTH).set(floors);
    this.program.density_prefix(this.prefixPtr, this.owners, this.occupiedPtr, this.floorPtr, WORLD_WIDTH, height, scale);
    return this.totals;
  }
  hasNeighbors() {
    return this.program.adjacent_pairs(this.owners, this.rolesPtr, this.walls, 0, WORLD_WIDTH, 0, 0, 1, this.roles, 0, this.rows, 0, 0, 1);
  }
  candidates(radius, scale, numerator, denominator) {
    const result = new Set();
    for (let row = 0; row < this.rows; row += rowBlock) {
      const count = this.program.adjacent_pairs(this.owners, this.rolesPtr, this.walls, this.height ? this.prefixPtr : 0,
        WORLD_WIDTH, this.height || 0, radius, scale, this.roles, row, Math.min(this.rows, row + rowBlock),
        this.edges, numerator, denominator);
      for (let i = 0; i < count; i++) result.add(this.output[i]);
    }
    return result;
  }
  shape(xy) {
    let ptr = this.shapes.get(xy);
    if (ptr === undefined) {
      ptr = this.nextShape;
      this.nextShape += 4 * xy.length;
      this.xy.set(xy, (ptr - this.xy.byteOffset) / 4);
      this.shapes.set(xy, ptr);
    }
    return ptr;
  }
  midpoint(father, mother, male, female) {
    return this.program.canonical_midpoint(this.walls, WORLD_WIDTH, this.shape(male), male.length / 2,
      father.x, father.y, father.facing, this.shape(female), female.length / 2, mother.x, mother.y, mother.facing);
  }
}

let independent;

// Public density queries retain their snapshot while later steps reuse the grid.
export function densityPrefix(occupied, owners, floors, height, scale) {
  const program = independent ??= gridProgram(), base = Number(program.__heap_base.value);
  const width = floors.length, count = occupied.length;
  const source = base + (owners ? count * 4 : 0), water = align(source + count);
  const sum = water + width * 8, length = (width + 1) * (height + 1);
  const pages = Math.ceil((sum + length * 4 - program.memory.buffer.byteLength) / 65536);
  if (pages > 0) program.memory.grow(pages);
  const { buffer } = program.memory;
  if (owners) {
    const cells = new Int32Array(buffer, base, count);
    const input = owners.subarray ? owners.subarray(0, count) : owners.slice(0, count);
    cells.set(input);
    if (input.length < count) cells.fill(0, input.length);
  }
  new Uint8Array(buffer, source, count).set(occupied);
  new Float64Array(buffer, water, width).set(floors);
  program.density_prefix(sum, owners ? base : 0, source, water, width, height, scale);
  return new Uint32Array(buffer, sum, length).slice();
}
