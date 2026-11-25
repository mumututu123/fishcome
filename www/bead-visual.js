function beadTint(color, target, amount) {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '83aab9';
  const rgb = [0, 2, 4].map((offset, i) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount) + target[i] * amount));
  return `rgb(${rgb.join(',')})`;
}

// Shared by the creator and cached 3D sea sprites. Coordinates describe one cell.
export function drawBeadGlyph(ctx, ch, color, left, top, s, glow = false) {
  const x = left + s / 2, y = top + s / 2, radius = s * .43;
  ctx.save();
  ctx.font = `${s * .52}px 'Microsoft YaHei',Consolas,monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (glow) {
    const alpha = ctx.globalAlpha; ctx.globalAlpha = alpha * .2; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = s * .17;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = alpha;
  }
  // A shallow sidewall and a soft contact shadow keep the bead on the board.
  ctx.shadowColor = 'rgba(0,8,16,.5)'; ctx.shadowBlur = s * .14; ctx.shadowOffsetX = s * .035; ctx.shadowOffsetY = s * .065;
  const side = ctx.createLinearGradient(x, y - radius, x, y + radius);
  side.addColorStop(0, beadTint(color, [14, 34, 46], .72)); side.addColorStop(1, beadTint(color, [3, 15, 24], .82));
  ctx.fillStyle = side; ctx.beginPath(); ctx.arc(x, y + s * .045, radius, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  const face = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  face.addColorStop(0, beadTint(color, [215, 240, 245], .27));
  face.addColorStop(.4, beadTint(color, [18, 47, 62], .50));
  face.addColorStop(1, beadTint(color, [6, 25, 38], .75));
  ctx.fillStyle = face; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(235,255,255,.28)'; ctx.lineWidth = Math.max(.65, s * .025);
  ctx.beginPath(); ctx.arc(x, y, radius - s * .018, Math.PI * 1.08, Math.PI * 1.78); ctx.stroke();
  // A quiet inset face gives the glyph its own space, away from the rim.
  const inset = ctx.createRadialGradient(x, y, s * .12, x, y, s * .35);
  inset.addColorStop(0, '#0d2c3d'); inset.addColorStop(.72, '#103244'); inset.addColorStop(1, 'rgba(16,50,68,0)');
  ctx.fillStyle = inset; ctx.beginPath(); ctx.arc(x, y, s * .35, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.fillText(ch, x, y, s * .56);
  ctx.restore();
}
