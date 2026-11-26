// Loaded only by the isolated browser benchmark. The app keeps its normal
// renderer, controls, coordinator, storage and worker after this world is installed.
export function makeFishWorld(World, count, width) {
  const now = Date.now(), world = new World(now, '00000000-0000-4000-8000-000000000001', { populate: false });
  const body = [{ x: 0, y: 0, ch: 'o', color: '#8be7df' }, { x: 1, y: 0, ch: '鱼', color: '#8be7df' }];
  const rows = 16, columns = Math.floor(width / 6);
  if (columns * rows < count) throw new Error('测试海域不足');
  for (let i = 0; i < count; i++) {
    const id = '00000000-0000-4000-a000-' + i.toString(16).padStart(12, '0');
    const x = (i % columns) * 6, y = 3 + Math.floor(i / columns) * 4;
    const actor = 'owner-' + Math.floor(i / 8), t = now - 1000;
    world.data.fishes[id] = { id, actor, nick: '压测', gender: 'male', x, y, facing: 1, created: t, lastFed: t, hungerAt: t + 86400000, cx: 0, cy: 0, posAt: t };
    world.data.travel[id] = { since: t, days: {} };
    world.data.ops[id] = { id, kind: 'fish', actor, nick: '压测', gender: 'male', x, y, t, cost: 2, roots: [world.id], cells: body };
    for (let j = 0; j < body.length; j++) {
      const key = id + ':' + j;
      world.data.chars[key] = { ...body[j], id: key, payer: actor, kind: 'fish', entity: id, path: [], created: t };
    }
  }
  // Layout is injective: every fish gets two adjacent cells in a distinct 6 × 4 rectangle.
  if (3 + Math.floor((count - 1) / columns) * 4 >= world.data.terrain.depths.reduce((min, depth) => Math.min(min, depth), Infinity)) throw new Error('鱼体越过水面或海底');
  return world;
}
