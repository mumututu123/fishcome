import { displayFishName, familyTree } from './fish-profile.js';
const NS = 'http://www.w3.org/2000/svg';
const viewports = new WeakMap();
export function setupPedigreeViewport(container, onZoom) {
  const state = { scale: 1, selected: null, canvas: null, stage: null, onZoom };
  viewports.set(container, state);
  function zoom(scale, point) {
    if (!state.canvas) return;
    const next = Math.min(2, Math.max(.25, scale)), previous = state.scale;
    const x = point?.x ?? container.clientWidth / 2, y = point?.y ?? container.clientHeight / 2;
    const oldOffset = state.stage.offsetLeft;
    const worldX = (container.scrollLeft + x - oldOffset) / previous, worldY = (container.scrollTop + y) / previous;
    state.scale = next; updatePedigreeScale(state);
    container.scrollLeft = worldX * next + state.stage.offsetLeft - x;
    container.scrollTop = worldY * next - y;
  }
  container.addEventListener('wheel', event => {
    if (!state.canvas) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect(), delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
    zoom(state.scale * Math.exp(-Math.max(-200, Math.min(200, delta)) * .002), { x: event.clientX - rect.left - container.clientLeft, y: event.clientY - rect.top - container.clientTop });
  }, { passive: false });
  let drag = null, suppressClick = false;
  container.addEventListener('pointerdown', event => {
    const rect = container.getBoundingClientRect();
    if (event.button !== 0 || !state.canvas || event.clientX - rect.left >= container.clientWidth + container.clientLeft || event.clientY - rect.top >= container.clientHeight + container.clientTop) return;
    suppressClick = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: container.scrollLeft, top: container.scrollTop, moved: false };
  });
  container.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.moved) { drag.moved = true; container.setPointerCapture(event.pointerId); container.classList.add('panning'); }
    container.scrollLeft = drag.left - (event.clientX - drag.x); container.scrollTop = drag.top - (event.clientY - drag.y);
  });
  container.addEventListener('pointerleave', () => { if (drag && !drag.moved) drag = null; });
  const endDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved; drag = null; container.classList.remove('panning');
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
  };
  container.addEventListener('pointerup', endDrag); container.addEventListener('pointercancel', endDrag);
  container.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } }, true);
  return { zoomIn: () => zoom(state.scale * 1.2), zoomOut: () => zoom(state.scale / 1.2), reset: () => zoom(1) };
}
function updatePedigreeScale(state) {
  state.canvas.style.transform = `scale(${state.scale})`;
  state.stage.style.width = `${state.width * state.scale}px`; state.stage.style.height = `${state.height * state.scale}px`;
  state.onZoom?.(state.scale);
}
export function drawPedigree(container, catalog, selected, identity, onObserve) {
  const tree = familyTree(catalog, selected); container.replaceChildren();
  const state = viewports.get(container);
  if (state) { state.canvas = state.stage = null; if (state.selected !== selected) state.scale = 1; state.selected = selected; state.onZoom?.(state.scale); }
  if (!tree.nodes.length) { const empty = document.createElement('p'); empty.className = 'quiet'; empty.textContent = tree.error || '还没有属于你的鱼，造鱼后就能查看鱼谱。'; container.append(empty); return tree; }
  const canvas = document.createElement('div'); canvas.className = 'pedigreeCanvas'; canvas.style.width = `${tree.width}px`; canvas.style.height = `${tree.height}px`; canvas.setAttribute('role', 'group'); canvas.setAttribute('aria-label', '鱼的家谱，父母在上，后代在下');
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('width', tree.width); svg.setAttribute('height', tree.height); svg.setAttribute('aria-hidden', 'true');
  const nodes = new Map(tree.nodes.map(node => [node.id, node]));
  function path(d) { const line = document.createElementNS(NS, 'path'); line.setAttribute('d', d); svg.append(line); }
  for (const family of tree.families) {
    const parents = family.parents.map(id => nodes.get(id)), children = family.children.map(id => nodes.get(id)), px = parents.map(node => node.x + 84), cx = children.map(node => node.x + 84);
    const joinY = Math.max(...parents.map(node => node.y + 108)) + 22, branchY = Math.min(...children.map(node => node.y)) - 18, mid = px.reduce((a, b) => a + b, 0) / px.length;
    for (const parent of parents) path(`M ${parent.x + 84} ${parent.y + 108} V ${joinY}`);
    path(`M ${Math.min(...px)} ${joinY} H ${Math.max(...px)}`); path(`M ${mid} ${joinY} V ${branchY}`);
    path(`M ${Math.min(mid, ...cx)} ${branchY} H ${Math.max(mid, ...cx)}`); for (const child of children) path(`M ${child.x + 84} ${branchY} V ${child.y}`);
  }
  canvas.append(svg);
  for (let generation = 0; generation < tree.generations; generation++) { const label = document.createElement('span'); label.className = 'pedigreeGeneration'; label.style.top = `${generation * 156 + 8}px`; label.textContent = `第 ${generation + 1} 代`; canvas.append(label); }
  for (const node of tree.nodes) {
    const button = document.createElement('button'), title = document.createElement('strong'), sex = document.createElement('span'), owner = document.createElement('span'), status = document.createElement('span');
    const name = node.missing ? '血缘记录缺失' : displayFishName(node, identity), mine = node.actor === identity.actor;
    button.type = 'button'; button.className = `pedigreeFish${mine ? ' mine' : ''}${node.alive ? '' : ' departed'}${node.id === selected ? ' selected' : ''}`; button.dataset.lineageFish = node.id; button.style.left = `${node.x}px`; button.style.top = `${node.y}px`; button.disabled = !node.alive;
    title.textContent = name; sex.className = `fishGender ${node.gender || ''}`; sex.textContent = node.gender === 'male' ? '♂ 公' : node.gender === 'female' ? '♀ 母' : '性别未记录';
    owner.className = 'pedigreeOwner'; owner.textContent = mine ? `${identity.nick} · 我的鱼` : node.nick || '作者记录缺失'; status.className = 'pedigreeStatus'; const shortId = node.id.startsWith('born:') ? node.id.slice(-6) : node.id.slice(0, 6); status.textContent = node.missing ? '记录缺失' : `${node.alive ? '存活' : '已消失'} · ${shortId}`;
    button.setAttribute('aria-label', `${name}，${sex.textContent}，${owner.textContent}，${status.textContent}`); if (node.id === selected) button.setAttribute('aria-current', 'true');
    button.append(title, sex, owner, status); button.onclick = () => onObserve(node.id); canvas.append(button);
  }
  const stage = document.createElement('div'); stage.className = 'pedigreeStage'; stage.append(canvas); container.append(stage);
  if (state) { Object.assign(state, { canvas, stage, width: tree.width, height: tree.height }); updatePedigreeScale(state); }
  else { stage.style.width = `${tree.width}px`; stage.style.height = `${tree.height}px`; }
  return tree;
}
