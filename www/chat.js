export const CHAT_FLOOR = 'chat-floor';
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
export function chatGlyphs(text) {
  return [...segmenter.segment(text)].map(({ segment: ch }, index) => ({ ch, index })).filter(({ ch }) => !/^\s+$/u.test(ch) && !/[\p{Cc}\p{Cs}]/u.test(ch) && !/^[\p{Cf}\p{Mn}\p{Me}]+$/u.test(ch));
}
export function validChatMessage(message) {
  const body = message?.body;
  return message?.kind === 'chat' && /^[0-9a-f-]{36}$/i.test(message.id) && typeof message.actor === 'string' && !!message.actor && typeof body?.text === 'string' && body.text.length > 0 && body.text.length <= 160 && !!body.text.trim() && typeof body.nick === 'string' && body.nick.length <= 30 && Number.isFinite(body.t) && Array.isArray(body.roots) && body.roots.length > 0 && body.roots.every(root => /^[0-9a-f-]{36}$/i.test(root));
}
export function orderedChats(messages = {}) { return Object.values(messages).filter(validChatMessage).sort((a, b) => a.body.t - b.body.t || a.id.localeCompare(b.id)); }
export function mergeChatRecords(left = {}, right = {}) {
  const messages = {};
  for (const message of [...orderedChats(left), ...orderedChats(right)]) {
    if (messages[message.id] && JSON.stringify(messages[message.id]) !== JSON.stringify(message)) throw new Error('已有聊天记录不可覆盖');
    messages[message.id] = message;
  }
  return messages;
}
export function chatColor(seed) { return '#' + [0, 8, 16].map(shift => (128 + ((seed >>> shift) & 95)).toString(16)).join(''); }
export function chatCellId(message, index) { return `chat:${message.id}:${index}`; }
export function buildChatFloor(messages, { width, depth, floorAt = () => depth }, occupied, hash) {
  const chars = {}, rows = new Map(); let waiting = 0;
  const row = level => {
    if (!rows.has(level)) rows.set(level, Array.from({ length: width }, (_, x) => x).filter(x => floorAt(x) - 1 - level >= 0 && !occupied.has(`${x},${floorAt(x) - 1 - level}`)));
    return rows.get(level);
  };
  for (const message of orderedChats(messages)) for (const { ch, index } of chatGlyphs(message.body.text)) {
    const id = chatCellId(message, index), preferred = hash(id + ':depth') % Math.min(12, depth);
    let level = preferred, columns = row(level);
    for (let offset = 1; !columns.length && offset < depth; offset++) { level = (preferred + offset) % depth; columns = row(level); }
    if (!columns.length) { waiting++; continue; }
    const choice = hash(id) % columns.length, x = columns[choice]; columns[choice] = columns.at(-1); columns.pop();
    chars[id] = { id, payer: '', ch, color: chatColor(hash(message.actor)), kind: 'scene', entity: CHAT_FLOOR, x, y: floorAt(x) - 1 - level, path: [], created: message.body.t, chat: message.id, chatIndex: index };
  }
  return { chars, waiting };
}
