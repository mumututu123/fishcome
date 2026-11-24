import test from 'node:test';
import assert from 'node:assert/strict';
import { World, hash } from './empty-world.mjs';
import { HOUR, GREENS, growthRoll, weedId, validWildCell } from '../www/seaweed.js';
import { MINUTE, bubbleChance, bubbleRoll, bubbleId, bubbleState, validBubble, updateBubbles } from '../www/bubbles.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const minute = Math.floor(Date.now() / MINUTE), at = minute * MINUTE;
function grass(world, x, matches = minute) {
  const source = `floor:${x}`, depth = world.floorAt(x) - 1; let hour = Math.floor(at / HOUR) - 100000, id;
  do { hour++; id = weedId(source, hour, hash); } while (!growthRoll(source, hour, hash) || !bubbleRoll(id, matches, depth));
  const cell = { id, kind: 'seaweed', entity: id, payer: '', ch: '草', color: GREENS[hash(id) % GREENS.length], x, y: depth, created: hour * HOUR, path: [], wild: { source, hour, plant: id, index: 0, x, y: depth } }; assert(validWildCell(cell, { width: 1000, depth: 101 }, hash)); world.data.chars[id] = cell; return cell;
}
function emitted(world, source) { world.data.bubbleMinute = minute - 1; updateBubbles(world, at + 1); return world.data.bubbles[bubbleId(source.id, minute)]; }

test('海草每字符每分钟的概率为100%减去水深百分比，浅水更多、100格为零', () => {
  assert.equal(bubbleChance(0), 1); assert.equal(bubbleChance(80), .2); assert.equal(bubbleChance(100), 0);
  let successes = 0; for (let i = 0; i < 100000; i++) { assert(bubbleRoll(`plant:${i}`, minute, 0)); assert.equal(bubbleRoll(`plant:${i}`, minute, 100), false); if (bubbleRoll(`plant:${i}`, minute, 80)) successes++; }
  assert(successes > 18000 && successes < 22000, `20% rate: ${successes / 100000}`);
});
test('每个海草字符独立发泡，分钟内不重复抽签或随海草移动，配额不变', () => {
  const world = new World(at), a = grass(world, 40), b = grass(world, 41); world.data.bubbleMinute = minute - 1; updateBubbles(world, at + 1);
  assert.equal(Object.keys(world.data.bubbles).length, 2); assert(validBubble(world.data.bubbles[bubbleId(a.id, minute)], world.data.chars)); const bornX = world.data.bubbles[bubbleId(a.id, minute)].x;
  a.x++; for (let i = 1; i < 20; i++) updateBubbles(world, at + i * 500); assert.equal(Object.keys(world.data.bubbles).length, 2); assert.equal(world.data.bubbles[bubbleId(a.id, minute)].x, bornX); assert.equal(world.wallet('alice'), 20);
  const expected = 2 + [a, b].filter(cell => bubbleRoll(cell.id, minute + 1, cell.y)).length; updateBubbles(world, at + MINUTE + 1); assert.equal(Object.keys(world.data.bubbles).length, expected);
});
test('上浮每25格扩大一档，1×1到4×4并支持左右接缝', () => {
  const bubble = { born: at, x: 999, depth: 96 };
  assert.equal(bubbleState(bubble, at).size, 1); assert.equal(bubbleState(bubble, at + 24999).size, 1);
  for (const [seconds, size] of [[25, 2], [50, 3], [75, 4]]) { const state = bubbleState(bubble, at + seconds * 1000); assert.equal(state.size, size); assert.equal(state.rise, seconds); assert.equal(state.y, 96 - seconds - (size - 1)); assert(state.x >= 0 && state.x < 1000); }
});
test('任一字符触及海面时整体消失，不留下残片或到期后复活', () => {
  const bubble = { born: at, x: 40, depth: 96 }; assert(bubbleState(bubble, at + 92999)); assert.equal(bubbleState(bubble, at + 93000), null); assert.equal(bubbleState(bubble, at + 200000), null); assert.equal(bubbleState({ ...bubble, depth: 0 }, at), null);
});
test('气泡无占格，不阻挡鱼或造景、不作为食物，也不加入消费字符', () => {
  const world = new World(at), source = grass(world, 40), bubble = emitted(world, source); world.data.tick = at + 30000;
  const state = bubbleState(bubble, world.data.tick), cells = [{ x: 0, y: 0, ch: 'o', color: '#88aacc' }, { x: 1, y: 0, ch: 'Q', color: '#88aacc' }], id = crypto.randomUUID();
  assert(world.apply({ id, actor: 'alice', t: at, kind: 'fish', x: state.x, y: Math.floor(state.y), cells, cost: 2 }).ok); assert.equal(world.fishStatus(id, world.data.tick).meals24, 0); assert.equal(world.wallet('alice'), 18);
  assert(world.canOccupy({ ...world.data.fishes[id], x: state.x + 1 }, cells)); assert.equal(world.counts().characters, 3);
  const scenery = new World(at), root = grass(scenery, 40), gas = emitted(scenery, root), position = bubbleState(gas, at + 30000); assert(scenery.apply({ id: crypto.randomUUID(), actor: 'alice', t: at, kind: 'scene', x: position.x, y: Math.floor(position.y), cells, cost: 2 }).ok);
});
test('海草被吃或脱落后不再生成气泡，已经产生的气泡继续上浮', () => {
  const world = new World(at), source = grass(world, 40), bubble = emitted(world, source); source.kind = 'food'; source.path.push({ reason: 'uproot', t: at + 10000 }); updateBubbles(world, at + MINUTE + 1);
  assert.equal(Object.keys(world.data.bubbles).length, 1); assert(validBubble(bubble, world.data.chars)); assert.equal(world.data.bubbleMinute, minute + 1);
});
test('存档、重复合流及协调者接替去重，过期快照不复活已消失气泡', () => {
  const world = new World(at), source = grass(world, 40); emitted(world, source); const before = world.serialize();
  const restored = restoreCheckpoint({ world: before, lastOnlineAt: at }, at + 10000).world; assert.equal(Object.keys(restored.data.bubbles).length, 1); restored.merge(before); restored.merge(before); assert.equal(Object.keys(restored.data.bubbles).length, 1);
  restored.data.tick = at + 200000; restored.merge(before); assert.equal(Object.keys(restored.data.bubbles).length, 0);
  const expired = restoreCheckpoint({ world: before, lastOnlineAt: at }, at + 240 * HOUR); assert(expired.expired); assert.equal(Object.keys(expired.world.data.bubbles).length, 0);
});
test('无效来源、概率、深度和出生标识拒绝，旧存档不补发历史气泡', () => {
  const world = new World(at), source = grass(world, 40), bubble = emitted(world, source);
  for (const changes of [{ source: 'missing' }, { minute: minute + 1 }, { born: at + 1 }, { depth: 101 }, { x: -1 }, { id: 'fake' }]) assert.equal(validBubble({ ...bubble, ...changes }, world.data.chars), false);
  const legacy = world.serialize(); delete legacy.bubbles; delete legacy.bubbleMinute; const restored = restoreCheckpoint({ world: legacy, lastOnlineAt: at }, at + 5000).world; updateBubbles(restored, at + 5000); assert.equal(Object.keys(restored.data.bubbles).length, 0);
});
test('分区中海草先被吃或脱落时，合流清除之后才产生的气泡而不阻断世界合流', () => {
  const world = new World(at), source = grass(world, 40, minute + 1), fork = new World(at); fork.data = world.serialize();
  source.kind = 'food'; source.path.push({ reason: 'uproot', t: at + 10000 }); world.data.tick = at + MINUTE + 1;
  updateBubbles(fork, at + MINUTE + 1); fork.data.tick = at + MINUTE + 1; const bubble = fork.data.bubbles[bubbleId(source.id, minute + 1)]; assert(bubble);
  assert(validBubble(bubble, world.data.chars, false)); assert.equal(validBubble(bubble, world.data.chars), false);
  world.merge(fork.serialize()); assert.equal(world.data.chars[source.id].kind, 'food'); assert.equal(Object.keys(world.data.bubbles).length, 0);
});
