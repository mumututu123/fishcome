import test from 'node:test';
import assert from 'node:assert/strict';
import { schoolMembership } from '../www/fish-school.js';

test('单鱼查询与全海依次组队一致，保留单向可见、繁殖占用、后来招募和不同查询顺序', () => {
  for (const count of [48, 640]) {
    const points = Array.from({ length: count }, (_, slot) => ({ id: String(slot), slot }));
    const next = [], possible = points.map(p => [p.slot]);
    const eligible = p => p.slot % 11 !== 2;
    for (const p of points) {
      next[p.slot] = [31, -6, 7, -1, 3, -15].map(offset => points[(count + p.slot + offset) % count]);
      for (const q of next[p.slot]) possible[q.slot].push(p.slot);
    }
    for (const leaders of possible) leaders.sort((a, b) => a - b);
    const full = new Map();
    for (const p of points) {
      if (!eligible(p) || full.has(p.id)) continue;
      const companions = next[p.slot].filter(q => eligible(q) && !full.has(q.id)).slice(0, 4);
      if (companions.length < 2) continue;
      for (const q of [p, ...companions]) full.set(q.id, p.id);
    }
    const member = schoolMembership(points, p => possible[p.slot], p => next[p.slot], eligible, p => p.id, () => full);
    for (const p of [...points].reverse()) assert.equal(member(p), full.get(p.id));
  }
});
