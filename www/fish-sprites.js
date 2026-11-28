import { EYES } from './engine.js';

export function fishRuns(characters) {
  const runs = [];
  let run;
  for (const cell of characters) {
    if (cell.kind !== 'fish') continue;
    if (run?.id !== cell.entity) runs.push(run = { id: cell.entity, cells: [] });
    run.cells.push(cell);
  }
  return runs;
}

export class FishSprites {
  images = new Map();
  pixels = 0;

  get(renderer, run, size, facing) {
    const parts = run.cells, first = parts[0];
    const shape = run.shape ??= JSON.stringify(parts.map(c => [c.x - first.x, c.y - first.y, c.ch, c.color]));
    const key = size + '/' + facing + '/' + shape;
    let stamp = this.images.get(key);
    if (stamp) {
      stamp.usedAt = renderer.frameTime;
      this.images.delete(key);
      this.images.set(key, stamp);
      return stamp;
    }
    let left = 0, right = 0, top = 0, bottom = 0;
    for (const cell of parts) {
      const dx = (cell.x - first.x) * facing * size, dy = (cell.y - first.y) * size;
      if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
      left = Math.min(left, dx); right = Math.max(right, dx);
      top = Math.min(top, dy); bottom = Math.max(bottom, dy);
    }
    const pad = 6, width = right - left + size + 2 * pad, height = bottom - top + size + 2 * pad;
    if (width > 512 || height > 512) return;
    // Keep up to eight MiB of RGBA pixels. If this view is already full,
    // draw the other fish directly rather than rebuilding them every frame.
    while (this.pixels + width * height > 2 * 1024 * 1024) {
      const [oldKey, old] = this.images.entries().next().value;
      if (old.usedAt === renderer.frameTime) return;
      this.images.delete(oldKey);
      this.pixels -= old.image.width * old.image.height;
    }
    const image = document.createElement('canvas');
    image.width = width; image.height = height;
    const ctx = image.getContext('2d');
    for (const cell of parts) renderer.glyph(ctx, cell.ch, cell.color,
      (cell.x - first.x) * facing * size - left + pad, (cell.y - first.y) * size - top + pad,
      size, 1, EYES.has(cell.ch));
    stamp = { image, left: left - pad, top: top - pad, usedAt: renderer.frameTime };
    this.images.set(key, stamp);
    this.pixels += width * height;
    return stamp;
  }
}
