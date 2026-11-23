import test from 'node:test';
import assert from 'node:assert/strict';
import { World, CONFIG, hash, MONUMENT } from '../www/engine.js';
import { CHAT_FLOOR, chatGlyphs, orderedChats, buildChatFloor, mergeChatRecords } from '../www/chat.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const at = Date.now() - 10000;
const message = (world, text, time = at) => ({ id: crypto.randomUUID(), kind: 'chat', actor: 'alice', body: { nick: 'a＊＊e', text, t: time, roots: [world.id] } });
function ended(text = '海底记忆') {
  const world = new World(at), chat = message(world, text); assert(world.addChat(chat).ok);
  const checkpoint = { world: world.serialize(), lastOnlineAt: at, at };
  return { chat, checkpoint, world: restoreCheckpoint(checkpoint, at + CONFIG.offlineLife).world };
}
test('聊天存档不裁掉200条以前的消息，同一消息及世界合流去重', () => {
  const a = new World(at), b = new World(at + 1), messages = Array.from({ length: 205 }, (_, index) => message(a, `聊天${index}`, at + index));
  for (const chat of messages) assert(a.addChat(chat).ok);
  assert.equal(a.addChat(messages[0]).duplicate, true);
  b.merge(a.serialize()); b.merge(a.serialize()); a.merge(b.serialize());
  assert.equal(Object.keys(a.data.chats).length, 205); assert.equal(Object.keys(b.data.chats).length, 205);
  const restored = restoreCheckpoint({ world: a.serialize(), at }, at + 1).world;
  assert.deepEqual(orderedChats(restored.data.chats).map(chat => chat.body.text), messages.map(chat => chat.body.text));
  assert.equal(a.wallet('alice'), 20);
});
test('聊天不能覆盖已保存内容，也不能发送到其他世界', () => {
  const world = new World(at), chat = message(world, '原文'); assert(world.addChat(chat).ok);
  assert.equal(world.addChat({ ...chat, body: { ...chat.body, text: '改文' } }).ok, false);
  assert.equal(new World(at).addChat(chat).ok, false);
  for (const text of [' ', '', 'a'.repeat(161)]) assert.equal(world.addChat(message(world, text)).ok, false);
});
test('同一世界的纪念卡副本合并补齐聊天，较新卡片不能丢掉旧副本独有消息', () => {
  const world = new World(at), first = message(world, '旧副本才有'), shared = message(world, '两边都有'), last = message(world, '新副本才有');
  const older = { [first.id]: first, [shared.id]: shared }, newer = { [shared.id]: shared, [last.id]: last };
  const merged = mergeChatRecords(older, newer); assert.equal(Object.keys(merged).length, 3); assert.equal(merged[first.id].body.text, '旧副本才有');
  assert.deepEqual(orderedChats(mergeChatRecords(newer, older)), orderedChats(merged));
  assert.throws(() => mergeChatRecords(older, { [shared.id]: { ...shared, body: { ...shared.body, text: '覆盖' } } }), /不可覆盖/);
});
test('拆分保留中文、ASCII、组合文字和完整表情，空白不占格', () => {
  assert.deepEqual(chatGlyphs('甲 A。🐟 e\u0301 👨‍👩‍👧‍👦\n').map(glyph => glyph.ch), ['甲', 'A', '。', '🐟', 'e\u0301', '👨‍👩‍👧‍👦']);
});
test('240小时到期后聊天形成海底地形，下一轮聊天室清空且不扣配额', () => {
  const { chat, world } = ended('甲 A。🐟 e\u0301 👨‍👩‍👧‍👦');
  assert.equal(Object.keys(world.data.chats).length, 0); assert.equal(Object.keys(world.data.chatSources).length, 1);
  const cells = world.sceneCells(CHAT_FLOOR); assert.equal(cells.length, 6);
  assert.deepEqual(cells.map(cell => cell.ch), chatGlyphs(chat.body.text).map(glyph => glyph.ch));
  assert(cells.every(cell => cell.y >= CONFIG.depth - 12 && cell.y < CONFIG.depth));
  assert.equal(new Set(cells.map(cell => `${cell.x},${cell.y}`)).size, 6);
  assert.equal(world.wallet('alice'), 20); assert.equal(world.data.scenes[CHAT_FLOOR].fixed, true);
});
test('同一轮的多个浏览器分别重开，沉积随机位置一致且合流不复制字符', () => {
  const { checkpoint, world } = ended('一句话，留在下一片海里');
  const other = restoreCheckpoint(checkpoint, at + CONFIG.offlineLife).world;
  assert.deepEqual(world.data.chars, other.data.chars);
  const count = world.counts().characters; world.merge(other.serialize()); world.reconcileGeometry();
  assert.equal(world.counts().characters, count);
});
test('聊天沉积协议拒绝编辑、移动、旋转、缩放和删除', () => {
  const { world } = ended('记忆'), before = world.serialize();
  for (const kind of ['sceneMove', 'sceneEdit', 'sceneRotate', 'sceneScale', 'sceneDelete']) {
    const result = world.apply({ id: crypto.randomUUID(), actor: 'alice', t: at, kind, scene: CHAT_FLOOR, x: 1, y: 1, ch: '改', color: '#ffffff', cell: world.sceneCells(CHAT_FLOOR)[0].id, factor: 2, cost: kind === 'sceneScale' ? 6 : 0 });
    assert.equal(result.ok, false); assert.match(result.error, /固化/);
  }
  assert.deepEqual(world.serialize(), before);
});
test('合流时海底记忆避开活鱼，鱼不会被移动或覆盖', () => {
  const { world } = ended('海底记忆'), cell = world.sceneCells(CHAT_FLOOR)[0], other = new World(at);
  const id = crypto.randomUUID(), x = Math.min(cell.x, CONFIG.width - 2), y = cell.y;
  assert(other.apply({ id, actor: 'bob', t: at, kind: 'fish', x, y, cost: 2, cells: [0, 1].map(dx => ({ x: dx, y: 0, ch: '口', color: '#8be7df' })) }).ok);
  world.merge(other.serialize()); world.reconcileGeometry();
  assert.equal(world.data.fishes[id].x, x); assert.equal(world.data.fishes[id].y, y);
  for (const point of world.fishMap().keys()) assert.equal(world.sceneryMap().has(point), false);
});
test('重新发现存活旧世界时纠正误判，撤掉错误沉积并恢复聊天', () => {
  const { checkpoint, world, chat } = ended(); world.merge(checkpoint.world); world.reconcileGeometry();
  assert.equal(world.sceneCells(CHAT_FLOOR).length, 0); assert.equal(Object.keys(world.data.chatSources).length, 0);
  assert.equal(world.data.chats[chat.id].body.text, chat.body.text);
});
test('空间不足保留来源和待沉积数量，后续有空间时仍能生成全部文字', () => {
  const original = new World(at), chat = message(original, '甲乙丙丁戊'), sources = { [chat.id]: chat };
  const full = buildChatFloor(sources, { width: 2, depth: 2 }, new Set(), hash);
  assert.equal(Object.keys(full.chars).length, 4); assert.equal(full.waiting, 1);
  const expanded = buildChatFloor(sources, { width: 3, depth: 2 }, new Set(), hash);
  assert.equal(Object.keys(expanded.chars).length, 5); assert.equal(expanded.waiting, 0);
  assert.equal(sources[chat.id].body.text, '甲乙丙丁戊');
});
test('下一轮没有新聊天时，不重复复活更早一轮的海底记忆', () => {
  const { world } = ended();
  const next = restoreCheckpoint({ world: world.serialize(), lastOnlineAt: at + CONFIG.offlineLife }, at + 2 * CONFIG.offlineLife).world;
  assert.equal(next.sceneCells(CHAT_FLOOR).length, 0); assert.equal(Object.keys(next.data.chatSources).length, 0);
});
test('密集海底聊天填满底层时，仍不遮盖纪念碑入口', () => {
  const previous = new World(at);
  for (let index = 0; index < 60; index++) assert(previous.addChat(message(previous, '字'.repeat(160), at + index)).ok);
  const world = restoreCheckpoint({ world: previous.serialize(), lastOnlineAt: at }, at + CONFIG.offlineLife).world;
  const width = Math.max(...MONUMENT.rows.map(row => Array.from(row).length));
  assert.equal(world.sceneCells(CHAT_FLOOR).length, 9600);
  assert.equal(world.sceneCells(CHAT_FLOOR).some(cell => cell.x >= MONUMENT.x && cell.x < MONUMENT.x + width && cell.y >= MONUMENT.y), false);
});
