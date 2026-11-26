import { CONFIG, cellPosition, EYES, MONUMENT } from './engine.js';
import { wrapX, deltaX, nearX, worldKey } from './geography.js';
import { bubbleState, bubbleGlyph, BUBBLE_COLOR } from './bubbles.js';
import { weatherAt, lightDepth } from './life.js';
import { weedAlpha } from './ecology.js';
import { echoCells, friendSignals } from './easter-eggs.js';
import { activeEvent, eventPosition } from './random-events.js';
import { eventGlyphs } from './random-event-visuals.js';
import { activeLegend, legendGeometry } from './legends.js';
import { predatorCells, illnessOf, POPULATION } from './population.js';
import { ViewportCells } from './viewport.js';
const FONT = "'Microsoft YaHei',Consolas,monospace";
export { MONUMENT } from './engine.js';
export class Renderer {
  scene3d = null;
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.camera = { x: 380, y: 23 }; this.scale = 1; this.cell = 18; this.pointer = { x: 0, y: 0 }; this.preview = null; this.selected = null; this.world = null; this.resize(); window.addEventListener('resize', () => this.resize()); }
  resize() { this.width = innerWidth; this.height = innerHeight; this.dpr = Math.min(2, devicePixelRatio || 1); this.canvas.width = this.width * this.dpr; this.canvas.height = this.height * this.dpr; this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  point(x, y) { const s = this.cell * this.scale; return { x: wrapX(Math.floor(this.camera.x + (x - this.width / 2) / s)), y: Math.floor(this.camera.y + (y - this.height / 2) / s) }; }
  screen(x, y) { const s = this.cell * this.scale; return { x: (nearX(x, this.camera.x) - this.camera.x) * s + this.width / 2, y: (y - this.camera.y) * s + this.height / 2 }; }
  seaweedScreen(cell) { const progress = Math.max(0, Math.min(1, (Date.now() - (cell.swayAt || 0)) / CONFIG.step)), x = Number.isFinite(cell.swayFromX) ? cell.swayFromX + deltaX(cell.x, cell.swayFromX) * progress : cell.x; return this.screen(x, cell.y); }
  zoom(value) { this.scale = Math.min(2, Math.max(.4, value)); }
  glyph(ctx, ch, color, x, y, size, alpha = 1, glow = false) { this.glyphs ||= new Map(); const id = `${ch}:${color}:${size.toFixed(2)}:${glow}`; let sprite = this.glyphs.get(id); const pad = glow ? 6 : 1; if (!sprite) { sprite = document.createElement('canvas'); sprite.width = sprite.height = Math.ceil(size + pad * 2); const g = sprite.getContext('2d'); g.fillStyle = color; g.font = `${Math.max(3, size * .85)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; if (glow) { g.shadowBlur = 4; g.shadowColor = color; } g.fillText(ch, pad + size / 2, pad + size / 2, size); this.glyphs.set(id, sprite); if (this.glyphs.size > 4096) this.glyphs.delete(this.glyphs.keys().next().value); } ctx.globalAlpha = alpha; ctx.drawImage(sprite, x - pad, y - pad); ctx.globalAlpha = 1; }
  background(ctx, w, h, cam, size, world = this.world) {
    ctx.fillStyle = '#04121f'; ctx.fillRect(0, 0, w, h);
    const top = -cam.y * size + h / 2;
    for (let row = 0; row < CONFIG.depth; row += 3) { const d = row / CONFIG.depth, r = Math.round(26 - d * 23), g = Math.round(79 - d * 61), b = Math.round(108 - d * 74); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(0, top + row * size, w, 3 * size + 1); }
    ctx.fillStyle = '#6dbfc54d'; ctx.fillRect(0, top, w, Math.max(1, size / 7));
    ctx.fillStyle = '#6dbfc510'; ctx.fillRect(0, top, w, size);
    ctx.strokeStyle = '#b8eeee05'; ctx.lineWidth = 1; for (let y = Math.max(0, Math.floor(top)); y < h; y += size) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    if (world) for (let x = Math.floor(cam.x - w / (2 * size)) - 1; x <= Math.ceil(cam.x + w / (2 * size)); x += Math.max(1, Math.floor(1 / size))) {
      const depth = world.floorAt(x), px = (x - cam.x) * size + w / 2, py = (depth - cam.y) * size + h / 2;
      ctx.fillStyle = '#102d36'; ctx.fillRect(px, py, size + 1, Math.max(0, h - py));
      if (py > -size && py < h) this.glyph(ctx, '底', '#527d72', px, py, size, .8);
    }
  }
  worldChanged(world, patch) {
    if (!patch || patch.tables?.rocks) this.rockCells = null;
    if (this.cachedWorld !== world) return;
    if (!patch) { this.viewport = null; return; }
    if (this.viewport) {
      this.viewport.update(patch.tables || {});
      this.indexedTick = world.data.tick;
      world.dirty = false;
    }
  }
  cellIndex(world) {
    if (this.cachedWorld !== world) {
      if (this.cachedWorld) delete this.cachedWorld.surfaceCandidates;
      world.surfaceCandidates = x => {
        const index = this.viewport;
        if (this.cachedWorld === world && index && !index.remaining && !world.dirty && this.indexedTick === world.data.tick) {
          return index.query(x, x, 0, 0);
        }
      };
    }
    if (!this.viewport || this.cachedWorld !== world || world.dirty || this.indexedTick !== world.data.tick) {
      this.viewport = new ViewportCells(world.data, true);
      this.cachedWorld = world;
      this.indexedTick = world.data.tick;
      world.dirty = false;
    }
    return this.viewport;
  }
  draw(world, now = performance.now()) {
    this.world = world;
    const ctx = this.ctx, size = this.cell * this.scale, paint = this.scene3d || this;
    if (this.scene3d) this.scene3d.background(this, world, size, now);
    else this.background(ctx, this.width, this.height, this.camera, size);
    const left = this.camera.x - this.width / 2 / size - 2, right = this.camera.x + this.width / 2 / size + 2, top = this.camera.y - this.height / 2 / size - 2, bottom = this.camera.y + this.height / 2 / size + 2;
    this.weather(world, size);
    const visible = p => Math.abs(deltaX(p.x, this.camera.x)) <= (right - left) / 2 && p.y >= top && p.y <= bottom;
    this.drawPopulation(world, size, visible);
    const index = this.cellIndex(world);
    index.advance();
    this.paintedCells ||= new Map();
    this.paintedCells.clear();
    this.paintedLeft = this.camera.x - this.width / (2 * size);
    this.paintedTop = this.camera.y - this.height / (2 * size);
    this.paintedSize = size;
    const characters = index.query(left - 2, right + 2, top - 2, bottom + 2);
    if (this.characters !== characters) { this.characters = characters; this.echoes = echoCells(world.data, characters); }
    const legend = activeLegend(world.data, Date.now());
    if (legend) this.drawLegend(world, legend, Date.now(), size, visible, false);
    const occasion = activeEvent(world.data, Date.now());
    if (occasion?.kind === 'whale') this.drawEvent(world, occasion, Date.now(), size, visible);
    for (const c of characters) if (c.kind === 'scene') { const s = world.data.scenes[c.entity]; if (!s) continue; const p = { x: s.x + c.x, y: s.y + c.y }; if (!visible(p)) continue; this.paintedCells.set(worldKey(p.x, p.y), c); const pixel = this.screen(p.x, p.y), selected = this.selected === c.entity && (!c.chat || this.selectedCell === c.id), echo = this.echoes.has(c.id); paint.glyph(ctx, c.ch, echo ? '#d7efe1' : c.color, pixel.x, pixel.y, size, selected ? 1 : echo ? .8 + .2 * Math.sin(Date.now() / 450) : .85, echo, c.kind); if (selected) { ctx.strokeStyle = '#b7f7de55'; ctx.strokeRect(pixel.x, pixel.y, size, size); } }
    this.scene3d?.drawFishLinks?.(this, world, characters, size, visible);
    for (const c of characters) if (c.kind === 'fish' && c.entity !== this.observedFish) { const f = world.data.fishes[c.entity]; if (!f) continue; const p = cellPosition(f, c); if (!visible(p)) continue; this.paintedCells.set(worldKey(p.x, p.y), c); const pixel = this.screen(p.x, p.y); paint.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size, 1, EYES.has(c.ch), c.kind, c, f.facing); }
    if (this.observedFish) for (const c of characters) if (c.kind === 'fish' && c.entity === this.observedFish) { const f = world.data.fishes[c.entity]; if (!f) continue; const p = cellPosition(f, c); if (!visible(p)) continue; this.paintedCells.set(worldKey(p.x, p.y), c); const pixel = this.screen(p.x, p.y); ctx.fillStyle = '#9aeee015'; ctx.fillRect(pixel.x, pixel.y, size, size); paint.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size, 1, EYES.has(c.ch), c.kind, c, f.facing); ctx.strokeStyle = '#9aeee077'; ctx.lineWidth = 1; ctx.strokeRect(pixel.x, pixel.y, size, size); }
    for (const c of characters) if ((c.kind === 'food' || c.kind === 'seaweed') && visible(c)) { const pixel = c.kind === 'seaweed' ? this.seaweedScreen(c) : this.screen(c.x, c.y); paint.glyph(ctx, c.ch, c.color, pixel.x, pixel.y, size, c.kind === 'seaweed' ? weedAlpha(c, world.data.ecology, Date.now()) : 1, false, c.kind); if (c.kind === 'food' && world.data.tick - c.born >= CONFIG.foodLife) { ctx.strokeStyle = '#84a2b355'; ctx.strokeRect(pixel.x + size * .2, pixel.y + size * .2, size * .6, size * .6); } }
    const bubbleNow = Date.now();
    const sick = new Set();
    for (const c of characters) if (c.kind === 'fish' && !sick.has(c.entity) && illnessOf(world.data, c.entity)) {
      sick.add(c.entity); const f = world.data.fishes[c.entity]; if (!f) continue;
      const p = cellPosition(f, c), pixel = this.screen(p.x, p.y - 1.2);
      if (visible(p)) this.glyph(ctx, '郁', '#c1a0d8', pixel.x, pixel.y, size, .9);
    }
    if (legend) this.drawLegend(world, legend, bubbleNow, size, visible, true);
    for (const bubble of Object.values(world.data.bubbles || {})) { const state = bubbleState(bubble, bubbleNow); if (!state || state.y > bottom || state.y + state.size < top || Math.abs(deltaX(state.x + state.size / 2, this.camera.x)) > (right - left) / 2 + state.size) continue; for (let y = 0; y < state.size; y++) for (let x = 0; x < state.size; x++) { const p = { x: state.x + x, y: state.y + y }; if (visible(p)) { const pixel = this.screen(p.x, p.y); paint.glyph(ctx, bubbleGlyph(bubble), BUBBLE_COLOR, pixel.x, pixel.y, size, 1, false, 'bubble'); } } }
    for (const signal of friendSignals(world.data, bubbleNow)) {
      const fish = world.data.fishes[signal.fish], cells = index.fishCells(signal.fish); if (!cells.length) continue;
      const xs = cells.map(c => fish.facing * c.x), p = { x: fish.x + (Math.min(...xs) + Math.max(...xs)) / 2, y: fish.y + Math.min(...cells.map(c => c.y)) - 1.4 }; if (!visible(p)) continue;
      const pixel = this.screen(p.x, p.y); this.glyph(ctx, signal.ch, '#d5eee0', pixel.x, pixel.y, size, signal.alpha, true);
    }
    if (occasion && occasion.kind !== 'whale') this.drawEvent(world, occasion, bubbleNow, size, visible);
    const monument = world.monument; monument.rows.forEach((row, dy) => Array.from(row).forEach((ch, dx) => { if (ch === ' ') return; const p = { x: monument.x + dx, y: monument.y + dy }; if (visible(p)) { const pixel = this.screen(p.x, p.y); paint.glyph(ctx, ch, '#b8b797', pixel.x, pixel.y, size, 1, false, 'monument'); } }));
    if (this.preview) { const p = this.preview; for (const c of p.cells || [{ x: 0, y: 0, ch: p.ch, color: p.color }]) { const pixel = this.screen(p.x + c.x, p.y + c.y); ctx.fillStyle = '#9fecd918'; ctx.fillRect(pixel.x, pixel.y, size, size); paint.glyph(ctx, c.ch, p.valid === false ? '#efaa99' : c.color, pixel.x, pixel.y, size, .65, false, p.kind === 'fish' ? 'fishPreview' : p.kind === 'scene' ? 'beadPreview' : 'preview'); } }
  }
  drawPopulation(world, size, visible) {
    if (this.rockWorld !== world || !this.rockCells) { this.rockCells = Object.values(world.data.rocks || {}); this.rockWorld = world; }
    const paint = this.scene3d || this;
    for (const c of this.rockCells) if (visible(c)) { const p = this.screen(c.x, c.y); paint.glyph(this.ctx, '岩', '#7c838b', p.x, p.y, size, .95, false, 'scene'); }
    for (const npc of Object.values(world.data.population?.predators || {})) for (const c of predatorCells(npc)) if (visible(c)) { const p = this.screen(c.x, c.y); paint.glyph(this.ctx, c.ch, c.color, p.x, p.y, size, 1, c.ch === '鲨', 'legend'); }
    const e = world.data.population?.eruption;
    if (!e) return;
    if (Date.now() < e.at + POPULATION.warning) { const p = { x: e.x, y: world.floorAt(e.x) - 2 }; if (visible(p)) { const pixel = this.screen(p.x, p.y); this.glyph(this.ctx, '震', '#eeb07a', pixel.x, pixel.y, size, .9, true); } }
    for (const c of Object.values(e.particles)) if (visible(c)) { const p = this.screen(c.x, c.y), hot = Date.now() < c.born + POPULATION.cooling; paint.glyph(this.ctx, hot ? '浆' : '岩', hot ? '#ff493b' : '#7c838b', p.x, p.y, size, 1, hot, hot ? 'breath' : 'scene'); }
  }
  drawLegend(world, legend, now, size, visible, beam) {
    const paint = this.scene3d || this;
    const colors = { cthulhu: { 克: '#a1b998', 苏: '#8db2a0', 鲁: '#6e988e' }, godzilla: { 哥: '#a3bb9d', 斯: '#719d92', 拉: '#a5c8bc' }, ship: { 幽: '#899f9c', 灵: '#c2d3ce', 船: '#a6bcb1' } };
    const scenery = this.legendSceneryTick === world.data.tick && this.legendSceneryWorld === world ? this.legendScenery : world.sceneryMap(); this.legendScenery = scenery; this.legendSceneryTick = world.data.tick; this.legendSceneryWorld = world;
    const age = now - legend.started, fade = Math.max(0, Math.min(1, (legend.ends - now) / (legend.kind === 'ship' ? 8000 : 30000)));
    if (!beam && legend.kind !== 'ship' && age < 10000) for (let dx = -1; dx <= 1; dx++) { const p = { x: legend.x + dx, y: legend.floor - 1 }; if (visible(p)) { const pixel = this.screen(p.x, p.y); this.glyph(this.ctx, Array.from(legend.kind === 'cthulhu' ? '克苏鲁' : '哥斯拉')[dx + 1], '#a2beb4', pixel.x, pixel.y, size, .35 + .25 * Math.sin(age / 500), true); } }
    for (const cell of legendGeometry(world.data, legend, now, scenery)) {
      if ((cell.role === 'beam') !== beam || !visible(cell) || legend.kind !== 'ship' && !world.waterAt(cell.x, cell.y)) continue;
      const pixel = this.screen(cell.x, cell.y), glow = cell.role === 'beam' || cell.role === 'charge';
      paint.glyph(this.ctx, cell.ch, cell.role === 'beam' ? '#a8e5ff' : cell.role === 'charge' ? '#d0f0ff' : colors[legend.kind][cell.ch], pixel.x, pixel.y, size, fade * (legend.kind === 'ship' ? .82 : 1), glow, cell.role === 'beam' ? 'breath' : 'legend');
    }
  }
  drawEvent(world, event, now, size, visible) {
    const bodies = (event.fishes || []).flatMap(id => this.viewport.fishCells(id));
    for (const glyph of eventGlyphs(world.data, event, now, bodies)) {
      if (!visible(glyph) || !world.waterAt(Math.round(glyph.x), Math.round(glyph.y))) continue;
      const pixel = this.screen(glyph.x, glyph.y); this.glyph(this.ctx, glyph.ch, glyph.color, pixel.x, pixel.y, size, glyph.alpha, glyph.glow);
    }
  }
  eventHit(x, y) {
    const point = this.point(x, y), state = this.world.data.population, eruption = state?.eruption;
    if (Object.values(state?.predators || {}).some(p => predatorCells(p).some(c => c.x === point.x && c.y === point.y))) return { kind: 'ecosystem', id: 'predator' };
    if (eruption && (Object.values(eruption.particles).some(c => c.x === point.x && c.y === point.y) || Date.now() < eruption.at + POPULATION.warning && Math.abs(deltaX(point.x, eruption.x)) <= 2 && point.y >= this.world.floorAt(eruption.x) - 3)) return { kind: 'ecosystem', id: 'volcano' };
    if ((this.rockCells || []).some(c => c.x === point.x && c.y === point.y)) return { kind: 'ecosystem', id: 'rock' };
    const legend = activeLegend(this.world.data, Date.now());
    if (legend) for (const c of legendGeometry(this.world.data, legend, Date.now(), this.world.sceneryMap())) { const p = this.screen(c.x, c.y), size = this.cell * this.scale; if (x >= p.x && x <= p.x + size && y >= p.y && y <= p.y + size) return { kind: 'legend', id: legend.id }; }
    const event = activeEvent(this.world.data, Date.now()); if (event?.kind !== 'bottle') return null;
    const p = this.screen(eventPosition(event, Date.now()).x, eventPosition(event, Date.now()).y), size = this.cell * this.scale;
    return x >= p.x - size && x <= p.x + 2 * size && y >= p.y - size && y <= p.y + 1.5 * size ? { kind: 'event', id: event.id } : null;
  }
  weather(world, size) {
    const weather = weatherAt(world.data, Date.now()); if (!weather.active) return;
    const ctx = this.ctx, progress = (Date.now() - weather.started) / 1000;
    ctx.save();
    // A faint backdrop leaves characters legible, including on small screens.
    if (weather.type === 'light') {
      const y = this.screen(0, lightDepth(weather)).y, reach = 6 * size, gradient = ctx.createLinearGradient(0, y - reach, 0, y + reach);
      gradient.addColorStop(0, '#dbecbd00'); gradient.addColorStop(.5, '#dbecbd24'); gradient.addColorStop(1, '#dbecbd00'); ctx.fillStyle = gradient; ctx.fillRect(0, y - reach, this.width, reach * 2);
      const x = this.width * (.25 + .5 * progress / 55), surface = this.screen(0, 0).y; ctx.fillStyle = '#dbecbd0c'; ctx.beginPath(); ctx.moveTo(x, surface); ctx.lineTo(x + 34, surface); ctx.lineTo(x + 200, y + reach); ctx.lineTo(x + 100, y + reach); ctx.closePath(); ctx.fill();
    }
    if (weather.type === 'current') {
      ctx.strokeStyle = '#a5d8e32b'; ctx.lineWidth = 1;
      for (let row = 0; row < 8; row++) { const y = this.screen(0, 8 + row * 9).y; if (y < 0 || y > this.height) continue; for (let column = 0; column < 5; column++) { const x = ((column * this.width / 4 + progress * size * weather.direction) % (this.width + 80) + this.width + 80) % (this.width + 80) - 40; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 14, y - 4, x + 30, y); ctx.stroke(); } }
    }
    ctx.restore();
  }
  hit(x, y) {
    if (!this.world) return null;
    const p = { x: wrapX(Math.floor(this.paintedLeft + x / this.paintedSize)), y: Math.floor(this.paintedTop + y / this.paintedSize) };
    const monument = this.world.monument;
    if (p.x >= monument.x && p.x < monument.x + 8 && p.y >= monument.y && p.y < monument.y + 5) return { kind: 'monument' };
    // Select the last painted frame, including while the next index is building.
    const painted = this.paintedCells?.get(worldKey(p.x, p.y));
    const live = painted && this.world.data.chars[painted.id];
    if (live && live.kind === painted.kind && live.entity === painted.entity) {
      if (live.kind === 'fish' && this.world.data.fishes[live.entity]) return { kind: 'fish', id: live.entity };
      if (live.kind === 'scene' && this.world.data.scenes[live.entity]) return { kind: 'scene', id: live.entity, cell: live.id };
    }
    return this.eventHit(x, y);
  }
  *paintSnapshot(world, canvas) {
    const size = Math.min(6, 6000 / CONFIG.width);
    canvas.width = Math.ceil(CONFIG.width * size); canvas.height = Math.ceil(CONFIG.depth * size); const ctx = canvas.getContext('2d'); this.background(ctx, canvas.width, canvas.height, { x: CONFIG.width / 2, y: CONFIG.depth / 2 }, size, world);
    const legend = activeLegend(world.data, world.data.tick); if (legend) for (const c of legendGeometry(world.data, legend, world.data.tick, world.sceneryMap())) if (legend.kind === 'ship' || world.waterAt(c.x, c.y)) this.glyph(ctx, c.ch, c.role === 'beam' ? '#a8e5ff' : '#91b3a4', c.x * size, c.y * size, size);
    let visited = 0;
    for (const c of Object.values(world.data.rocks || {})) { if (++visited % 256 === 0) yield; this.glyph(ctx, '岩', '#7c838b', c.x * size, c.y * size, size); }
    for (const p of Object.values(world.data.population?.predators || {})) for (const c of predatorCells(p)) this.glyph(ctx, c.ch, c.color, c.x * size, c.y * size, size);
    for (const c of Object.values(world.data.population?.eruption?.particles || {})) { const hot = world.data.tick < c.born + POPULATION.cooling; this.glyph(ctx, hot ? '浆' : '岩', hot ? '#ff493b' : '#7c838b', c.x * size, c.y * size, size); }
    for (const id in world.data.chars) {
      if (++visited % 256 === 0) yield;
      const c = world.data.chars[id]; if (!c) continue;
      let p; if (c.kind === 'scene') { const s = world.data.scenes[c.entity]; if (s) p = { x: s.x + c.x, y: s.y + c.y }; } else if (c.kind === 'fish') { const f = world.data.fishes[c.entity]; if (f) p = cellPosition(f, c); } else if (c.kind === 'food' || c.kind === 'seaweed') p = c; if (p) this.glyph(ctx, c.ch, c.color, wrapX(p.x) * size, p.y * size, size); }
    for (const bubble of Object.values(world.data.bubbles || {})) { const state = bubbleState(bubble, world.data.tick); if (!state) continue; for (let y = 0; y < state.size; y++) for (let x = 0; x < state.size; x++) this.glyph(ctx, bubbleGlyph(bubble), BUBBLE_COLOR, wrapX(state.x + x) * size, (state.y + y) * size, size); }
  }
  snapshot(world) {
    const canvas = document.createElement('canvas');
    const painting = this.paintSnapshot(world, canvas);
    while (!painting.next().done) { /* synchronous backup/export reader */ }
    return canvas.toDataURL('image/webp', .82);
  }
  async snapshotAsync(world) {
    const canvas = document.createElement('canvas');
    let start = performance.now();
    for (const _ of this.paintSnapshot(world, canvas)) {
      if (performance.now() - start < 5) continue;
      await new Promise(resolve => setTimeout(resolve, 0));
      start = performance.now();
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
    if (!blob) throw new Error('无法生成世界合影');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
}
