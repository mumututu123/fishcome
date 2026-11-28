import assert from 'node:assert/strict';
import test from 'node:test';
import { readPresentations, frameSummary, bothDisplays, scheduledSteps } from './browser-refresh-budget.cjs';

test('从实际呈现的同一鱼元坐标核实游动，切换可见鱼元不会伪造运动', () => {
  const frames = [
    ['甲', 1, 3], ['乙', 1, 3], ['乙', 1, 3, '丙', 8, 9], ['丙', 8, 9, '乙', 1.125, 3]
  ].map((poses, sequence) => ({ sequence, at: sequence * 10, poses }));
  const events = frames.flatMap(({ sequence: id }) => {
    const at = id * 10000;
    return [
      { name: 'AnimationFrame', ph: 'b', ts: at, args: { id } },
      ...['start', 'end'].map((phase, i) => ({
        name: `tide.refresh.A.${id}.${phase}`, ts: at + i + 1, args: { data: { callTime: at + i + 1 } }
      })),
      { name: 'AnimationFrame', ph: 'e', ts: at + 3, args: { id } },
      { name: 'AnimationFrame::Presentation', ts: at + 4, args: { id } }
    ].map(event => ({ ...event, pid: 1, tid: 2 }));
  });
  // A scheduling delay inside the mark widens just that observation.
  frames[2].beforeMark = frames[2].at;
  frames[2].at += 2;
  frames[2].afterMark = frames[2].at;
  const { rows, moving, clockOffsets } = readPresentations(events, { frames, page: 'A' }, 0, 40);
  assert.ok(clockOffsets[0] < 0 && clockOffsets[1] > 0 && clockOffsets[1] - clockOffsets[0] <= .201);
  assert.equal(rows.length, 4);
  assert.deepEqual(moving.map(frame => frame.sequence), [3]);
  frames[2].beforeMark = frames[2].at;
  assert.equal(readPresentations(events, { frames, page: 'A' }, 0, 40).clockOffsets, undefined);
});

test('按海洋的半秒时钟计数，采样首尾从未请求的步也算缺失', () => {
  const shown = { host: { presented: 12 }, peer: { presented: 15 } };
  const requests = [{ tick: 143, display: shown }, { tick: 1143, display: { host: shown.host } },
    { tick: 1643 }, { tick: 1643, display: shown }, { tick: 2643, display: shown }];
  assert.deepEqual(scheduledSteps(requests, 143, 500, 200, 2643), {
    expected: 4, unrequested: [643, 2143], unpresented: [643, 1143, 2143]
  });
});

test('刷新间隔包含跨过采样开始或结束时刻的长帧', () => {
  const frames = [84, 117, 134, 191].map(at => ({ at, draw: 2 }));
  const measured = frameSummary({ frames, steps: [] }, null, 100, 150);
  assert.deepEqual(measured.frames, {
    n: 3, min: 17, median: 33, p95: 57, p99: 57, max: 57,
    over20: 2, over20Pct: 66.67, startCovered: true, endCovered: true
  });
  assert.equal(measured.draw.n, 2);
});

test('窗口结束前一直没有新运动时保留停顿下限', () => {
  const frames = [110, 130].map(at => ({ at, draw: 2 }));
  const measured = frameSummary({ frames, steps: [] }, {
    drawn: [], rows: frames, moving: frames.slice(0, 1)
  }, 100, 150);
  assert.deepEqual(measured.visibleMotion, {
    n: 0, startCovered: false, endCovered: false, initialUnobservedMs: 10, finalUnobservedMs: 40
  });
});

test('请求到同一步确认画面的累计时间独立检查，并单独记录未显示步骤', () => {
  const frames = [{ at: 35, traceTs: 35000, tick: 500, draw: 2, drawToPresent: 15, poses: ['a', 3, 0] }];
  const commits = [{ at: 20, tick: 500 }];
  const requests = [{ traceAt: 3000, tick: 500, committed: true }, { traceAt: 600000, tick: 1000, committed: true }];
  const measured = frameSummary({ frames, steps: commits }, { drawn: [], rows: frames, moving: frames }, 0, 700, commits, requests);
  assert.equal(measured.authorityToVisibleMotion.max, 15);
  assert.equal(measured.requestToConfirmedFrame.max, 32);
  assert.equal(measured.requestToConfirmedFrame.over20, 1);
  assert.equal(measured.requestToConfirmedFrame.requestsWithoutObservedFrame, 1);
});

test('同一步取较迟呈现的一端，任一端缺帧都算缺失', () => {
  const requests = [500, 1000, 1500].map(tick => ({ tick, committed: true, traceAt: tick * 1000 }));
  for (const [node, delays] of [['host', [18, 28, 9]], ['peer', [24, 11]]]) {
    const rows = delays.map((ms, i) => {
      const { tick, traceAt } = requests[i];
      return { tick, at: tick + ms, traceTs: traceAt + ms * 1000, drawStartTs: traceAt + 6000,
        drawEndTs: traceAt + 8000, poses: ['鱼', i, 0] };
    });
    frameSummary({ node, leader: 'host', frames: [], steps: [] }, { drawn: [], rows, moving: [] }, 0, 2000, [], requests);
  }
  const result = bothDisplays(requests);
  assert.equal(result.over20, 2);
  assert.equal(result.missing, 1);
  assert.equal(result.max, 28);
  assert.equal(result.slowest.tick, 1000);
  assert.deepEqual(result.slowest.host, { drawStart: 6, drawEnd: 8, presented: 28 });
  assert.equal(result.afterFirstDraw.host.max, 20);
  assert.equal(result.afterFirstDraw.peer.max, 16);
});
