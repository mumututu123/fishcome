import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSwimMotion, swimPose } from '../www/swim-visual.js';

const sample = (x = 10, cx = 0, facing = 1) => ({ x, y: 20, cx, cy: 0, facing });

test('实际位移与待执行移动平滑激活游动动作，停止后逐渐收敛', () => {
  let moving = advanceSwimMotion(null, sample(), 0), idle = moving;
  for (let i = 1; i <= 20; i++) {
    moving = advanceSwimMotion(moving, sample(10 + Math.floor(i / 10), i % 10 / 10), i / 10);
    idle = advanceSwimMotion(idle, sample(), i / 10);
  }
  assert(moving.activity > .75); assert.equal(idle.activity, 0);
  for (let i = 21; i <= 65; i++) moving = advanceSwimMotion(moving, sample(12), i / 10);
  assert(moving.activity < .001);
});

test('换向产生短暂弹性缓冲，跨海域接缝不会被误判为巨大位移', () => {
  const old = Object.freeze(advanceSwimMotion(null, sample(999.5), 0));
  const next = Object.freeze(sample(.5)); const wrapped = advanceSwimMotion(old, next, .1);
  assert.equal(wrapped.dx, 1); assert.equal(old.x, 999.5); assert.equal(next.x, .5);
  const turned = advanceSwimMotion(old, sample(999.5, 0, -1), .1);
  assert.equal(turned.activity, 0); assert.equal(turned.turn, 1);
  const pose = swimPose(turned, 0, 0, 0, { minX: 0, maxX: 4, minY: 0, maxY: 0 }, -1);
  assert(pose.scaleX < 1 && pose.scaleY > 1);
});

test('后半段摆动更明显，竖向鱼横向摆身，偏移仍保留可靠的单元格点击中心', () => {
  const shape = { minX: 0, maxX: 4, minY: 0, maxY: 4 }; let headSum = 0, tailSum = 0;
  for (let i = 0; i < 200; i++) {
    const state = { activity: 1, turn: 0, swimTime: i / 10, dx: 1, dy: 0 };
    const head = swimPose(state, .5, 4, 0, shape), tail = swimPose(state, .5, 0, 0, shape);
    headSum += Math.abs(head.offsetY); tailSum += Math.abs(tail.offsetY);
    assert(Math.abs(tail.offsetY) <= .08 && Math.abs(tail.offsetX) <= .01);
    assert(Math.hypot(tail.offsetX, tail.offsetY) < .43);
    const vertical = swimPose({ ...state, dx: 0, dy: -1 }, .5, 0, 4, shape);
    assert(Math.abs(vertical.offsetX) <= .08 && Math.abs(vertical.offsetY) <= .01);
    assert.deepEqual(swimPose(state, .5, 4, 4, shape, 1, true), { offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  }
  assert(tailSum > headSum * 2);
});
