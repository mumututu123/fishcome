import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../www/engine.js';
import { defaultFishName, fishNameError, fishCatalog, displayFishName, familyTree } from '../www/fish-profile.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const now = Date.now() - 1000;
const glyphs = size => Array.from({ length: size }, (_, x) => ({ x, y: 0, ch: 'o', color: '#88aacc' }));
test('默认名按新增后的序号生成并按鱼身字数截短，扩展汉字不拆开', () => {
  assert.equal(defaultFishName('小林', 1, 15), '小林的第1条鱼'); assert.equal(defaultFishName('小林', 2, 2), '小林');
  assert.equal(defaultFishName('𠮷林', 1, 1), '𠮷'); assert.equal(defaultFishName('鱼人', 3, 0), '');
});
test('鱼名按Unicode鱼元计长，超长、空白或换行拒绝，旧版没有名字仍兼容', () => {
  const world = new World(now);
  const operation = name => ({ id: crypto.randomUUID(), actor: 'alice', t: now, kind: 'fish', x: 20 + Object.keys(world.data.fishes).length * 3, y: 20, cells: glyphs(2), cost: 2, name });
  for (const name of ['', '   ', '三字名', 'a\nb', null, 123]) { assert.equal(world.apply(operation(name)).ok, false); assert.equal(world.wallet('alice'), 20); }
  for (const name of ['小鱼', '𠮷鱼', '🐟鱼']) assert.equal(world.apply(operation(name)).ok, true);
  assert.equal(world.apply(operation(undefined)).ok, true); assert.equal(fishNameError('小 鱼', 3), '');
});
test('鱼名与归属随恢复与合流保存，饥饿缩小后名字不改变，已消失的鱼仍在鱼谱档案', () => {
  const world = new World(now), id = crypto.randomUUID(); assert(world.apply({ id, actor: 'alice', nick: 'a＊＊e', t: now, kind: 'fish', name: '阿鱼', x: 20, y: 20, cells: glyphs(3), cost: 3 }).ok);
  const restored = restoreCheckpoint({ world: world.serialize(), at: now }, now + 500).world, peer = new World(now); peer.merge(restored.serialize());
  peer.starve(id, now + 1000); peer.starve(id, now + 1500); const entry = fishCatalog(peer.data).get(id);
  assert.equal(entry.name, '阿鱼'); assert.equal(entry.alive, false); assert.equal(displayFishName(entry, { actor: 'alice', nick: 'Alice' }), '阿鱼');
});
function catalog() {
  const entries = [
    { id: 'father', actor: 'alice', name: '祖父', parents: [], alive: false, created: 1 },
    { id: 'mother', actor: 'bob', name: '祖母', parents: [], alive: true, created: 1 },
    { id: 'child', actor: 'alice', name: '阿鱼', parents: ['father', 'mother'], alive: true, created: 2 },
    { id: 'sibling', actor: 'bob', name: '小鱼', parents: ['father', 'mother'], alive: true, created: 3 },
    { id: 'partner', actor: 'bob', name: '伴侣', parents: [], alive: true, created: 3 },
    { id: 'grandchild', actor: 'alice', name: '孙鱼', parents: ['child', 'partner'], alive: true, created: 4 },
    { id: 'unrelated', actor: 'alice', name: '独鱼', parents: [], alive: true, created: 5 },
  ]; return new Map(entries.map(entry => [entry.id, entry]));
}
test('家谱包含双方祖先、兄弟姐妹、配偶和后代，分代排列并排除无血缘的鱼', () => {
  const tree = familyTree(catalog(), 'grandchild'); assert.equal(tree.nodes.length, 6); assert.equal(tree.generations, 3); assert.equal(tree.families.length, 2);
  const nodes = new Map(tree.nodes.map(node => [node.id, node])); assert.equal(nodes.get('father').alive, false); assert.equal(nodes.get('mother').actor, 'bob');
  for (const family of tree.families) for (const child of family.children) for (const parent of family.parents) assert(nodes.get(parent).y < nodes.get(child).y);
  assert.equal(familyTree(catalog(), 'unrelated').nodes.length, 1);
  const grandparents = tree.families.find(family => family.parents.includes('father')); assert.deepEqual(grandparents.children.sort(), ['child', 'sibling']);
});
test('重复祖先只展示一个节点，缺失祖先和循环记录有明确结果', () => {
  const related = catalog(); related.set('cross', { id: 'cross', actor: 'alice', created: 6, parents: ['child', 'sibling'] });
  const tree = familyTree(related, 'cross'); assert.equal(tree.nodes.filter(node => node.id === 'father').length, 1);
  const missing = new Map([['child', { id: 'child', parents: ['unknown'], created: 1 }]]); assert(familyTree(missing, 'child').nodes.some(node => node.missing));
  const cycle = new Map([['a', { id: 'a', parents: ['b'] }], ['b', { id: 'b', parents: ['a'] }]]); assert(familyTree(cycle, 'a').error); assert.equal(familyTree(related, 'absent').nodes.length, 0);
});
test('旧鱼和自然出生的小鱼得到适合鱼身长度的显示名，完整账号仅用于本人显示', () => {
  const mine = { actor: 'alice', nick: 'a＊＊e', nameAuto: true, name: 'a＊', nameOrdinal: 2, size: 2 };
  assert.equal(displayFishName(mine, { actor: 'alice', nick: '小林' }), '小林'); assert.equal(displayFishName(mine, { actor: 'bob', nick: '小王' }), 'a＊');
  const data = { ops: { f: { id: 'f', kind: 'fish', actor: 'alice', nick: 'a＊＊e', cells: glyphs(2), t: 1 } }, fishes: {}, breeding: {} };
  assert.equal(displayFishName(fishCatalog(data).get('f'), { actor: 'alice', nick: '小林' }), '小林');
});
