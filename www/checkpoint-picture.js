import { CONFIG, sceneryCount } from './engine.js';

const liveMetadata = world => ({ id: world.id, roots: world.roots, participants: Object.keys(world.data.participants).length || 1, counts: world.counts() });

class PictureState {
  constructor(world) {
    this.world = world;
    this.food = new Map();
    this.nextExpiry = Infinity;
    this.edit = 0;
    this.fish = Object.keys(world.data.fishes).length;
    this.characters = new Set();
    this.scanned = false;
  }
  foodChanged(id, cell) {
    const expiry = cell?.kind === 'food' ? cell.born + CONFIG.foodLife : 0;
    if (expiry > this.world.data.tick) {
      this.food.set(id, expiry);
      this.nextExpiry = Math.min(this.nextExpiry, expiry);
    } else this.food.delete(id);
  }
  setCell(id, cell) {
    if (cell && cell.kind !== 'burn') this.characters.add(id);
    else this.characters.delete(id);
    if (cell?.kind === 'food' || this.food.has(id)) this.foodChanged(id, cell);
  }
  async scan(current) {
    if (this.scanned) return;
    // Both the initial scan and subsequent edits read the latest row. A row
    // touched between slices can be visited twice with the same result.
    const chars = this.world.data.chars;
    const ids = Object.keys(chars);
    let start = performance.now();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.setCell(id, chars[id]);
      if (i % 512 === 511 && performance.now() - start >= 5) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!current()) return;
        start = performance.now();
      }
    }
    this.scanned = true;
  }
  applied(tables) {
    for (const id of tables.chars?.remove || []) this.setCell(id, undefined);
    for (const [id, cell] of tables.chars?.set || []) this.setCell(id, cell);
    if (tables.fishes && this.fish !== undefined) this.fish += tables.fishes.addedCount - tables.fishes.removedCount;
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
    this.fish ??= Object.keys(data.fishes).length;
    this.participants ??= Object.keys(data.participants).length || 1;
    return { id: this.world.id, roots: this.world.roots, participants: this.participants,
      counts: { fish: this.fish, scene: this.scene, food: this.food.size, characters: this.characters.size } };
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
    if (this.hasRecent(world)) return { ...this.latest, ...(this.state?.world === world && this.state.scanned ? this.state.metadata() : liveMetadata(world)) };
  }
  changed(world, patch, source, merge) {
    if (this.state?.world !== world) return;
    if (!patch) {
      if (source === 'archive') return;
      if (source === 'replica') {
        this.state.pendingMerge = this.state.recount ? undefined : merge;
        this.state.recount = true;
      }
      else this.state = null;
      return;
    }
    const tables = patch.tables;
    this.state.applied(tables);
    if (source === 'input' && (tables.chars || tables.fishes || tables.scenes || tables.roots)) this.state.edit++;
  }
  merged(world, merge) {
    const state = this.state;
    if (state?.world !== world || !merge?.chars || state.pendingMerge !== merge) return;
    for (const id of merge.chars) state.setCell(id, world.data.chars[id]);
    state.fish = state.scene = state.participants = undefined;
    state.recount = false;
    state.pendingMerge = undefined;
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
