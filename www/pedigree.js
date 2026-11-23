import { displayFishName, familyTree } from './fish-profile.js';
const NS = 'http://www.w3.org/2000/svg';
export function drawPedigree(container, catalog, selected, identity, onObserve) {
  const tree = familyTree(catalog, selected); container.replaceChildren();
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
  container.append(canvas); return tree;
}
