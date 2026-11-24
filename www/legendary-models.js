// Shared by the game, collision sweeps and the character animation preview.
export const LEGEND_MODELS = Object.freeze({
  cthulhu: [
    '   克     克   ', '   克克   克克   ', '    克苏苏苏克    ',
    '   克苏苏苏苏苏克   ', '   克苏鲁苏鲁苏克   ', '    苏苏苏苏苏    ',
    '    苏鲁鲁鲁苏    ', '   苏苏鲁克鲁苏苏   ', '  克苏苏克克克苏苏克  ',
    '   克苏苏克苏苏克   ', '    鲁苏苏苏鲁    ', '     鲁克鲁     '
  ],
  godzilla: [
    '          哥哥哥    ', '        哥哥斯斯哥哥  ', '       哥斯斯斯拉斯哥 ',
    '       哥斯拉拉斯斯哥 ', '        哥斯斯斯斯哥  ', '      拉哥斯斯哥哥   ',
    '     拉哥斯斯斯哥    ', '    拉哥斯斯斯斯哥   ', '   拉哥斯斯斯斯斯哥  ',
    '  拉哥斯斯斯斯斯斯哥 ', '   哥斯斯斯斯斯斯哥  ', '  拉哥斯斯斯斯斯哥   ',
    '  哥斯斯斯斯斯斯哥   ', ' 拉哥斯斯斯斯斯斯哥  ', ' 哥斯斯斯斯斯斯斯哥  ',
    '拉斯斯斯斯哥斯斯斯哥 ', '拉斯斯斯哥 哥斯斯哥 ', '拉拉拉哥  哥斯斯哥 ',
    '        哥斯哥斯哥 ', '       哥哥哥哥哥哥 '
  ],
  ship: [
    '         灵         ', '         灵幽        ', '       幽灵幽幽       ',
    '      幽幽灵 幽幽      ', '     幽幽 灵幽 幽幽     ', '    幽幽  灵 幽 幽幽    ',
    '         灵         ', ' 船船幽幽船船灵船船 幽船船 ',
    '  船幽幽船 船幽幽船船幽船  ', '   船船 幽船船船 幽船船   ', '    船船船船船船船船船    '
  ]
});
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function modelCells(kind) {
  const rows = LEGEND_MODELS[kind], width = Math.max(...rows.map(r => Array.from(r).length));
  const cells = [];
  rows.forEach((row, y) => Array.from(row).forEach((ch, x) => { if (ch !== ' ') cells.push({ index: cells.length, x: x - Math.floor(width / 2), y: y - rows.length + 1, ch, role: 'body' }); }));
  return cells;
}
function curve(a, b, c, d, t) { const u = 1 - t; return { x: u ** 3 * a.x + 3 * u ** 2 * t * b.x + 3 * u * t ** 2 * c.x + t ** 3 * d.x, y: u ** 3 * a.y + 3 * u ** 2 * t * b.y + 3 * u * t ** 2 * c.y + t ** 3 * d.y }; }
export function tentacleCells(age, bindings = {}) {
  const cells = [];
  for (let arm = 0; arm < 8; arm++) {
    const side = arm < 4 ? -1 : 1, rank = arm % 4, phase = age * .45 + arm * .9;
    const a = { x: side * 3, y: -5 - rank * 1.1 };
    const tip = bindings[arm] ? { ...bindings[arm] } : { x: side * (10 + rank + Math.sin(phase) * 1.5), y: -11 + rank * 3.3 + Math.cos(phase) * 1.5 };
    if (!bindings[arm] && age > 570) { const reach = 1 - clamp((age - 570) / 30, 0, 1) * .75; tip.x = a.x + (tip.x - a.x) * reach; tip.y = a.y + (tip.y - a.y) * reach; }
    const b = { x: side * (5 + rank * .7), y: a.y - 3 - Math.sin(phase) };
    const c = { x: tip.x - side * 3, y: tip.y + Math.cos(phase + 1) * 3 };
    const seen = new Set();
    for (let i = 0; i <= 64; i++) { const p = curve(a, b, c, tip, i / 64), x = Math.round(p.x), y = Math.round(p.y), key = `${x},${y}`; if (seen.has(key)) continue; seen.add(key); cells.push({ x, y, ch: ['克', '苏', '鲁'][(i + arm) % 3], role: 'arm', arm }); }
    if (bindings[arm]) for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) cells.push({ x: Math.round(tip.x + dx), y: Math.round(tip.y + dy), ch: rank % 2 ? '苏' : '鲁', role: 'binding', arm });
  }
  return cells;
}
export function atomicPhase(age) {
  const elapsed = age - 20, attack = Math.floor(elapsed / 60), phase = elapsed - attack * 60;
  return { attack, phase, charging: elapsed >= 0 && phase < 8, firing: elapsed >= 0 && phase >= 8 && phase < 12, length: clamp((phase - 8) * 12 + 1, 0, 30) };
}
export function atomicCells(age, direction = 1, upward = false) {
  const state = atomicPhase(age); if (!state.firing) return [];
  const cells = [], dy = upward ? -1 : 0;
  for (let d = 0; d < Math.ceil(state.length); d++) for (let width = 0; width < 2; width++) cells.push({ x: direction * (8 + d), y: -17 + dy * d + width, ch: Array.from('原子吐息')[(d + width) % 4], role: 'beam', attack: state.attack });
  return cells;
}
export function legendaryModel(kind, age, { direction = 1, upward = false, bindings = {}, missing = [] } = {}) {
  const blocked = new Set(missing), cells = modelCells(kind).filter(c => !blocked.has(c.index));
  if (kind === 'cthulhu') return [...cells, ...tentacleCells(age, bindings)];
  if (kind === 'godzilla') {
    const phase = atomicPhase(age);
    const spines = cells.filter(c => c.ch === '拉'), lit = phase.firing ? spines.length : phase.charging ? Math.ceil(spines.length * phase.phase / 8) : 0;
    for (const c of cells) { c.x *= direction; if (c.ch === '拉' && spines.indexOf(c) < lit) c.role = 'charge'; }
    return [...cells, ...atomicCells(age, direction, upward)];
  }
  return cells.map(c => ({ ...c, y: c.y + Math.sin(age * .5) * .2 }));
}
