import { MAX_FLOOR, WORLD_WIDTH, wrapX } from './geography.js';

export const MINUTE = 60000, BUBBLE_SPEED = 1, BUBBLE_GROWTH = 25;
export const BUBBLE_GLYPH = '泡', BUBBLE_COLOR = '#ffffff';
// Appearance follows the existing birth ID, so reloads and peers see the same secret.
export function bubbleGlyph(bubble) {
  const roll = hash(`bubble-secret:${bubble.id}`) % 1000;
  return roll < 5 ? '？' : roll < 35 ? '咕' : roll < 65 ? '噜' : BUBBLE_GLYPH;
}
function hash(text) { let value = 2166136261; for (const ch of text) value = Math.imul(value ^ ch.codePointAt(0), 16777619); return value >>> 0; }
export const bubbleId = (source, minute) => `bubble:${source}:${minute}`;
export const bubbleChance = depth => Math.max(0, Math.min(100, 100 - depth)) / 100;
export function bubbleRoll(source, minute, depth) { return hash(`bubble-roll:${source}:${minute}`) % 10000 < Math.round(bubbleChance(depth) * 10000); }
export function bubbleState(bubble, now) {
  if (now < bubble.born) return null;
  const rise = (now - bubble.born) / 1000 * BUBBLE_SPEED, size = 1 + Math.floor(rise / BUBBLE_GROWTH), y = bubble.depth - rise - (size - 1);
  // The highest glyph reaches the surface first; remove the entire bubble.
  return y <= 0 ? null : { x: wrapX(bubble.x - Math.floor((size - 1) / 2)), y, size, rise };
}
export function validBubble(bubble, chars, checkHistory = true) {
  const source = chars?.[bubble?.source];
  return !!source?.wild && source.id === bubble.source && Number.isInteger(bubble.minute) && bubble.minute >= 0 && bubble.id === bubbleId(bubble.source, bubble.minute) && bubble.born === bubble.minute * MINUTE && source.created <= bubble.born - MINUTE && Number.isInteger(bubble.x) && bubble.x >= 0 && bubble.x < WORLD_WIDTH && Number.isInteger(bubble.depth) && bubble.depth >= 0 && bubble.depth <= MAX_FLOOR && bubbleRoll(bubble.source, bubble.minute, bubble.depth) && (!checkHistory || !(source.path || []).some(event => ['eat', 'uproot'].includes(event.reason) && event.t < bubble.born));
}
export function chooseBubble(left, right) { if (!left) return right; return JSON.stringify(left) <= JSON.stringify(right) ? left : right; }
export function mergeBubbles(left = {}, right = {}, now, chars) {
  const result = {};
  for (const bubble of [...Object.values(left), ...Object.values(right)]) if (bubbleState(bubble, now) && (!chars || validBubble(bubble, chars))) result[bubble.id] = structuredClone(chooseBubble(result[bubble.id], bubble));
  return result;
}
export function updateBubbles(world, now) {
  const data = world.data; data.bubbles ||= {};
  const current = Math.floor(now / MINUTE), prior = data.bubbleMinute ?? current;
  // Old, already surfaced bubbles need no offline catch-up or stored tombstones.
  const first = Math.max(prior + 1, Math.ceil((now - MAX_FLOOR / BUBBLE_SPEED * 1000) / MINUTE));
  const sources = first <= current ? [...world.charValues('seaweed')].sort((a, b) => a.id.localeCompare(b.id)) : [];
  for (let minute = first; minute <= current; minute++) for (const source of sources) {
    const born = minute * MINUTE;
    if (source.created > born - MINUTE || !bubbleRoll(source.id, minute, source.y)) continue;
    const id = bubbleId(source.id, minute), bubble = { id, source: source.id, minute, born, x: wrapX(source.x), depth: source.y };
    if (bubbleState(bubble, now)) { data.bubbles[id] = chooseBubble(data.bubbles[id], bubble); world.dirty = true; }
  }
  for (const [id, bubble] of Object.entries(data.bubbles)) if (!bubbleState(bubble, now)) { delete data.bubbles[id]; world.dirty = true; }
  data.bubbleMinute = Math.max(prior, current);
}
