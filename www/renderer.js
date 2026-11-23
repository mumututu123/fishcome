import { CONFIG, cellPosition, EYES, MONUMENT } from './engine.js';
const FONT = "'Microsoft YaHei',Consolas,monospace";
export { MONUMENT } from './engine.js';
export class Renderer {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.camera = { x: 380, y: 23 }; this.scale = 1; this.cell = 18; this.pointer = { x: 0, y: 0 }; this.preview = null; this.selected = null; this.world = null; this.resize(); window.addEventListener('resize', () => this.resize()); }
  resize() { this.width = innerWidth; this.height = innerHeight; this.dpr = Math.min(2, devicePixelRatio || 1); this.canvas.width = this.width * this.dpr; this.canvas.height = this.height * this.dpr; this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  point(x, y) { const s = this.cell * this.scale; return { x: Math.floor(this.camera.x + (x - this.width / 2) / s), y: Math.floor(this.camera.y + (y - this.height / 2) / s) }; }
  screen(x, y) { const s = this.cell * this.scale; return { x: (x - this.camera.x) * s + this.width / 2, y: (y - this.camera.y) * s + this.height / 2 }; }
  zoom(value) { this.scale = Math.min(2, Math.max(.4, value)); }
  glyph(ctx, ch, color, x, y, size, alpha = 1, glow = false) { this.glyphs ||= new Map(); const id = `${ch}:${color}:${size.toFixed(2)}:${glow}`; let sprite = this.glyphs.get(id); const pad = glow ? 6 : 1; if (!sprite) { sprite = document.createElement('canvas'); sprite.width = sprite.height = Math.ceil(size + pad * 2); const g = sprite.getContext('2d'); g.fillStyle = color; g.font = `${Math.max(3, size * .85)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; if (glow) { g.shadowBlur = 4; g.shadowColor = color; } g.fillText(ch, pad + size / 2, pad + size / 2, size); this.glyphs.set(id, sprite); if (this.glyphs.size > 4096) this.glyphs.delete(this.glyphs.keys().next().value); } ctx.globalAlpha = alpha; ctx.drawImage(sprite, x - pad, y - pad); ctx.globalAlpha = 1; }
  background(ctx, w, h, cam, size) {
    ctx.fillStyle = '#04121f'; ctx.fillRect(0, 0, w, h);
    const top = -cam.y * size + h / 2;
    for (let row = 0; row < CONFIG.depth; row += 3) { const d = row / CONFIG.depth, r = Math.round(26 - d * 23), g = Math.round(79 - d * 61), b = Math.round(108 - d * 74); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(0, top + row * size, w, 3 * size + 1); }
    ctx.fillStyle = '#6dbfc54d'; ctx.fillRect(0, top, w, Math.max(1, size / 7));
    ctx.fillStyle = '#6dbfc510'; ctx.fillRect(0, top, w, size);
    ctx.strokeStyle = '#b8eeee05'; ctx.lineWidth = 1; for (let y = Math.max(0, Math.floor(top)); y < h; y += size) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }
  draw(world) {
    this.world = world; const ctx = this.ctx, size = this.cell * this.scale; this.background(ctx, this.width, this.height, this.camera, size);
    const left = this.camera.x - this.width / 2 / size - 2, right = this.camera.x + this.width / 2 / size + 2, top = this.camera.y - this.height / 2 / size - 2, bottom = this.camera.y + this.height / 2 / size + 2;
    const visible = p => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
    if (this.cachedWorld !== world || world.dirty || !this.characters) { this.characters = Object.values(world.data.chars); this.cachedWorld = world; world.dirty = false; }
    const characters = this.characters;
    for (const c of characters) if (c.kind === 'scene') { const s = world.data.scenes[c.entity]; if (!s) continue; const p = { x: s.x + c.x, y: s.y + c.y }; if (!visible(p)) continue; const pixel = this.screen(p.x, p.y); this.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size, this.selected === c.entity ? 1 : .85); if (this.selected === c.entity) { ctx.strokeStyle = '#b7f7de55'; ctx.strokeRect(pixel.x, pixel.y, size, size); } }
    for (const c of characters) if (c.kind === 'fish' && c.entity !== this.observedFish) { const f = world.data.fishes[c.entity]; if (!f) continue; const p = cellPosition(f, c); if (!visible(p)) continue; const pixel = this.screen(p.x, p.y); this.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size, 1, EYES.has(c.ch)); }
    if (this.observedFish) for (const c of characters) if (c.kind === 'fish' && c.entity === this.observedFish) { const f = world.data.fishes[c.entity]; if (!f) continue; const p = cellPosition(f, c); if (!visible(p)) continue; const pixel = this.screen(p.x, p.y); ctx.fillStyle = '#9aeee015'; ctx.fillRect(pixel.x, pixel.y, size, size); this.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size, 1, EYES.has(c.ch)); ctx.strokeStyle = '#9aeee077'; ctx.lineWidth = 1; ctx.strokeRect(pixel.x, pixel.y, size, size); }
    for (const c of characters) if (c.kind === 'food' && visible(c)) { const pixel = this.screen(c.x, c.y); this.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size); if (world.data.tick - c.born >= CONFIG.foodLife) { ctx.strokeStyle = '#84a2b355'; ctx.strokeRect(pixel.x + size * .2, pixel.y + size * .2, size * .6, size * .6); } }
    MONUMENT.rows.forEach((row, dy) => Array.from(row).forEach((ch, dx) => { if (ch === ' ') return; const p = { x: MONUMENT.x + dx, y: MONUMENT.y + dy }; if (visible(p)) { const pixel = this.screen(p.x, p.y); this.glyph(ctx, ch, '#b8b797', pixel.x, pixel.y, size); } }));
    if (this.preview) { const p = this.preview; for (const c of p.cells || [{ x: 0, y: 0, ch: p.ch, color: p.color }]) { const pixel = this.screen(p.x + c.x, p.y + c.y); ctx.fillStyle = '#9fecd918'; ctx.fillRect(pixel.x, pixel.y, size, size); this.glyph(ctx, c.ch, p.valid === false ? '#efaa99' : c.color, pixel.x, pixel.y, size, .65); } }
  }
  hit(x, y) { if (!this.world) return null; const p = this.point(x, y); if (p.x >= MONUMENT.x && p.x < MONUMENT.x + 8 && p.y >= MONUMENT.y && p.y < MONUMENT.y + 5) return { kind: 'monument' }; for (const c of Object.values(this.world.data.chars).reverse()) { if (c.kind === 'fish') { const f = this.world.data.fishes[c.entity]; if (!f) continue; const at = cellPosition(f, c); if (at.x === p.x && at.y === p.y) return { kind: 'fish', id: f.id }; } else if (c.kind === 'scene') { const s = this.world.data.scenes[c.entity]; if (s && s.x + c.x === p.x && s.y + c.y === p.y) return { kind: 'scene', id: s.id, cell: c.id }; } } return null; }
  snapshot(world) {
    const canvas = document.createElement('canvas'); const size = 6; canvas.width = CONFIG.width * size; canvas.height = CONFIG.depth * size; const ctx = canvas.getContext('2d'); this.background(ctx, canvas.width, canvas.height, { x: CONFIG.width / 2, y: CONFIG.depth / 2 }, size);
    for (const c of Object.values(world.data.chars)) { let p; if (c.kind === 'scene') { const s = world.data.scenes[c.entity]; if (s) p = { x: s.x + c.x, y: s.y + c.y }; } else if (c.kind === 'fish') { const f = world.data.fishes[c.entity]; if (f) p = cellPosition(f, c); } else if (c.kind === 'food') p = c; if (p) this.glyph(ctx, c.ch, c.color, p.x * size, p.y * size, size); }
    return canvas.toDataURL('image/webp', .82);
  }
}
