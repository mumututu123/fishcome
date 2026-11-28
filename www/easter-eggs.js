import { wrapX, worldKey } from './geography.js';
import { LIFE, pairKey } from './life.js';
import { CHAT_FLOOR, chatGlyphs, validChatMessage } from './chat.js';

const hash = text => { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.codePointAt(0), 16777619); return n >>> 0; };
export const hasFriendSecret = story => story.kind === 'reunion' && hash(`greeting:${story.id}`) % 3 === 0;
export function friendSignals(data, now) {
  const signals = [], used = new Set();
  const recent = Object.values(data.life?.stories || {}).filter(story => now >= story.at && now - story.at < 6000 && hasFriendSecret(story));
  for (const story of recent.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))) {
    const age = now - story.at, bond = data.life.bonds[pairKey(story.fish, story.other)];
    if (!bond || bond.seconds < LIFE.familiar || now - bond.lastNear > 2500 || used.has(story.fish) || used.has(story.other)) continue;
    const a = data.fishes[story.fish], b = data.fishes[story.other]; if (!a || !b) continue;
    used.add(a.id); used.add(b.id);
    const beat = Math.floor(age / 1500), letters = ['好', '久', '不', '见'];
    signals.push({ fish: beat % 2 ? b.id : a.id, ch: letters[beat], alpha: Math.min(1, (1500 - age % 1500) / 350) });
  }
  return signals;
}

export function memoryForCell(data, cellId) {
  const cell = data.chars[cellId], message = cell?.chat && data.chatSources?.[cell.chat];
  if (cell?.kind !== 'scene' || cell.entity !== CHAT_FLOOR || !validChatMessage(message) || !chatGlyphs(message.body.text).some(g => g.index === cell.chatIndex && g.ch === cell.ch)) return null;
  return { ch: cell.ch, nick: message.body.nick, at: message.body.t, text: message.body.text };
}

// Index matching body glyphs once per simulation update, including the wrap seam.
export function echoCells(data, characters = Object.values(data.chars)) {
  const memories = characters.filter(c => c.kind === 'scene' && c.entity === CHAT_FLOOR && c.chat);
  if (!memories.length) return new Set();
  const nearby = new Set();
  for (const cell of characters) if (cell.kind === 'fish') {
    const f = data.fishes[cell.entity]; if (!f) continue;
    const x = wrapX(f.x + f.facing * cell.x), y = f.y + cell.y;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) nearby.add(JSON.stringify([worldKey(x + dx, y + dy), cell.ch]));
  }
  const result = new Set();
  for (const cell of memories) {
    const scene = data.scenes[cell.entity]; if (scene && nearby.has(JSON.stringify([worldKey(scene.x + cell.x, scene.y + cell.y), cell.ch]))) result.add(cell.id);
  }
  return result;
}

// Follow the same cell through birth receipts, never merely matching equal letters.
export function ancestralGlyph(data, fishId) {
  const births = new Map(Object.values(data.breeding || {}).filter(r => r.status === 'born').map(r => [r.baby.id, r]));
  const birth = births.get(fishId); if (!birth) return null;
  const live = data.fishes[fishId] ? new Map(Object.values(data.chars).filter(c => c.kind === 'fish' && c.entity === fishId).map(c => [c.id, c])) : null;
  const found = [];
  for (const cell of birth.baby.cells) {
    if (live && live.get(cell.id)?.ch !== cell.after) continue;
    const history = data.chars[cell.id]?.path;
    // Missing archived paths cannot establish uninterrupted inheritance.
    if (!history) continue;
    let eventIndex = history.findLastIndex(e => e.reason === 'birth' && e.target === fishId), current = fishId, transfers = 0; const seen = new Set();
    if (live && eventIndex !== history.length - 1) continue;
    while (births.has(current) && !seen.has(current)) {
      seen.add(current);
      const r = births.get(current), inherited = r.baby.cells.find(c => c.id === cell.id), event = history[eventIndex--];
      if (!inherited || inherited.before !== cell.after || inherited.after !== cell.after || !r.baby.parents.includes(inherited.parent) || event?.reason !== 'birth' || event.birth !== r.id || event.target !== current || event.from !== inherited.parent || event.before !== cell.after || event.after !== cell.after) break;
      transfers++; current = inherited.parent;
    }
    if (transfers >= 3) found.push({ cell: cell.id, ch: cell.after, ancestor: current, generations: transfers + 1 });
  }
  return found.sort((a, b) => b.generations - a.generations || a.cell.localeCompare(b.cell))[0] || null;
}
export function ancestralText(glyph, name) {
  return glyph ? `祖传一个字 · 这个「${glyph.ch}」，从「${name(glyph.ancestor)}」传到了这里，已经走过 ${glyph.generations} 代鱼生。` : '';
}
