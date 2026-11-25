import { validateDrawing, EYES, validGlyph } from './engine.js';
import { fishNameError } from './fish-profile.js';
const $ = id => document.getElementById(id);
function beadTint(color, target, amount) {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '83aab9';
  const rgb = [0, 2, 4].map((offset, i) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount) + target[i] * amount));
  return `rgb(${rgb.join(',')})`;
}
export class Creator {
  constructor(onPlace, getBalance, getDefaultName) {
    Object.assign(this, { onPlace, getBalance, getDefaultName, autoName: true, cells: new Map(), undo: [], redo: [], kind: 'fish', size: 15, tab: 'grid', tool: 'bead', beads: [], heldBead: null, cellBeads: new Map(), nextBeadId: 1, selection: new Set(), selectedCell: { x: 0, y: 0 }, strokes: [], composing: false });
    this.grid = $('gridCanvas'); this.input = $('gridCellInput'); this.sketch = $('sketchCanvas'); this.sketchCtx = this.sketch.getContext('2d');
    this.grid.addEventListener('focus', () => this.focusCell());
    this.input.addEventListener('keydown', e => this.keydown(e));
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.typeCell(); });
    this.input.addEventListener('input', e => { if (!this.composing && !e.isComposing) this.typeCell(); });
    $('creatorDialog').addEventListener('keydown', e => {
      if (e.defaultPrevented || e.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); this.restoreHistory(e.shiftKey || e.key.toLowerCase() === 'y' ? this.redo : this.undo, e.shiftKey || e.key.toLowerCase() === 'y' ? this.undo : this.redo); }
    });
    let preparing = false;
    $('glyphInput').addEventListener('compositionstart', () => { preparing = true; $('prepareBeads').disabled = true; });
    $('glyphInput').addEventListener('compositionend', () => { preparing = false; this.loadBeads(); });
    $('glyphInput').addEventListener('input', e => { if (!preparing && !e.isComposing) this.loadBeads(); });
    for (const glyph of ['0', 'O', 'o', '口', '.', '。', '<', '>', '=', '#', '|', '/', '木', '石', '水', '鱼']) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = glyph;
      b.onclick = () => this.takeNewBead(glyph); $('glyphPresets').append(b);
    }
    for (const glyph of ['0', 'O', 'o', '。', '.', '口']) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = glyph; b.dataset.eyeGlyph = glyph; b.setAttribute('aria-label', `用 ${glyph} 拼鱼眼`);
      b.onclick = () => this.takeNewBead(glyph); $('eyePresets').append(b);
    }
    for (const color of ['#8be7df', '#79b8ff', '#ff9fc8', '#ffcc66', '#a5dc86', '#e0f4f7', '#a996e8', '#e88372']) {
      const b = document.createElement('button'); b.type = 'button'; b.style.background = color; b.setAttribute('aria-label', `选择颜色 ${color}`);
      b.onclick = () => { $('colorInput').value = color; this.colorBead(); }; $('beadColors').append(b);
    }
    $('colorInput').addEventListener('input', () => this.colorBead());
    for (const [id, tool] of [['beadPen', 'bead'], ['colorPen', 'color'], ['selectBeads', 'select'], ['eraseBrush', 'erase']]) $(id).onclick = () => this.setTool(tool);
    $('prepareBeads').onclick = () => { if (!preparing) this.prepareBeads(); };
    $('glyphInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !preparing && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.prepareBeads(); } });
    $('returnBead').onclick = () => { if (!this.heldBead) return; this.saveUndo(); this.returnHeldBead(); this.render(); };
    $('selectAllBeads').onclick = () => { this.selection = new Set(this.cells.keys()); this.setTool('select'); };
    $('clearBeadSelection').onclick = () => { this.selection.clear(); this.render(); };
    $('recolorBeads').onclick = () => {
      const color = $('colorInput').value, chosen = [...this.selection].map(key => this.cells.get(key)).filter(Boolean);
      if (!chosen.some(cell => cell.color !== color)) return;
      this.saveUndo(); for (const cell of chosen) cell.color = color; this.render();
    };
    $('replaceBead').onclick = () => {
      const key = [...this.selection][0], bead = this.currentBead(); if (this.selection.size !== 1 || !this.cells.has(key) || !bead) return;
      this.saveUndo(); this.returnCellBead(key); this.cells.set(key, { ...this.cells.get(key), ch: bead.ch, color: bead.color }); this.cellBeads.set(key, { ...bead }); this.heldBead = null; this.render();
    };
    $('gridTab').onclick = () => this.setTab('grid'); $('drawTab').onclick = () => this.setTab('draw');
    $('clearDrawing').onclick = () => { if (!this.cells.size && !this.strokes.length) return; this.saveUndo(); for (const key of this.cells.keys()) this.returnCellBead(key); this.cells.clear(); this.selection.clear(); this.strokes = []; this.redrawSketch(); this.render(); };
    $('undoDrawing').onclick = () => this.restoreHistory(this.undo, this.redo);
    $('redoDrawing').onclick = () => this.restoreHistory(this.redo, this.undo);
    $('convertDrawing').onclick = () => this.convert(); $('closeCreator').onclick = () => $('creatorDialog').close();
    $('fishNameInput').oninput = () => { this.autoName = false; this.render(); };
    $('placeDrawing').onclick = () => {
      const cells = [...this.cells.values()], name = this.kind === 'fish' ? this.fishName() : undefined;
      if (validateDrawing(cells, this.kind, this.getBalance()) || (this.kind === 'fish' && fishNameError(name, cells.length))) return;
      const gender = this.kind === 'fish' ? document.querySelector('input[name="fishGender"]:checked').value : undefined;
      $('creatorDialog').close(); this.onPlace(this.kind, cells, gender, name);
    };
    for (const canvas of [this.grid, this.sketch]) {
      canvas.oncontextmenu = e => e.preventDefault(); canvas.addEventListener('pointerdown', e => this.down(e, canvas)); canvas.addEventListener('pointermove', e => this.move(e, canvas));
      const end = e => { if (this.pointerId !== e.pointerId) return; this.dragging = false; this.pointerId = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); };
      canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('lostpointercapture', end);
    }
    this.grid.addEventListener('pointerleave', () => { this.hoverCell = null; this.render(); });
    this.loadBeads();
  }
  preparedLetters() {
    const letters = Array.from($('glyphInput').value).filter(ch => !/\s/u.test(ch)), invalid = letters.filter(ch => !validGlyph(ch));
    const error = invalid.length ? `不支持「${[...new Set(invalid)].join('')}」，请用中文、中文标点或 ASCII 字符。` : letters.length > 128 ? '每次最多准备 128 个字符。' : '';
    return { letters, error };
  }
  loadBeads() { this.render(); }
  makeBead(ch, color = $('colorInput').value) { return { id: this.nextBeadId++, ch, color }; }
  prepareBeads() {
    const { letters, error } = this.preparedLetters(); if (error || !letters.length) return;
    this.saveUndo(); this.beads.push(...letters.map(ch => this.makeBead(ch))); $('glyphInput').value = ''; this.tool = 'bead'; this.eraser = false; this.render();
  }
  returnToTray(bead) {
    if (!bead || this.beads.some(item => item.id === bead.id)) return;
    this.beads.push({ ...bead }); this.beads.sort((a, b) => a.id - b.id);
  }
  returnHeldBead() { this.returnToTray(this.heldBead); this.heldBead = null; }
  returnCellBead(key) {
    const cell = this.cells.get(key), bead = this.cellBeads.get(key);
    if (cell && bead) this.returnToTray({ ...bead, ch: cell.ch, color: cell.color });
    this.cellBeads.delete(key);
  }
  takeBead(id) {
    const index = this.beads.findIndex(bead => bead.id === id); if (index < 0) return;
    this.saveUndo(); const [bead] = this.beads.splice(index, 1); this.returnHeldBead(); this.heldBead = bead;
    $('colorInput').value = bead.color; this.tool = 'bead'; this.eraser = false; this.hoverCell = null; this.render();
  }
  takeNewBead(ch) {
    this.saveUndo(); this.returnHeldBead(); this.heldBead = this.makeBead(ch); this.tool = 'bead'; this.eraser = false; this.hoverCell = null; this.render();
  }
  currentBead() { return this.heldBead; }
  colorBead() { if (this.heldBead) this.heldBead.color = $('colorInput').value; this.render(); }
  setTool(tool) { if (tool !== 'bead' && this.heldBead) { this.saveUndo(); this.returnHeldBead(); } this.tool = tool; this.eraser = tool === 'erase'; this.hoverCell = null; this.render(); }
  open(kind) {
    this.kind = kind; this.size = kind === 'fish' ? 15 : 20; this.selectedCell = { x: 0, y: 0 }; this.input.value = ''; this.composing = false;
    this.cells.clear(); this.cellBeads.clear(); this.beads = []; this.heldBead = null; this.nextBeadId = 1; this.selection.clear(); this.undo = []; this.redo = []; this.strokes = []; this.redrawSketch(); this.tool = 'bead'; this.eraser = false; this.dragging = false; this.hoverCell = null;
    $('fishGenderPicker').hidden = kind !== 'fish'; $('fishNameLabel').hidden = kind !== 'fish'; $('drawingEyesLabel').hidden = kind !== 'fish'; this.autoName = true; $('fishNameInput').value = ''; $('fishGenderMale').checked = true;
    $('creatorEyes').hidden = kind !== 'fish';
    $('creatorTitle').textContent = kind === 'fish' ? '拼一条鱼' : '拼一块造景';
    $('creatorRule').textContent = kind === 'fish' ? '15×15，2–15 字，八方向连成一体。投放后鱼自主生活。' : '20×20，至少两个字，八方向连成一体。造景可以挡住鱼和鱼食，消耗不返还。';
    this.setTab('grid'); this.render(); $('creatorDialog').showModal(); this.focusCell();
  }
  setTab(tab) {
    if (tab === 'draw' && this.heldBead) { this.saveUndo(); this.returnHeldBead(); }
    if (tab === 'draw' && this.tool !== 'erase') this.tool = 'bead';
    this.tab = tab; $('gridEditor').hidden = tab !== 'grid'; this.grid.hidden = tab !== 'grid'; this.sketch.hidden = tab !== 'draw';
    for (const id of ['beadSelection', 'beadPalette', 'colorPen', 'selectBeads']) $(id).hidden = tab !== 'grid';
    $('beadPen').textContent = tab === 'grid' ? '拼豆笔' : '手绘笔';
    $('gridTab').classList.toggle('active', tab === 'grid'); $('drawTab').classList.toggle('active', tab === 'draw'); $('convertDrawing').hidden = tab !== 'draw'; $('brushWidthLabel').hidden = tab !== 'draw';
    this.hoverCell = null; this.render(); if ($('creatorDialog').open && tab === 'grid') this.focusCell();
  }
  focusCell() { if (this.tab === 'grid') this.input.focus({ preventScroll: true }); }
  keydown(e) {
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); this.restoreHistory(e.shiftKey || e.key.toLowerCase() === 'y' ? this.redo : this.undo, e.shiftKey || e.key.toLowerCase() === 'y' ? this.undo : this.redo); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (delta) { e.preventDefault(); this.selectedCell.x = Math.max(0, Math.min(this.size - 1, this.selectedCell.x + delta[0])); this.selectedCell.y = Math.max(0, Math.min(this.size - 1, this.selectedCell.y + delta[1])); this.input.value = ''; this.hoverCell = null; this.selection.clear(); this.render(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault(); const keys = this.selection.size ? [...this.selection] : [`${this.selectedCell.x},${this.selectedCell.y}`];
      if (keys.some(key => this.cells.has(key))) { this.saveUndo(); for (const key of keys) { this.returnCellBead(key); this.cells.delete(key); } this.selection.clear(); this.render(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (this.tool === 'select') { const key = `${this.selectedCell.x},${this.selectedCell.y}`; this.selection = this.cells.has(key) ? new Set([key]) : new Set(); this.render(); return; }
      this.gestureSaved = false; this.visited = new Set(); this.eraseNow = this.tool === 'erase'; this.paint({ x: (this.selectedCell.x + .5) * 400 / this.size, y: (this.selectedCell.y + .5) * 400 / this.size });
    }
  }
  typeCell() {
    const ch = this.input.value; this.input.value = ''; if (!validGlyph(ch)) return;
    this.saveUndo(); const { x, y } = this.selectedCell, key = `${x},${y}`; this.returnHeldBead(); this.returnCellBead(key);
    const bead = this.makeBead(ch); this.cells.set(key, { x, y, ch, color: bead.color }); this.cellBeads.set(key, bead); this.selection.clear(); this.tool = 'bead'; this.eraser = false; this.render();
  }
  snapshot() { return { cells: [...this.cells.entries()].map(([k, v]) => [k, { ...v }]), cellBeads: structuredClone([...this.cellBeads]), strokes: structuredClone(this.strokes), beads: structuredClone(this.beads), heldBead: this.heldBead && { ...this.heldBead }, nextBeadId: this.nextBeadId, text: $('glyphInput').value, tool: this.tool, selection: [...this.selection], selectedCell: { ...this.selectedCell } }; }
  saveUndo() { this.undo.push(this.snapshot()); if (this.undo.length > 30) this.undo.shift(); this.redo = []; }
  restoreHistory(from, to) {
    const old = from.pop(); if (!old) return; to.push(this.snapshot()); this.cells = new Map(old.cells); this.cellBeads = new Map(old.cellBeads); this.strokes = old.strokes; this.beads = old.beads; this.heldBead = old.heldBead; this.nextBeadId = old.nextBeadId; this.tool = old.tool; this.eraser = this.tool === 'erase'; this.selection = new Set(old.selection); this.selectedCell = old.selectedCell; $('glyphInput').value = old.text;
    if (this.heldBead) $('colorInput').value = this.heldBead.color; this.hoverCell = null; this.redrawSketch(); this.render();
  }
  saveGesture() { if (!this.gestureSaved) { this.saveUndo(); this.gestureSaved = true; } }
  fishName() { return this.autoName || !$('fishNameInput').value.trim() ? this.getDefaultName(this.cells.size) : $('fishNameInput').value.trim(); }
  coordinates(e, canvas) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * 400 / r.width, y: (e.clientY - r.top) * 400 / r.height }; }
  gridPoint(p) { return { x: Math.floor(p.x / 400 * this.size), y: Math.floor(p.y / 400 * this.size) }; }
  down(e, canvas) {
    if (this.dragging || ![0, 2].includes(e.button)) return; e.preventDefault(); canvas.setPointerCapture(e.pointerId); this.pointerId = e.pointerId; this.dragging = true; this.gestureSaved = false; this.visited = new Set(); this.eraseNow = this.tool === 'erase' || e.button === 2; this.previous = this.coordinates(e, canvas);
    if (canvas === this.grid) {
      this.focusCell(); this.selectionStart = this.gridPoint(this.previous); this.selectionBase = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(this.selection) : new Set();
      if (this.tool === 'select' && !this.eraseNow) this.selectRectangle(this.previous); else this.paint(this.previous);
    } else { this.saveGesture(); this.currentStroke = { points: [this.previous], color: $('colorInput').value, width: +$('brushWidth').value, erase: this.eraseNow }; this.strokes.push(this.currentStroke); this.redrawSketch(); this.render(); }
  }
  move(e, canvas) {
    const p = this.coordinates(e, canvas);
    if (!this.dragging) { if (canvas === this.grid && e.pointerType !== 'touch') { this.hoverCell = this.gridPoint(p); this.render(); } return; }
    if (this.pointerId !== e.pointerId) return;
    if (canvas === this.grid) {
      if (this.tool === 'select' && !this.eraseNow) this.selectRectangle(p);
      else if (this.tool !== 'bead' || this.eraseNow) {
        const steps = Math.max(1, Math.ceil(Math.hypot(p.x - this.previous.x, p.y - this.previous.y) / (400 / this.size / 2)));
        for (let i = 1; i <= steps; i++) this.paint({ x: this.previous.x + (p.x - this.previous.x) * i / steps, y: this.previous.y + (p.y - this.previous.y) * i / steps });
      }
    } else { this.currentStroke.points.push(p); this.redrawSketch(); }
    this.previous = p;
  }
  selectRectangle(p) {
    const end = this.gridPoint(p), start = this.selectionStart; this.selection = new Set(this.selectionBase);
    for (const [key, cell] of this.cells) if (cell.x >= Math.min(start.x, end.x) && cell.x <= Math.max(start.x, end.x) && cell.y >= Math.min(start.y, end.y) && cell.y <= Math.max(start.y, end.y)) this.selection.add(key);
    this.selectedCell = { x: Math.max(0, Math.min(this.size - 1, end.x)), y: Math.max(0, Math.min(this.size - 1, end.y)) }; this.render();
  }
  paint(p) {
    const { x, y } = this.gridPoint(p); if (x < 0 || x >= this.size || y < 0 || y >= this.size) return;
    const key = `${x},${y}`; this.selectedCell = { x, y }; this.hoverCell = null; if (this.visited.has(key)) return; this.visited.add(key);
    const old = this.cells.get(key), bead = this.currentBead();
    if (this.eraseNow) { if (old) { this.saveGesture(); this.returnCellBead(key); this.cells.delete(key); this.selection.delete(key); } }
    else if (this.tool === 'color') { if (old && old.color !== $('colorInput').value) { this.saveGesture(); old.color = $('colorInput').value; } }
    else if (old) { this.selection = new Set([key]); }
    else if (bead) { this.saveGesture(); this.cells.set(key, { x, y, ch: bead.ch, color: bead.color }); this.cellBeads.set(key, { ...bead }); this.selection.clear(); this.heldBead = null; }
    this.render();
  }
  renderBeads() {
    const { letters, error } = this.preparedLetters();
    $('glyphInput').setAttribute('aria-invalid', String(!!error)); $('prepareBeads').disabled = !!error || !letters.length;
    $('beadInputHint').textContent = error || (letters.length ? `${letters.length} 颗字符豆待准备，点击“添到盘里”后逐颗夹取。` : '输入字符并添到盘里，再夹取一颗拼放。');
    const key = JSON.stringify([this.beads, this.kind]);
    if (key !== this.trayKey) {
      this.trayKey = key; $('beadTray').replaceChildren(...this.beads.map((bead, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = bead.ch; b.style.color = bead.color; b.dataset.beadIndex = i; b.dataset.beadId = bead.id;
        b.classList.toggle('eyeBead', this.kind === 'fish' && EYES.has(bead.ch)); b.setAttribute('aria-label', `夹取第 ${i + 1} 颗字符豆 ${bead.ch}${this.kind === 'fish' && EYES.has(bead.ch) ? '，可作鱼眼' : ''}`);
        b.onclick = () => this.takeBead(bead.id); return b;
      }));
    }
    for (const [id, tool] of [['beadPen', 'bead'], ['colorPen', 'color'], ['selectBeads', 'select'], ['eraseBrush', 'erase']]) { $(id).classList.toggle('active', this.tool === tool); $(id).setAttribute('aria-pressed', String(this.tool === tool)); }
    const bead = this.currentBead();
    this.grid.dataset.tool = this.tool;
    $('beadPenPreview').hidden = this.tab !== 'grid';
    $('beadPenPreview').style.setProperty('--bead-color', this.tool === 'color' ? $('colorInput').value : bead?.color || '#83aab9');
    $('beadPenStatus').textContent = this.tool === 'bead' ? bead ? `笔上字符「${bead.ch}」${this.kind === 'fish' && EYES.has(bead.ch) ? ' · 可作鱼眼' : ''}` : '笔上没有豆子，请从字符盘夹取一颗' : this.tool === 'color' ? '上色笔 · 只改颜色' : this.tool === 'select' ? '框选 · 选中后批量上色' : '橡皮 · 擦除已拼字符';
    $('beadProgress').textContent = `盘里剩 ${this.beads.length} 颗${bead ? ` · 已夹取「${bead.ch}」` : ''}`;
    $('returnBead').disabled = !bead;
    for (const key of this.selection) if (!this.cells.has(key)) this.selection.delete(key);
    $('beadSelectionCount').textContent = this.selection.size ? `已选 ${this.selection.size} 个字` : '未选中文字';
    $('selectAllBeads').disabled = !this.cells.size; $('clearBeadSelection').disabled = $('recolorBeads').disabled = !this.selection.size; $('replaceBead').disabled = this.selection.size !== 1 || !bead;
    $('undoDrawing').disabled = !this.undo.length; $('redoDrawing').disabled = !this.redo.length;
    const eyes = [...this.cells.values()].filter(cell => EYES.has(cell.ch)).length;
    $('creatorEyeHint').textContent = eyes ? `已拼 ${eyes} 个鱼眼，会主动寻找鱼食和海草。` : this.cells.size ? '还没有鱼眼：这条鱼会是盲鱼，不主动寻找食物，但碰到食物仍能吃。可以照常投放。' : '鱼眼让鱼主动寻找鱼食和海草。没有鱼眼也可以造鱼。';
    $('boardHint').textContent = this.tab === 'draw' ? '自由画下轮廓，转换后回到拼豆画板调整。' : this.tool === 'select' ? '拖动框选已有文字；按住 Shift 可追加选区，再点“选区上色”。' : this.tool === 'color' ? '拖动给已有字上色，字形不变，空格不填字。' : this.tool === 'erase' ? '点击或拖动擦除，字符豆会回到盘里。' : '从盘里夹取一颗，再点一个空格放下。已有字先选中，再点“替换此字”；拖动不会连放。';
  }
  redrawSketch() { const ctx = this.sketchCtx; ctx.clearRect(0, 0, 400, 400); for (const s of this.strokes) { ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'; ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y); for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y); if (s.points.length === 1) { ctx.arc(s.points[0].x, s.points[0].y, s.width / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.stroke(); } ctx.globalCompositeOperation = 'source-over'; }
  convert() {
    this.saveUndo(); const image = this.sketchCtx.getImageData(0, 0, 400, 400); let minX = 400, minY = 400, maxX = -1, maxY = -1;
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) if (image.data[(y * 400 + x) * 4 + 3] > 32) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (maxX < 0) return; const max = Math.max(2, Math.min(this.kind === 'fish' ? 15 : 400, this.getBalance())), aspect = (maxX - minX + 1) / (maxY - minY + 1); let w = Math.min(this.size, Math.max(1, Math.round(Math.sqrt(max * aspect)))), h = Math.min(this.size, Math.max(1, Math.floor(max / w))); const cells = [], palette = '.-+*#O口';
    for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) { let n = 0, r = 0, g = 0, b = 0, total = 0; for (let y = Math.floor(minY + gy * (maxY - minY + 1) / h); y < minY + (gy + 1) * (maxY - minY + 1) / h; y++) for (let x = Math.floor(minX + gx * (maxX - minX + 1) / w); x < minX + (gx + 1) * (maxX - minX + 1) / w; x++) { const i = (y * 400 + x) * 4; total++; if (image.data[i + 3] > 32) { n++; r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; } } if (n) cells.push({ x: gx + Math.floor((this.size - w) / 2), y: gy + Math.floor((this.size - h) / 2), ch: palette[Math.min(palette.length - 1, Math.floor(n / total * (palette.length - 1)))], color: '#' + [r, g, b].map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('') }); }
    for (const key of this.cells.keys()) this.returnCellBead(key); this.returnHeldBead();
    this.selection.clear(); this.cells = new Map(cells.map(c => [`${c.x},${c.y}`, c])); this.cellBeads = new Map(cells.map(c => [`${c.x},${c.y}`, this.makeBead(c.ch, c.color)])); this.setTab('grid'); this.render();
  }
  drawBead(ctx, cell, s) {
    const x = (cell.x + .5) * s, y = (cell.y + .5) * s, radius = s * .43;
    ctx.save();
    // A shallow sidewall and a soft contact shadow keep the bead on the board.
    ctx.shadowColor = 'rgba(0,8,16,.5)'; ctx.shadowBlur = s * .14; ctx.shadowOffsetX = s * .035; ctx.shadowOffsetY = s * .065;
    const side = ctx.createLinearGradient(x, y - radius, x, y + radius);
    side.addColorStop(0, beadTint(cell.color, [14, 34, 46], .72)); side.addColorStop(1, beadTint(cell.color, [3, 15, 24], .82));
    ctx.fillStyle = side; ctx.beginPath(); ctx.arc(x, y + s * .045, radius, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    const face = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    face.addColorStop(0, beadTint(cell.color, [215, 240, 245], .27));
    face.addColorStop(.4, beadTint(cell.color, [18, 47, 62], .50));
    face.addColorStop(1, beadTint(cell.color, [6, 25, 38], .75));
    ctx.fillStyle = face; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(235,255,255,.28)'; ctx.lineWidth = Math.max(.65, s * .025);
    ctx.beginPath(); ctx.arc(x, y, radius - s * .018, Math.PI * 1.08, Math.PI * 1.78); ctx.stroke();
    // A quiet inset face gives the glyph its own space, away from the rim.
    const inset = ctx.createRadialGradient(x, y, s * .12, x, y, s * .35);
    inset.addColorStop(0, '#0d2c3d'); inset.addColorStop(.72, '#103244'); inset.addColorStop(1, 'rgba(16,50,68,0)');
    ctx.fillStyle = inset; ctx.beginPath(); ctx.arc(x, y, s * .35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cell.color; ctx.fillText(cell.ch, x, y, s * .56);
    ctx.restore();
  }
  render() { this.renderBeads(); const ctx = this.grid.getContext('2d'), s = 400 / this.size; ctx.clearRect(0, 0, 400, 400); ctx.strokeStyle = '#32546c'; ctx.lineWidth = .6; for (let i = 0; i <= this.size; i++) { ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, 400); ctx.moveTo(0, i * s); ctx.lineTo(400, i * s); ctx.stroke(); }
    ctx.fillStyle = '#42657a'; for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) { ctx.beginPath(); ctx.arc((x + .5) * s, (y + .5) * s, s * .055, 0, Math.PI * 2); ctx.fill(); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${s * .52}px 'Microsoft YaHei',Consolas,monospace`; for (const c of this.cells.values()) this.drawBead(ctx, c, s);
    for (const key of this.selection) { const cell = this.cells.get(key); if (!cell) continue; ctx.strokeStyle = '#ffcc66'; ctx.lineWidth = 2; ctx.strokeRect(cell.x * s + 2, cell.y * s + 2, s - 4, s - 4); }
    const hover = this.hoverCell, bead = this.currentBead();
    if (hover && hover.x >= 0 && hover.x < this.size && hover.y >= 0 && hover.y < this.size && !this.cells.has(`${hover.x},${hover.y}`) && this.tool === 'bead' && bead) { ctx.globalAlpha = .55; this.drawBead(ctx, { ...hover, ...bead }, s); ctx.globalAlpha = 1; }
    const { x, y } = this.selectedCell; ctx.strokeStyle = '#9aeee0'; ctx.lineWidth = 2; ctx.strokeRect(x * s + 1, y * s + 1, s - 2, s - 2);
    Object.assign(this.input.style, { left: `${x * 100 / this.size}%`, top: `${y * 100 / this.size}%`, width: `${100 / this.size}%`, height: `${100 / this.size}%` }); this.input.setAttribute('aria-label', `鱼元画板第 ${y + 1} 行，第 ${x + 1} 列`);
    const cells = [...this.cells.values()]; if (this.kind === 'fish' && this.autoName) $('fishNameInput').value = this.getDefaultName(cells.length); const name = this.kind === 'fish' ? this.fishName() : undefined, nameError = this.kind === 'fish' ? fishNameError(name, cells.length) : '', error = validateDrawing(cells, this.kind, this.getBalance()) || nameError; $('fishNameHint').textContent = nameError || (this.kind === 'fish' ? '鱼名 ' + Array.from(name).length + '/' + cells.length + ' 字 · 留空使用截短后的默认名' : ''); $('fishNameInput').setCustomValidity(nameError); $('drawingCount').textContent = cells.length; $('drawingEyes').textContent = cells.filter(c => EYES.has(c.ch)).length; $('drawingValidation').textContent = error || '八方向连通 ✓'; $('drawingValidation').style.color = error ? '#e9ac9e' : '#9aeee0'; $('drawingCost').textContent = `消耗 ${cells.length} 鱼元 · 当前余额 ${this.getBalance()}`; $('placeDrawing').disabled = !!error;
  }
}
