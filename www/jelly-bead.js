import { beadTint } from './bead-visual.js';

const TAU = Math.PI * 2;
const translucent = (color, target, mix, alpha) => beadTint(color, target, mix).replace('rgb(', 'rgba(').replace(')', `,${alpha})`);

export function jellyPhase(id = '') {
  let hash = 2166136261;
  for (const ch of String(id)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return (hash >>> 0) / 4294967296 * TAU;
}

export function jellyPose(time = 0, phase = 0, x = 0, y = 0, facing = 1, reduced = false) {
  if (reduced) return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, rotation: 0, sheen: .2 };
  const clock = Number.isFinite(time) ? time : 0;
  const wave = Math.sin(clock * 2.65 + phase - x * .62 + y * .13);
  const breath = Math.sin(clock * 1.3 + phase) * .009;
  return {
    scaleX: 1 + wave * .035 + breath,
    scaleY: 1 - wave * .03 - breath,
    offsetX: Math.sin(clock * 2.1 + phase - x * .62) * .008 * facing,
    offsetY: wave * .018,
    rotation: wave * .022 * facing,
    sheen: .2 + .08 * Math.sin(clock * .85 + phase - x * .14),
  };
}

// Translucent color, transmitted light and soft specular highlights, without a hard inset rim.
export function drawJellyBody(ctx, color, left, top, size, glow = false) {
  const x = left + size / 2, y = top + size / 2, r = size * .43;
  ctx.save();
  if (glow) {
    ctx.fillStyle = translucent(color, [210, 250, 255], .25, .16); ctx.shadowColor = color; ctx.shadowBlur = size * .17;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.shadowColor = 'rgba(0,18,32,.25)'; ctx.shadowBlur = size * .1; ctx.shadowOffsetX = size * .018; ctx.shadowOffsetY = size * .035;
  const body = ctx.createRadialGradient(x - size * .15, y - size * .18, size * .025, x, y, r);
  body.addColorStop(0, translucent(color, [230, 252, 255], .35, .52));
  body.addColorStop(.35, translucent(color, [170, 226, 245], .12, .30));
  body.addColorStop(.75, translucent(color, [70, 145, 180], .08, .27));
  body.addColorStop(1, translucent(color, [10, 55, 80], .32, .60));
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = translucent(color, [205, 248, 255], .35, .22);
  ctx.beginPath(); ctx.ellipse(x + size * .06, y + size * .22, size * .28, size * .09, -.24, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(226,255,255,.38)'; ctx.lineWidth = Math.max(.6, size * .018);
  ctx.beginPath(); ctx.arc(x, y, r - size * .012, Math.PI * 1.05, Math.PI * 1.78); ctx.stroke();
  ctx.strokeStyle = translucent(color, [210, 255, 250], .4, .3);
  ctx.beginPath(); ctx.arc(x, y, r - size * .025, Math.PI * .07, Math.PI * .67); ctx.stroke();
  ctx.fillStyle = 'rgba(239,255,255,.55)'; ctx.shadowColor = 'rgba(223,255,255,.4)'; ctx.shadowBlur = size * .05;
  ctx.beginPath(); ctx.ellipse(x - size * .20, y - size * .25, size * .10, size * .035, -.45, 0, TAU); ctx.fill();
  ctx.restore();
}

export function drawJellyInk(ctx, ch, color, left, top, size) {
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${Math.max(3, size * .52)}px 'Microsoft YaHei',Consolas,monospace`;
  ctx.strokeStyle = 'rgba(5,34,53,.8)'; ctx.lineWidth = Math.max(.5, size * .035); ctx.lineJoin = 'round';
  ctx.strokeText(ch, left + size / 2, top + size / 2, size * .56);
  ctx.fillStyle = beadTint(color, [231, 252, 255], .2); ctx.fillText(ch, left + size / 2, top + size / 2, size * .56); ctx.restore();
}

export function drawJellySheen(ctx, left, top, size) {
  const x = left + size / 2, y = top + size / 2;
  ctx.save();
  const light = ctx.createRadialGradient(x - size * .18, y - size * .25, 0, x - size * .12, y - size * .17, size * .29);
  light.addColorStop(0, 'rgba(240,255,255,.8)'); light.addColorStop(.5, 'rgba(195,240,255,.2)'); light.addColorStop(1, 'rgba(195,240,255,0)');
  ctx.fillStyle = light; ctx.beginPath(); ctx.arc(x, y, size * .40, 0, TAU); ctx.fill(); ctx.restore();
}
