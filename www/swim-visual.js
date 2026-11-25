import { deltaX } from './geography.js';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Observe the simulation without changing its positions, clocks or movement budget.
export function advanceSwimMotion(previous, sample, time) {
  const now = Number.isFinite(time) ? time : previous?.time || 0;
  if (!previous || now < previous.time) return { ...sample, time: now, lastMotion: now - 10, drive: 0, activity: 0, turn: 0, swimTime: 0, dx: sample.facing || 1, dy: 0 };
  const dt = clamp(now - previous.time, 0, .1);
  const dx = deltaX(sample.x, previous.x), dy = sample.y - previous.y;
  const moved = Math.hypot(dx, dy) > .001;
  const pending = sample.cx > previous.cx + .001 || sample.cy > previous.cy + .001;
  const lastMotion = moved || pending ? now : previous.lastMotion;
  const drive = moved ? 1 : pending ? .85 : previous.drive;
  const target = drive * clamp(1 - (now - lastMotion - .55) / .9, 0, 1);
  const activity = previous.activity + (target - previous.activity) * (1 - Math.exp(-dt * 6));
  return {
    ...sample, time: now, lastMotion, drive, activity,
    turn: sample.facing !== previous.facing ? 1 : previous.turn * Math.exp(-dt * 6),
    swimTime: previous.swimTime + dt * (.8 + .25 * activity),
    dx: moved ? dx : previous.dx, dy: moved ? dy : previous.dy,
  };
}

export function swimPose(state, phase, x, y, shape, facing = 1, reduced = false) {
  const still = { offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  if (!state || !shape || reduced) return still;
  const height = shape.maxY - shape.minY, width = shape.maxX - shape.minX;
  const vertical = height > 0 && height >= width * .75 && Math.abs(state.dy) > Math.abs(state.dx) * 1.2;
  const span = vertical ? shape.maxY - shape.minY : shape.maxX - shape.minX;
  const tail = span > 0 ? clamp(vertical ? state.dy < 0 ? (y - shape.minY) / span : (shape.maxY - y) / span : (shape.maxX - x) / span, 0, 1) : .5;
  const clock = state.swimTime * 3.15 + phase, wave = Math.sin(clock - tail * 2.6);
  const bend = clamp((wave * (.012 + .063 * tail * tail) + Math.sin(clock * .5) * .01) * state.activity, -.08, .08);
  const thrust = Math.sin(clock) * .01 * state.activity;
  return {
    offsetX: vertical ? bend : thrust * facing,
    offsetY: vertical ? thrust * Math.sign(state.dy) : bend,
    rotation: wave * .045 * state.activity * facing,
    scaleX: 1 - state.turn * .025,
    scaleY: 1 + state.turn * .02,
  };
}
