export function defaultFishName(account, number, size) { return Array.from(`${account}的第${number}条鱼`).slice(0, Math.max(0, size)).join(''); }
export function fishNameError(name, size) {
  if (name === undefined) return ''; // Existing fish have no stored name.
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) return '请输入不含换行的鱼名';
  return Array.from(name).length > size ? `鱼名最多 ${size} 字，不能超过鱼身鱼元数` : '';
}
export function fishCatalog(data) {
  const entries = new Map();
  for (const op of Object.values(data.ops)) if (op.kind === 'fish') entries.set(op.id, { id: op.id, actor: op.actor, nick: op.nick, gender: op.gender, name: op.name, created: op.t, size: op.cells.length, parents: [], alive: !!data.fishes[op.id] });
  for (const record of Object.values(data.breeding || {})) if (record.status === 'born') { const baby = record.baby; entries.set(baby.id, { ...baby, size: baby.cells.length, alive: !!data.fishes[baby.id] }); }
  const numbers = new Map();
  for (const entry of [...entries.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) { const number = (numbers.get(entry.actor) || 0) + 1; numbers.set(entry.actor, number); entry.number = entry.nameOrdinal || number; }
  return entries;
}
export function displayFishName(entry, identity) {
  if (!entry) return '血缘记录缺失';
  if (entry.name && !entry.nameAuto) return entry.name;
  const account = entry.actor === identity?.actor ? identity.nick : entry.nick || '自然鱼';
  return defaultFishName(account, entry.number || entry.nameOrdinal || 1, entry.size || entry.cells?.length || 2);
}
export function familyTree(catalog, selected) {
  if (!catalog.has(selected)) return { nodes: [], families: [], generations: 0, width: 400, height: 160 };
  const all = new Map(catalog), links = new Map();
  const link = (a, b) => { if (!links.has(a)) links.set(a, new Set()); links.get(a).add(b); };
  for (const entry of catalog.values()) for (const parent of entry.parents || []) { if (!all.has(parent)) all.set(parent, { id: parent, parents: [], alive: false, missing: true, created: 0 }); link(entry.id, parent); link(parent, entry.id); }
  const related = new Set([selected]), queue = [selected];
  for (let index = 0; index < queue.length; index++) for (const id of links.get(queue[index]) || []) if (!related.has(id)) { related.add(id); queue.push(id); }
  const nodes = new Map([...related].map(id => [id, { ...all.get(id), generation: 0 }])), children = new Map(), degree = new Map();
  for (const node of nodes.values()) { const parents = node.parents || []; degree.set(node.id, parents.length); for (const parent of parents) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(node.id); } }
  const ready = [...nodes.values()].filter(node => !degree.get(node.id)).map(node => node.id); let visited = 0;
  for (let index = 0; index < ready.length; index++) { const id = ready[index]; visited++; for (const child of children.get(id) || []) { nodes.get(child).generation = Math.max(nodes.get(child).generation, nodes.get(id).generation + 1); degree.set(child, degree.get(child) - 1); if (!degree.get(child)) ready.push(child); } }
  if (visited !== nodes.size) return { nodes: [], families: [], generations: 0, width: 400, height: 160, error: '这份鱼谱包含循环血缘，无法排列家谱。' };
  // A founder with one partner belongs on that partner's row, not above them.
  const ancestorOf = (ancestor, descendant) => { const seen = new Set([ancestor]), pending = [ancestor]; for (let index = 0; index < pending.length; index++) for (const child of children.get(pending[index]) || []) { if (child === descendant) return true; if (!seen.has(child)) { seen.add(child); pending.push(child); } } return false; };
  for (const node of nodes.values()) if (node.parents?.length === 2) for (const [index, id] of node.parents.entries()) {
    const parent = nodes.get(id), partner = nodes.get(node.parents[1 - index]);
    if (!parent.parents?.length && parent.generation < partner.generation && (children.get(id) || []).every(child => nodes.get(child).parents.includes(partner.id)) && !ancestorOf(id, partner.id)) parent.generation = partner.generation;
  }
  for (const id of ready) for (const child of children.get(id) || []) nodes.get(child).generation = Math.max(nodes.get(child).generation, nodes.get(id).generation + 1);
  const rows = [];
  for (const node of nodes.values()) { rows[node.generation] ||= []; rows[node.generation].push(node); }
  const width = Math.max(420, Math.max(...rows.map(row => row.length)) * 196 + 48), height = rows.length * 156 + 24;
  for (const [generation, row] of rows.entries()) {
    const center = node => { const parents = node.parents || []; return parents.length ? parents.reduce((sum, id) => sum + nodes.get(id).x, 0) / parents.length : 0; };
    row.sort((a, b) => center(a) - center(b) || a.created - b.created || a.id.localeCompare(b.id));
    for (const [index, node] of row.entries()) { node.x = (width - row.length * 196) / 2 + index * 196 + 14; node.y = generation * 156 + 32; }
  }
  const families = new Map();
  for (const node of nodes.values()) if (node.parents?.length) { const id = JSON.stringify(node.parents); if (!families.has(id)) families.set(id, { parents: node.parents, children: [] }); families.get(id).children.push(node.id); }
  return { nodes: [...nodes.values()], families: [...families.values()], generations: rows.length, width, height };
}
