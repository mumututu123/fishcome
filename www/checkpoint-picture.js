import { CONFIG, sceneryCount } from './engine.js';

const character = cell => cell && cell.kind !== 'burn' ? 1 : 0;
const liveMetadata = world => ({ id: world.id, roots: world.roots, participants: Object.keys(world.data.participants).length || 1, counts: world.counts() });

class PictureState {
  constructor(world) {
    this.world = world;
    this.food = new Map();
    this.nextExpiry = Infinity;
    this.edit = 0;
    this.fish = Object.keys(world.data.fishes).length;
    this.characters = 0;
    this.beforeScan = new Map();
  }
  foodChanged(id, cell) {
    const expiry = cell?.kind === 'food' ? cell.born + CONFIG.foodLife : 0;
    if (expiry > this.world.data.tick) {
      this.food.set(id, expiry);
      this.nextExpiry = Math.min(this.nextExpiry, expiry);
    } else this.food.delete(id);
  }
  async scan(current) {
    if (!this.beforeScan) return;
    // Rows may disappear between slices. Remember only the contributions
    // changed since this cut; the patch also adjusts the running total.
    const chars = this.world.data.chars;
    const ids = Object.keys(chars);
    let start = performance.now();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.characters += this.beforeScan.get(id) ?? character(chars[id]);
      this.foodChanged(id, chars[id]);
      if (i % 512 === 511 && performance.now() - start >= 5) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!current()) return;
        start = performance.now();
      }
    }
    this.beforeScan = null;
  }
  beforePatch(tables) {
    const changed = (id, cell) => {
      const previous = this.world.data.chars[id];
      const was = character(previous), difference = character(cell) - was;
      if (difference) {
        if (this.beforeScan && !this.beforeScan.has(id)) this.beforeScan.set(id, was);
        this.characters += difference;
      }
      if (previous?.kind === 'food' || cell?.kind === 'food') this.foodChanged(id, cell);
    };
    for (const id of tables.chars?.remove || []) changed(id, undefined);
    for (const [id, cell] of tables.chars?.set || []) changed(id, cell);
  }
  applied(tables) {
    if (tables.fishes) this.fish += tables.fishes.addedCount - tables.fishes.removedCount;
    if (tables.scenes || tables.ops) this.scene = undefined;
    if (tables.participants) this.participants = undefined;
  }
  metadata() {
    if (this.recount) return liveMetadata(this.world);
    const data = this.world.data;
    if (data.tick >= this.nextExpiry) {
      this.nextExpiry = Infinity;
      for (const [id, expiry] of this.food) {
        if (expiry <= data.tick) this.food.delete(id);
        else this.nextExpiry = Math.min(this.nextExpiry, expiry);
      }
    }
    this.scene ??= sceneryCount(data);
    this.participants ??= Object.keys(data.participants).length || 1;
    return { id: this.world.id, roots: this.world.roots, participants: this.participants,
      counts: { fish: this.fish, scene: this.scene, food: this.food.size, characters: this.characters } };
  }
}

function sameMetadata(old, next) {
  return old?.id === next.id && Array.isArray(old.roots) && old.roots.length === next.roots.length && next.roots.every(root => old.roots.includes(root)) &&
    old.participants === next.participants && Object.keys(next.counts).every(key => old.counts?.[key] === next.counts[key]);
}

export class CheckpointPictures {
  constructor(getWorld, render) {
    this.getWorld = getWorld;
    this.render = render;
  }
  reuse(picture) {
    if (typeof picture.image === 'string' && /^data:image\/(webp|png);base64,/.test(picture.image)) this.latest = picture;
  }
  hasRecent(world = this.getWorld()) {
    return Array.isArray(this.latest?.roots) && this.latest.roots.some(root => Object.hasOwn(world.data.roots, root));
  }
  recent() {
    const world = this.getWorld();
    if (this.hasRecent(world)) return { ...this.latest, ...liveMetadata(world) };
  }
  beforePatch(world, patch) {
    if (this.state?.world === world) this.state.beforePatch(patch.tables);
  }
  changed(world, patch, source) {
    if (this.state?.world !== world) return;
    if (!patch) {
      if (source === 'replica') this.state.recount = true;
      else this.state = null;
      return;
    }
    const tables = patch.tables;
    this.state.applied(tables);
    if (source === 'input' && (tables.chars || tables.fishes || tables.scenes || tables.roots)) this.state.edit++;
  }
  current(state) { return state === this.state && state.world === this.getWorld(); }
  async generate(state, force) {
    await state.scan(() => this.current(state));
    if (!this.current(state)) return;
    const edit = state.edit;
    if (!force && sameMetadata(this.latest, state.metadata())) return { state, edit, picture: this.latest };
    const image = await this.render(state.world);
    if (!this.current(state) || state.edit !== edit) return;
    this.latest = { ...state.metadata(), image, at: Date.now() };
    return { state, edit, picture: this.latest };
  }
  async prepare(force = false) {
    for (;;) {
      if (!this.task) {
        const world = this.getWorld();
        if (this.state?.world !== world || this.state.recount) this.state = new PictureState(world);
        const promise = this.generate(this.state, force).finally(() => { this.task = null; });
        this.task = { force, promise };
      }
      const pending = this.task;
      const result = await pending.promise;
      if (result && this.current(result.state) && result.edit === result.state.edit && (!force || pending.force)) return result;
    }
  }
  // Called synchronously when a transaction obtains its world cut. Movement
  // never restarts image encoding. Counts include births, deaths and expiry
  // committed between painting and the start of the storage transaction.
  atCut(prepared) {
    if (!this.current(prepared.state) || prepared.edit !== prepared.state.edit) return;
    const meta = prepared.state.metadata();
    return sameMetadata(prepared.picture, meta) ? prepared.picture : { ...prepared.picture, ...meta };
  }
}
