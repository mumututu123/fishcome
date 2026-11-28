import { renderBase, renderEdits, renderMerge } from './render-view.js';

export class RenderClient {
  constructor(renderer) {
    this.renderer = renderer;
    this.generation = 0;
    this.hitId = 0;
    this.offerId = 0;
    this.hits = new Map();
  }

  get visible() { return this.worker && this.ready === this.generation && !this.renderer.scene3d; }

  settings(follow) {
    const { width, height, dpr, camera, scale, cell, preview, selected, selectedCell, observedFish } = this.renderer;
    return { dimensions: { width, height, dpr }, camera, scale, cell, preview, selected, selectedCell, observedFish, follow };
  }

  open(view) {
    const input = this.renderer.canvas;
    if (typeof Worker === 'undefined' || !input.transferControlToOffscreen) return;
    const surface = this.surface = document.createElement('canvas');
    Object.assign(surface.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    surface.setAttribute('aria-hidden', 'true');
    surface.hidden = true;
    input.before(surface);
    const canvas = surface.transferControlToOffscreen();
    const worker = this.worker = new Worker(new URL('./render-owner.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.ready === this.generation) { this.ready = data.ready; this.display(); }
      if (data.request) {
        this.hits.get(data.request)?.(data.hit);
        this.hits.delete(data.request);
      }
    };
    worker.onerror = () => this.close();
    worker.postMessage({ canvas, view, active: true }, [canvas]);
  }

  close() {
    this.worker?.terminate();
    this.worker = undefined;
    this.surface?.remove();
    this.renderer.canvas.style.opacity = '';
    for (const done of this.hits.values()) done(null);
    this.hits.clear();
    this.unavailable = true;
  }

  display() {
    this.surface.hidden = !this.visible;
    this.renderer.canvas.style.opacity = this.visible ? '0' : '';
  }

  reset(world, swims, startedAt) {
    this.world = world;
    this.data = world.data;
    this.roster = undefined;
    this.pending = undefined;
    ++this.generation;
    this.worker.postMessage({ generation: this.generation, base: renderBase(world.data), swims, startedAt });
  }

  publishView(view, active) {
    const signature = JSON.stringify(view);
    if (this.active === active && this.signature === signature) return;
    this.signature = signature;
    this.active = active;
    this.worker.postMessage({ view, active });
    this.display();
  }

  cameraChanged(tracked) {
    if (this.worker && this.active) this.publishView(this.settings(tracked ? this.follow : undefined), true);
  }

  frame(world, follow) {
    if (this.unavailable) return false;
    const active = !this.renderer.scene3d;
    const view = this.settings(follow);
    this.follow = follow;
    if (active && !this.worker) {
      try { this.open(view); }
      catch { this.close(); }
      if (!this.worker) { this.unavailable = true; return false; }
    }
    if (!this.worker) return false;
    if (this.active && !active) this.needsReset = true;
    this.publishView(view, active);
    if (active && (this.needsReset || this.world !== world || this.data !== world.data || this.pending && !this.pending.merge)) {
      this.needsReset = false;
      this.reset(world);
      this.display();
    }
    return Boolean(this.visible);
  }

  offer(world, roster) {
    if (!this.visible || !this.active || this.pending || this.world !== world || this.data !== world.data) return;
    const { port1, port2 } = new MessageChannel();
    const worker = this.worker, id = ++this.offerId, generation = this.generation;
    const offer = {
      id, generation, worker, port: port2,
      done() { if (!this.permitted) worker.postMessage({ cancel: id }); },
    };
    worker.postMessage({ offer: { id, generation, port: port1, stableRoster: roster === this.roster } }, [port1]);
    return offer;
  }

  changed(world, patch, origin, merge, startedAt) {
    if (!this.worker || !this.active || world !== this.world || this.data !== world.data || origin === 'archive') return;
    if (!patch) { this.pending = { merge }; return; }
    if (this.pending) this.reset(world, patch.swims, startedAt);
    else {
      const roster = patch.tables.fishes?.frame?.knownFish;
      const offer = patch.display;
      const message = { generation: this.generation, startedAt };
      if (offer?.worker === this.worker && offer.generation === this.generation) message.permit = offer.id;
      else message.changes = renderEdits(patch);
      if (roster && roster !== this.roster) message.roster = this.roster = roster;
      this.worker.postMessage(message);
      if (message.permit !== undefined) offer.permitted = true;
    }
  }

  merged(world, movement) {
    if (!this.worker || !this.active || this.world !== world) return;
    const merge = this.pending?.merge;
    const startedAt = performance.timeOrigin + (movement?.startedAt ?? performance.now());
    if (merge) {
      this.pending = undefined;
      this.worker.postMessage({ generation: this.generation, changes: renderMerge(world.data, merge),
        swims: movement?.directions, startedAt });
    } else if (this.pending) this.reset(world, movement?.directions, startedAt);
    else if (movement) this.worker.postMessage({ generation: this.generation, swims: movement.directions, startedAt });
  }

  hit(x, y) {
    if (!this.visible) return this.renderer.hit(x, y);
    const request = ++this.hitId;
    return new Promise(resolve => {
      this.hits.set(request, resolve);
      this.worker.postMessage({ generation: this.generation, hit: [request, x, y, performance.timeOrigin + performance.now()] });
    });
  }
}
