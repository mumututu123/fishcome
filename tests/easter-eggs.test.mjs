import test from 'node:test';
import assert from 'node:assert/strict';
import { World, clone } from '../www/engine.js';
import { bubbleGlyph, bubbleState } from '../www/bubbles.js';
import { ancestralGlyph, ancestralText, echoCells, friendSignals, hasFriendSecret, memoryForCell } from '../www/easter-eggs.js';
import { LIFE, lifeContext, updateLife, recordStory, pairKey, validateLife, mergeLife, storyText } from '../www/life.js';
import { CHAT_FLOOR } from '../www/chat.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
import { archiveDependencies } from '../www/archive.js';

const start = Date.now() - 3600000;
const cells = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: '木', color: '#88aacc' }];
function make() { return new World(start, crypto.randomUUID(), { populate: false }); }
function create(w, kind, x, y) {
  const id = crypto.randomUUID(); assert(w.apply({ id, actor: kind, nick: kind, t: start, kind, x, y, cells, cost: 2 }).ok); return id;
}
function tick(w, at) { updateLife(w, at, lifeContext(w, at, w.sceneryMap(), w.fishGroups())); w.data.tick = at; }
function learn(w) { for (let i = 1; i <= 45; i++) tick(w, start + i * 1000); }
function move(w, scene, x, at) { assert(w.apply({ id: crypto.randomUUID(), actor: 'scene', kind: 'sceneMove', scene, x, y: 20, cost: 0, t: at }).ok); }
const sources = w => ({ roots: w.data.roots, ops: w.data.ops, breeding: w.data.breeding });

test('气泡秘密按出生标识固定，稀有问号更少；不改变上浮与扩张', () => {
  const counts = new Map();
  for (let i = 0; i < 10000; i++) { const b = { id: `bubble:${i}:42`, born: start, x: 999, depth: 96 }, ch = bubbleGlyph(b); counts.set(ch, (counts.get(ch) || 0) + 1); assert.equal(bubbleGlyph(clone(b)), ch); assert.deepEqual(bubbleState(b, start + 26000), bubbleState({ ...b, id: 'other' }, start + 26000)); }
  assert.deepEqual(new Set(counts.keys()), new Set(['泡', '咕', '噜', '？'])); assert(counts.get('泡') > 9000); assert(counts.get('？') < counts.get('咕'));
});

test('熟鱼暗号分四拍、六秒结束；只在重逢且仍相邻时出现，不重放历史', () => {
  const w = make(), a = create(w, 'fish', 20, 20), b = create(w, 'fish', 25, 20); learn(w);
  let at = start + 600000, story;
  do { recordStory(w, 'reunion', a, at, { other: b }); story = Object.values(w.data.life.stories).find(r => r.kind === 'reunion' && r.at === at); if (!hasFriendSecret(story)) at += 600000; } while (!hasFriendSecret(story));
  for (const [i, ch] of ['好', '久', '不', '见'].entries()) { const now = at + i * 1500; w.data.life.bonds[pairKey(a, b)].lastNear = now; assert.deepEqual(friendSignals(w.data, now).map(s => [s.fish, s.ch]), [[i % 2 ? b : a, ch]]); }
  assert.equal(friendSignals(w.data, at + 6000).length, 0); assert.equal(friendSignals(w.data, at - 1).length, 0);
  w.data.life.bonds[pairKey(a, b)].lastNear = at - 5000; assert.equal(friendSignals(w.data, at).length, 0);
  assert.match(storyText(story, id => id), /暗号/);
});

test('海底考古只读取对应旧聊天，完整表情和组合文字保留，错配被拒绝', () => {
  const w = make(), message = { id: crypto.randomUUID(), kind: 'chat', actor: 'past', body: { nick: '<旧作者>', text: '木👩‍🚀é <script>', t: start - 1000, roots: [crypto.randomUUID()] } };
  w.data.chatSources[message.id] = message; w.reconcileChatFloor();
  const memories = Object.values(w.data.chars).filter(c => c.chat);
  for (const c of memories) assert.equal(memoryForCell(w.data, c.id).text, message.body.text);
  assert(memories.some(c => c.ch === '👩‍🚀')); assert(memories.some(c => c.ch === 'é'));
  const c = memories[0]; c.chatIndex = 999; assert.equal(memoryForCell(w.data, c.id), null);
  assert.equal(memoryForCell(w.data, 'missing'), null); assert.equal(w.wallet('past'), 20);
});

test('海底回声匹配真实附近鱼元、支持环形接缝，移开或不同文字不发光', () => {
  const w = make(), fish = create(w, 'fish', 998, 20);
  w.data.scenes[CHAT_FLOOR] = { x: 0, y: 0 };
  w.data.chars.old = { id: 'old', entity: CHAT_FLOOR, kind: 'scene', chat: 'past', x: 1, y: 20, ch: '木' };
  assert(echoCells(w.data).has('old')); w.data.chars.old.ch = '火'; assert(!echoCells(w.data).has('old'));
  w.data.chars.old.ch = '木'; w.data.fishes[fish].x = 40; assert(!echoCells(w.data).has('old'));
});

function ancestry() {
  const data = { breeding: {}, fishes: {}, chars: {} }, path = [];
  let parent = 'founder';
  for (let i = 1; i <= 3; i++) {
    const id = `receipt-${i}`, baby = `born:${id}`, inherited = { id: 'same-cell', parent, before: '木', after: '木' };
    data.breeding[id] = { id, status: 'born', baby: { id: baby, parents: [parent, `partner-${i}`], cells: [inherited] } };
    path.push({ reason: 'birth', birth: id, target: baby, from: parent, before: '木', after: '木' }); parent = baby;
  }
  data.fishes[parent] = { id: parent }; data.chars['same-cell'] = { id: 'same-cell', ch: '木', kind: 'fish', entity: parent, path };
  return { data, id: parent };
}
test('祖传字沿同一鱼元连续三次出生凭据追溯；同字、改眼、重新吃入不冒充继承', () => {
  const { data, id } = ancestry(), glyph = ancestralGlyph(data, id);
  assert.deepEqual(glyph, { cell: 'same-cell', ch: '木', ancestor: 'founder', generations: 4 }); assert.match(ancestralText(glyph, () => '曾祖'), /曾祖.*4 代/);
  const saved = clone(data); assert.deepEqual(ancestralGlyph(saved, id), glyph);
  data.breeding['receipt-2'].baby.cells[0].id = 'other-cell'; assert.equal(ancestralGlyph(data, id), null);
  const changed = clone(saved); changed.breeding['receipt-2'].baby.cells[0].before = 'o'; assert.equal(ancestralGlyph(changed, id), null);
  const eaten = clone(saved); eaten.chars['same-cell'].path.splice(2, 0, { reason: 'eat', target: 'born:receipt-2' }); assert.equal(ancestralGlyph(eaten, id), null);
  const shed = clone(saved); shed.chars['same-cell'].kind = 'food'; assert.equal(ancestralGlyph(shed, id), null);
  assert.equal(ancestralGlyph(saved, 'founder'), null);
});

test('旧地真正离开再返回才记故事，重遇搬走的原造景另记一条，重复合流不复制', () => {
  const w = make(), id = create(w, 'fish', 20, 20), scene = create(w, 'scene', 24, 20); learn(w);
  assert.equal(w.data.life.haunts[id].scene, scene); move(w, scene, 80, start + 46000); tick(w, start + 46000);
  assert(!Object.values(w.data.life.stories).some(s => s.kind === 'revisit'));
  w.data.fishes[id].x = 50; tick(w, start + 47000); w.data.fishes[id].x = 20; tick(w, start + 48000);
  assert.equal(Object.values(w.data.life.stories).filter(s => s.kind === 'revisit').length, 1);
  w.data.fishes[id].x = 76; tick(w, start + 49000);
  assert.equal(Object.values(w.data.life.stories).filter(s => s.kind === 'rediscover').length, 1);
  assert(validateLife(w.data.life, sources(w))); const saved = w.serialize(); w.merge(saved); w.merge(saved);
  assert.equal(Object.values(w.data.life.stories).filter(s => ['revisit', 'rediscover'].includes(s.kind)).length, 2);
  assert.deepEqual(mergeLife(saved.life, w.data.life, w.data), mergeLife(w.data.life, saved.life, w.data));
  assert.equal(w.wallet('fish'), 18); assert.equal(w.wallet('scene'), 18);
});

test('被移除的造景仍有旧地记忆，备份保留引用；离线不补故事，旧存档迁移', () => {
  const w = make(), id = create(w, 'fish', 20, 20), scene = create(w, 'scene', 24, 20); learn(w);
  assert(w.apply({ id: crypto.randomUUID(), actor: 'scene', kind: 'sceneDelete', scene, cost: 0, t: start + 46000 }).ok);
  tick(w, start + 46000); assert(w.data.life.haunts[id]); assert(!w.data.life.places[id]);
  assert(archiveDependencies(w.data).ops.has(scene)); const saved = w.serialize();
  const restored = restoreCheckpoint({ world: saved, lastOnlineAt: saved.tick }, saved.tick + 100000).world;
  tick(restored, saved.tick + 100000); assert(!Object.values(restored.data.life.stories).some(s => s.kind === 'revisit'));
  restored.data.fishes[id].x = 50; tick(restored, saved.tick + 101000); restored.data.fishes[id].x = 20; tick(restored, saved.tick + 102000);
  assert(Object.values(restored.data.life.stories).some(s => s.kind === 'revisit'));
  const legacy = clone(saved); delete legacy.life.haunts; assert(validateLife(legacy.life, sources(w)));
  restored.merge(legacy); assert(restored.data.life.haunts[id]);
  for (const mutate of [r => r.x = -1, r => r.displaced = Infinity, r => r.scene = 'fake', r => r.visited = 'yes']) { const bad = clone(saved.life); mutate(bad.haunts[id]); assert(!validateLife(bad, sources(w))); }
});

test('造景搬回旧地时认出原景，不记录错误的风景换了', () => {
  const w = make(), id = create(w, 'fish', 20, 20), scene = create(w, 'scene', 24, 20); learn(w);
  move(w, scene, 80, start + 46000); tick(w, start + 46000); w.data.fishes[id].x = 50; tick(w, start + 47000);
  move(w, scene, 24, start + 48000); w.data.fishes[id].x = 20; tick(w, start + 48000);
  assert(!Object.values(w.data.life.stories).some(s => s.kind === 'revisit'));
  assert(Object.values(w.data.life.stories).some(s => s.kind === 'rediscover'));
  assert.equal(w.data.life.haunts[id].displaced, undefined);
});
