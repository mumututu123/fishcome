import test from 'node:test';
import assert from 'node:assert/strict';
import { jellyPhase, jellyPose } from '../www/jelly-bead.js';

test('果冻动画按鱼的身份保持节奏，相邻颗粒有连续相位延迟', () => {
  const phase = jellyPhase('fish-a');
  assert.equal(phase, jellyPhase('fish-a')); assert.notEqual(phase, jellyPhase('fish-b'));
  const a = jellyPose(1, phase, 0, 0), again = jellyPose(1, phase, 0, 0), next = jellyPose(1, phase, 1, 0);
  assert.deepEqual(a, again); assert.notDeepEqual(a, jellyPose(1.4, phase, 0, 0)); assert.notDeepEqual(a, next);
  assert(Math.abs(a.offsetY - next.offsetY) < .012);
});

test('弹性变化和位移受到限制，鱼元中心及原单元格仍可可靠点击', () => {
  for (let step = 0; step < 300; step++) for (const facing of [-1, 1]) {
    const p = jellyPose(step / 10, jellyPhase('fish-a'), step % 15, step % 7, facing);
    assert(p.scaleX >= .956 && p.scaleX <= 1.044); assert(p.scaleY >= .961 && p.scaleY <= 1.039);
    assert(Math.abs(p.offsetX) <= .008 && Math.abs(p.offsetY) <= .018 && Math.abs(p.rotation) <= .022);
    assert(.43 * Math.max(p.scaleX, p.scaleY) + Math.hypot(p.offsetX, p.offsetY) < .5);
    assert(p.sheen >= .12 && p.sheen <= .28);
  }
});

test('减少动态效果偏好下颗粒保持静止，异常动画时间不会产生无效坐标', () => {
  const a = jellyPose(0, jellyPhase('fish-a'), 0, 0, 1, true), b = jellyPose(999, jellyPhase('fish-b'), 9, 8, -1, true);
  assert.deepEqual(a, b); assert.equal(a.offsetX, 0); assert.equal(a.offsetY, 0); assert.equal(a.scaleX, 1); assert.equal(a.scaleY, 1);
  assert.deepEqual(jellyPose(NaN), jellyPose(0));
});
