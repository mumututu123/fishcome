import { wrapX } from './geography.js';
import { eventPosition, radioLines } from './random-events.js';

const WHALE = [
  '        .~~~~~~~~~~~~~~~~~.       ',
  '    ___/····················\\___   ',
  '<==/··························· )  ',
  '   \\······················o··· /   ',
  '    `~~~~\\····___·····___.~~~~     ',
  '          `~~~   `~~~~             '
];
const BABY_WHALE = ['   .~~~~~~.   ', '<=/······o·)  ', '   `~~~~~~~   '];
const mirror = { '/': '\\', '\\': '/', '<': '>', '>': '<', '(': ')', ')': '(' };
function headPoint(data, id, characters) {
  const fish = data.fishes[id], cells = characters.filter(c => c.kind === 'fish' && c.entity === id); if (!fish || !cells.length) return null;
  const xs = cells.map(c => fish.facing * c.x);
  return { x: wrapX(fish.x + (Math.min(...xs) + Math.max(...xs)) / 2), y: fish.y + Math.min(...cells.map(c => c.y)) - 1.7 };
}
export function eventGlyphs(data, event, now, characters = Object.values(data.chars)) {
  if (!event || now < event.at || now >= event.started + event.duration) return [];
  const glyphs = [], age = (now - event.started) / 1000, position = eventPosition(event, now);
  const fade = Math.min(1, age / 1.5, (event.duration / 1000 - age) / 2);
  const add = (ch, x, y, color, alpha = 1, glow = false) => { if (ch !== ' ') glyphs.push({ ch, x: wrapX(x), y, color, alpha: Math.max(0, Math.min(1, alpha * fade)), glow }); };
  const caption = (text, p, color = '#d0e8de', alpha = .9) => {
    const chars = Array.from(text), width = Math.min(12, chars.length);
    chars.forEach((ch, i) => add(ch, p.x - width / 2 + i % 12, p.y + Math.floor(i / 12), color, alpha, true));
  };
  if (event.kind === 'whale') {
    const paint = (rows, p, alpha) => rows.forEach((row, y) => Array.from(row).forEach((ch, x) => add(event.direction > 0 ? mirror[ch] || ch : ch, p.x + (event.direction > 0 ? rows[0].length - 1 - x : x) - rows[0].length / 2, p.y + y, '#8cafb4', alpha)));
    paint(WHALE, position, .28);
    if (event.rare) paint(BABY_WHALE, { x: position.x - event.direction * 19, y: position.y + 8 }, .35);
  }
  if (event.kind === 'hiccup') {
    for (const [index, id] of event.plants.entries()) {
      const plant = data.chars[id]; if (plant?.kind !== 'seaweed') continue;
      for (let i = 0; i < 6; i++) { const rise = age - i * 1.2 - index * .25; if (rise >= 0 && rise < 9) add(i % 2 ? '咕' : '泡', plant.x + Math.sin(rise + index) * .5, plant.y - .8 - rise * 1.8, '#d5ecea', (1 - rise / 9) * .75); }
    }
    if (age > 8) add('嗝', position.x, position.y - 2 - (age - 8) * .65, '#def0de', Math.min(1, (22 - age) / 5), true);
  }
  if (event.kind === 'bottle') {
    ['[', '信', ']'].forEach((ch, i) => add(ch, position.x + i - 1, position.y, '#e5d7ac', 1, true));
    add('·', position.x, position.y - 1, '#c5dfd2', .7);
  }
  if (event.kind === 'meeting') {
    const living = event.fishes.filter(id => data.fishes[id]); if (living.length < 3) return [];
    if (age < 12) {
      const index = Math.min(living.length - 1, Math.floor(age / (12 / living.length))), p = headPoint(data, living[index], characters);
      if (p) add(index === living.length - 1 ? '？' : '嗯', p.x, p.y, '#e2e6c3', .95, true);
    } else { const p = headPoint(data, living[0], characters); if (p) caption('散会，没结论。', p, '#d7dec5'); }
  }
  if (event.kind === 'blossom') {
    for (const [index, id] of event.plants.entries()) {
      const plant = data.chars[id]; if (plant?.kind !== 'seaweed') continue;
      const opened = age - index * .55; if (opened < 0) continue;
      if (opened < 23) add('花', plant.x, plant.y - .9, index % 2 ? '#e6d6e7' : '#e9dfb7', Math.min(1, opened / 3) * (.7 + .2 * Math.sin(age * 1.4 + index)), true);
      else for (let i = 0; i < 3; i++) { const drift = opened - 23; add('·', plant.x + (i - 1) * drift * .25, plant.y - 1 - drift * .3, '#e1ead7', (1 - drift / 9) * .8, true); }
    }
  }
  if (event.kind === 'meteor') {
    for (let i = 7; i >= 0; i--) {
      if (age < i * .35) continue;
      const p = eventPosition(event, now - i * 350); add(i === 0 ? '✦' : i < 3 ? '＊' : '·', p.x, p.y, '#e3e8c9', 1 - i / 9, true);
    }
  }
  if (event.kind === 'radio') {
    const lines = radioLines(event), line = lines[Math.min(lines.length - 1, Math.floor(age / 7))];
    caption(line, { x: position.x, y: position.y - 4 }, '#b9ded8');
    add('≈', position.x - 8, position.y - 3, '#9fc7cf', .6 + .25 * Math.sin(age * 3));
    add('≈', position.x + 7, position.y - 3, '#9fc7cf', .6 - .25 * Math.sin(age * 3));
  }
  if (event.kind === 'parade') {
    const living = event.fishes.filter(id => data.fishes[id]); if (living.length < 3) return [];
    const p = headPoint(data, living[0], characters); if (p) caption(age < 6 ? '往这边游。' : '刚才的方向不算。', { x: p.x, y: p.y - 1 }, '#d9e6c9');
  }
  return glyphs;
}
