import test from 'node:test';
import assert from 'node:assert/strict';
import { World, EYES, CONFIG, components, validateDrawing, velocities, canSee, touching, cellPosition, validGlyph, chooseClaim, exteriorContour, hash } from './empty-world.mjs';
const t = Date.now() - 10000;
const cell = (x, y, ch = 'o') => ({ x, y, ch, color: '#8be7df' });
const op = (kind, values = {}, actor = 'alice') => ({ id: crypto.randomUUID(), actor, nick: 'a＊＊e', t, kind, cost: 0, ...values });
const fish = (w, cells, x = 30, y = 20, actor = 'alice') => { const p = op('fish', { cells, x, y, cost: cells.length }, actor); assert.equal(w.apply(p).ok, true); return p.id; };
test('中文、扩展汉字与 ASCII 每格一个鱼元；眼睛只有六种', () => { for (const ch of ['鱼', '口', '。', '𠮷', '/', 'Q', '.']) assert.equal(validGlyph(ch), true, ch); for (const ch of ['你好', '', ' ', '🐟']) assert.equal(validGlyph(ch), false); assert.deepEqual([...EYES], ['0', 'O', 'o', '。', '.', '口']); assert.equal(EYES.has('8'), false); assert.equal(EYES.has('Q'), false); });
test('创建需八方向整体连通，鱼最多十五字，中文按格计费', () => { assert.equal(components([cell(0, 0), cell(1, 1)]).length, 1); assert.equal(validateDrawing([cell(0, 0), cell(1, 1)], 'fish', 2), ''); assert.match(validateDrawing([cell(0, 0), cell(1, 0), cell(5, 0), cell(6, 0)], 'fish'), /整体/); assert.match(validateDrawing(Array.from({ length: 16 }, (_, i) => cell(i % 8, Math.floor(i / 8))), 'fish'), /15/); assert.match(validateDrawing([cell(0, 0)], 'scene'), /两个/); const w = new World(t); fish(w, [cell(0, 0, '鱼'), cell(1, 0, '口')]); assert.equal(w.wallet('alice'), 18); });
test('鱼的外接宽高除以总鱼元数，斜线有双向优势', () => { assert.deepEqual(velocities([cell(0, 0), cell(1, 1)]), { x: 2, y: 2 }); assert.deepEqual(velocities([cell(0, 0), cell(1, 0)]), { x: 2, y: 1 }); });
test('同形鱼饥饿时各自选字，断开等大的两段仍按这条鱼的记录裁决', () => {
  const world = new World(t), body = Array.from({ length: 5 }, (_, i) => cell(i, 0));
  const ids = Array.from({ length: 6 }, (_, i) => fish(world, body, 20 + 10 * i, 20, 'owner' + i));
  const reference = new World(t);
  reference.data = world.serialize();
  const groups = world.fishGroups(), layout = world.bodyLayout(groups);
  for (const [i, id] of ids.entries()) {
    const cells = groups.get(id), selected = [cells[0].id, cells[2].id, null][i % 3];
    world.starve(id, t + i, selected, { cells, hull: layout.hull(cells) });
    reference.starve(id, t + i, selected);
    assert.deepEqual(world.data.chars, reference.data.chars);
    assert.deepEqual(world.data.fishes, reference.data.fishes);
  }
});
test('每只眼睛浅水二十格、深水十格，包含边界和斜角，按眼睛所在深度划分且盲鱼不能追', () => {
  const f = { x: 40, y: 20, facing: 1 };
  assert.equal(canSee(f, [cell(0, 0, 'Q')], { x: 41, y: 21 }), false);
  for (const [y, radius] of [[20, 20], [59, 20], [60, 10], [80, 10]]) {
    const fish = { ...f, y };
    assert(canSee(fish, [cell(0, 0)], { x: 40 + radius, y: y - radius }));
    assert.equal(canSee(fish, [cell(0, 0)], { x: 41 + radius, y }), false);
    assert.equal(canSee(fish, [cell(0, 0)], { x: 40, y: y - radius - 1 }), false);
  }
  assert(canSee(f, [cell(0, 0), cell(10, 0)], { x: 70, y: 20 }));
  assert.equal(canSee({ ...f, y: 59 }, [cell(0, 1)], { x: 55, y: 60 }), false);
  assert(canSee({ x: 995, y: 20, facing: 1 }, [cell(0, 0)], { x: 15, y: 20 }));
});

test('实际觅食覆盖扩大的分桶范围，浅水20格、深水10格及左右接缝不会漏食', () => {
  for (const [x, y, dx, dy] of [[49, 20, 20, 0], [49, 40, -20, 0], [49, 25, 0, 20], [49, 45, 0, -20], [49, 25, 20, 20], [49, 65, 10, 0], [995, 20, 20, 0], [5, 20, -20, 0]]) {
    const world = new World(t), targetX = (x + dx + 1000) % 1000;
    let id, random;
    do { id = crypto.randomUUID(); const r = hash(`${id}:0`); random = { x: [-1, 0, 1][r % 3], y: [-1, 0, 1][Math.floor(r / 3) % 3] }; } while (random.x === (dx > 0 ? 1 : -1) && random.y === Math.sign(dy));
    assert(world.apply({ ...op('fish', { cells: [cell(0, 0), cell(1, 0, '鱼')], x, y, cost: 2 }), id }).ok);
    const food = op('food', { x: targetX, y: 0, ch: '食', color: '#ffffff', cost: 1 }, 'feeder'); assert(world.apply(food).ok); world.data.chars[food.id].y = y + dy;
    world.data.fishes[id].cx = world.data.fishes[id].cy = 1;
    world.step(t + 500);
    // A left turn moves the two-cell body's anchor one cell right before swimming left.
    assert.equal(world.data.fishes[id].x, (x + (dx > 0 ? 1 : 0)) % 1000, `${x},${y}朝${dx},${dy}`);
    assert.equal(world.data.fishes[id].facing, dx > 0 ? 1 : -1);
    assert.equal(world.data.fishes[id].y, y + Math.sign(dy), `${x},${y}朝${dx},${dy}`);
  }
});
test('接触包含对角，盲鱼可被动吃食，原色原字成为原位新部分', () => { const w = new World(t), id = fish(w, [cell(0, 0, 'Q'), cell(1, 0, '8')], 20, 2); const food = op('food', { ch: '口', color: '#ff9933', x: 19, y: 0, cost: 1 }, 'bob'); assert.equal(w.apply(food).ok, true); w.data.chars[food.id].y = 1; w.step(t + 500); const c = w.data.chars[food.id]; assert.equal(c.kind, 'fish'); assert.equal(c.entity, id); assert.equal(c.ch, '口'); assert.equal(c.color, '#ff9933'); assert.equal(w.fishCells(id).length, 3); assert.equal(w.wallet('alice'), 18); assert.equal(w.wallet('bob'), 19); });
test('同时接触同一颗鱼食，大鱼唯一胜出', () => { const w = new World(t); const small = fish(w, [cell(0, 0, 'x'), cell(1, 0, 'x')], 20, 2, 's'); const big = fish(w, [cell(0, 0, 'x'), cell(1, 0, 'x'), cell(2, 0, 'x')], 17, 2, 'b'); const food = op('food', { ch: '.', color: '#ffeeaa', x: 20, y: 0, cost: 1 }, 'giver'); w.apply(food); w.data.chars[food.id].y = 1; for (const f of Object.values(w.data.fishes)) { f.cx = -10; f.cy = -10; } w.step(t + 500); assert.equal(w.data.chars[food.id].entity, big); assert.equal(w.fishCells(small).length, 2); assert.equal(w.fishCells(big).length, 4); });
test('24小时丢掉桥接字，只留最大块，其余逐字为鱼食且无退款', () => { const w = new World(t), id = fish(w, [cell(0, 0), cell(1, 0), cell(2, 0, '-'), cell(3, 0), cell(4, 0), cell(5, 0)], 20, 20); const middle = w.fishCells(id).find(c => c.x === 2); w.starve(id, t + CONFIG.hunger, middle.id); assert.equal(w.fishCells(id).length, 3); assert.equal(w.data.chars[middle.id].kind, 'burn'); assert.equal(Object.values(w.data.chars).filter(c => c.kind === 'food').length, 2); assert.equal(w.wallet('alice'), 14); });
test('只剩一字就成为鱼食，没有第二条鱼', () => { const w = new World(t), id = fish(w, [cell(0, 0), cell(1, 0)]); w.starve(id, t + CONFIG.hunger); assert.equal(Object.keys(w.data.fishes).length, 0); assert.equal(w.counts().food, 1); });
test('鱼食只从水面投放，被造景挡住满五分钟附着，移动支撑一起移动', () => { const w = new World(t); const scene = op('scene', { cells: [cell(0, 0, '='), cell(1, 0, '=')], x: 30, y: 2, cost: 2 }); assert.equal(w.apply(scene).ok, true); const f = op('food', { ch: '口', color: '#ffeeaa', x: 30, y: 1, cost: 1 }, 'bob'); assert.equal(w.apply(f).ok, false); f.y = 0; assert.equal(w.apply(f).ok, true); for (let i = 1; i <= 12; i++) w.step(t + i * 500); assert.equal(w.data.chars[f.id].y, 1); w.step(t + CONFIG.foodLife); assert.equal(w.data.chars[f.id].kind, 'scene'); assert.equal(w.data.chars[f.id].entity, scene.id); assert.equal(w.sceneCells(scene.id).length, 3); assert.equal(w.apply(op('sceneMove', { scene: scene.id, x: 40, y: 10, cost: 0 })).ok, true); assert.equal(w.data.scenes[scene.id].x + w.data.chars[f.id].x, 40); assert.equal(w.wallet('bob'), 19); });
test('二维鱼不能穿墙，转头也检查经过的鱼元格', () => { const w = new World(t); const id = fish(w, [cell(0, 0), cell(1, 0)], 30, 10); const s = op('scene', { cells: [cell(0, 0, '#'), cell(0, 1, '#')], x: 32, y: 10, cost: 2 }, 'wall'); w.apply(s); const f = w.data.fishes[id]; assert.equal(w.canOccupy({ ...f, x: 31 }, w.fishCells(id)), false); const sparse = [cell(0, 0), cell(1, 1), cell(2, 2)]; const separate = new World(t), sid = fish(separate, sparse, 10, 10); const obstacle = op('scene', { cells: [cell(0, 0, '#'), cell(1, 0, '#')], x: 10, y: 12, cost: 2 }, 'wall'); assert.equal(separate.apply(obstacle).ok, true); assert.equal(separate.turn(separate.data.fishes[sid], separate.fishCells(sid)), false); });
test('协议拒绝人工鱼编辑、删除、负费用和退款伪造', () => { const w = new World(t), id = fish(w, [cell(0, 0), cell(1, 0)]); for (const kind of ['fishDelete', 'fishEdit', 'refund', 'fishMove']) assert.equal(w.apply(op(kind, { fish: id })).ok, false); assert.equal(w.apply(op('earn', { serial: 1, cost: -20 })).ok, false); const scene = op('scene', { cells: [cell(0, 0), cell(1, 0)], x: 50, y: 50, cost: 2 }); w.apply(scene); assert.equal(w.apply(op('sceneDelete', { scene: scene.id, cost: -20 })).ok, false); assert.equal(w.apply(op('sceneDelete', { scene: scene.id, cost: 0 })).ok, true); assert.equal(w.wallet('alice'), 16); });

test('造景统计仅包含存活人工造景和一个记忆口，沉积不增加、删景减少、合流去重', () => {
  const world = new World(t); assert.equal(world.counts().scene, 1);
  const scene = op('scene', { cells: [cell(0, 0, '='), cell(1, 0, '=')], x: 30, y: 2, cost: 2 }); assert(world.apply(scene).ok); assert.equal(world.counts().scene, 2);
  const attached = op('food', { x: 30, y: 0, ch: '食', color: '#ffffff', cost: 1 }, 'feeder'); assert(world.apply(attached).ok); world.data.chars[attached.id].y = 1;
  const loose = op('food', { x: 100, y: 0, ch: '食', color: '#ffffff', cost: 1 }, 'feeder'); assert(world.apply(loose).ok); world.data.chars[loose.id].y = world.floorAt(100) - 1;
  world.step(t + CONFIG.foodLife); assert.equal(world.data.chars[attached.id].entity, scene.id); assert.equal(world.data.chars[loose.id].kind, 'scene'); assert.equal(Object.keys(world.data.scenes).length, 2); assert.equal(world.counts().scene, 2);
  const peer = new World(t); peer.merge(world.serialize()); peer.merge(world.serialize()); assert.equal(peer.counts().scene, 2);
  assert(peer.apply(op('sceneMove', { scene: scene.id, x: 40, y: 10 })).ok); assert.equal(peer.counts().scene, 2);
  assert(peer.apply(op('sceneDelete', { scene: scene.id })).ok); assert.equal(peer.counts().scene, 1); assert(peer.data.ops[scene.id]);
  assert.equal(new World(t).counts().scene, 1);
});
test('合并保留两世界作品，初始只算一次，可为负余额；重复合并不重复收费', () => { const a = new World(t), b = new World(t + 1); const cells = Array.from({ length: 15 }, (_, i) => cell(i, 0)); fish(a, cells, 20, 20); fish(b, cells, 100, 20); a.merge(b.serialize()); assert.equal(a.counts().fish, 2); assert.equal(a.wallet('alice'), -10); a.merge(b.serialize()); assert.equal(a.wallet('alice'), -10); const income = { ...op('earn', { cost: 0, serial: 1 }), id: 'alice:hour:1' }; assert.equal(a.apply(income).ok, true); assert.equal(a.wallet('alice'), -9); assert.equal(a.apply(income).duplicate, true); assert.equal(a.wallet('alice'), -9); assert.equal(a.apply(op('food', { x: 5, y: 0, ch: '.', color: '#ffeeaa', cost: 1 })).ok, false); });
test('分区中同食被不同鱼吃到，合并按较大候选选择，不复制该鱼元', () => { const initial = new World(t); const small = fish(initial, [cell(0, 0), cell(1, 0)], 30, 20, 's'), big = fish(initial, [cell(0, 0), cell(1, 0), cell(2, 0)], 50, 20, 'b'); const food = op('food', { x: 10, y: 0, ch: '口', color: '#ffeeaa', cost: 1 }, 'giver'); initial.apply(food); const one = initial.serialize(), two = initial.serialize(); for (const [state, target, rank] of [[one, small, 2], [two, big, 3]]) { const c = state.chars[food.id]; c.kind = 'fish'; c.entity = target; c.x = -1; c.y = 0; c.path.push({ id: 'eat:' + c.id, t: t + 1000, reason: 'eat', rank, target, x: -1, y: 0 }); } const a = new World(t), b = new World(t); a.merge(one); a.merge(two); b.merge(two); b.merge(one); assert.equal(a.data.chars[food.id].entity, big); assert.equal(b.data.chars[food.id].entity, big); assert.equal(a.counts().characters, 6); });
test('封闭地形角不能通过对角接触长出鱼体', () => {
  const w = new World(t), id = fish(w, [cell(0, 0, 'x'), cell(0, 1, 'x')], 30, 10);
  const s = op('scene', { x: 30, y: 9, cells: [cell(0, 0, '#'), cell(1, 1, '#')], cost: 2 }, 'wall'); assert(w.apply(s).ok);
  const f = op('food', { x: 31, y: 0, ch: '.', color: '#ffeeaa', cost: 1 }, 'giver'); w.apply(f); w.data.chars[f.id].y = 9;
  assert.equal(touching(w.data.fishes[id], w.fishCells(id), w.data.chars[f.id], w.sceneryMap()), false);
  w.step(t + 500); assert.equal(w.data.chars[f.id].kind, 'food');
});
test('已相邻的食物先进入争食结算，不能被游动漏掉', () => {
  const w = new World(t), id = fish(w, [cell(0, 0, 'x'), cell(1, 0, 'x')], 30, 3);
  const f = op('food', { x: 29, y: 0, ch: '口', color: '#ffeeaa', cost: 1 }, 'giver'); w.apply(f); w.data.chars[f.id].y = 2; w.data.fishes[id].cx = 2; w.data.fishes[id].cy = 2;
  w.step(t + 500); assert.equal(w.data.chars[f.id].entity, id); assert.equal(w.data.fishes[id].x, 30); assert.equal(w.data.fishes[id].y, 3);
});
test('同一食物的更新位置在副本合并中保留', () => {
  const w = new World(t), f = op('food', { x: 10, y: 0, ch: '口', color: '#ffeeaa', cost: 1 }); w.apply(f);
  const old = w.serialize(); w.data.chars[f.id].y = 10; w.data.chars[f.id].moveAt = t + 1000; w.merge(old); assert.equal(w.data.chars[f.id].y, 10);
});
test('合流景物避开鱼及其他景物，完整保留作品且重复安置稳定', () => {
  const a = new World(t), b = new World(t), id = fish(a, [cell(0, 0), cell(1, 0)], 30, 20);
  for (const [w, who] of [[a, 'a'], [b, 'b']]) assert(w.apply(op('scene', { x: 32, y: 20, cells: [cell(0, 0, '木'), cell(1, 0, '石')], cost: 2 }, who)).ok);
  assert(b.apply(op('scene', { x: 30, y: 20, cells: [cell(0, 0), cell(1, 0)], cost: 2 }, 'c')).ok);
  a.merge(b.serialize()); assert.equal(a.reconcileGeometry(t + 1000).waiting, 0);
  const points = a.sceneryMap(); assert.equal(points.size, 6); for (const p of a.fishMap().keys()) assert.equal(points.has(p), false);
  const scenes = JSON.stringify(a.data.scenes); a.reconcileGeometry(t + 2000); assert.equal(JSON.stringify(a.data.scenes), scenes); assert.equal(a.fishCells(id).length, 2);
});
test('同位置多颗鱼食到期逐字堆积，不能重叠丢字', () => {
  const w = new World(t); for (let i = 0; i < 3; i++) { const f = op('food', { x: 30, y: 0, ch: '口', color: '#ffeeaa', cost: 1 }); w.apply(f); w.data.chars[f.id].y = CONFIG.depth - 1; }
  w.step(t + CONFIG.foodLife); assert.equal(w.sceneryMap().size, 3); assert.equal(Object.values(w.data.chars).filter(c => c.payer === 'alice').length, 3); assert.equal(w.wallet('alice'), 17);
});
test('饥饿只选外部轮廓，密闭内部孔洞不构成外轮廓', () => {
  const cells = []; for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) if (x !== 3 || y !== 3) cells.push(cell(x, y));
  assert.equal(exteriorContour(cells).some(c => c.x === 3 && c.y === 2), false); assert.equal(exteriorContour(cells).length, 24);
});
