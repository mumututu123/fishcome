import assert from 'node:assert/strict';
import test from 'node:test';
import { frameSummary, bothDisplays } from './browser-refresh-budget.cjs';

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
  const frames = [{ at: 35, traceTs: 35000, tick: 500, draw: 2, drawToPresent: 15, poses: [['a', 3, 0]] }];
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
        drawEndTs: traceAt + 8000, poses: [['鱼', i, 0]] };
    });
    frameSummary({ node, leader: 'host', frames: [], steps: [] }, { drawn: [], rows, moving: [] }, 0, 2000, [], requests);
  }
  const result = bothDisplays(requests);
  assert.equal(result.over20, 2);
  assert.equal(result.missing, 1);
  assert.equal(result.max, 28);
  assert.equal(result.slowest.tick, 1000);
  assert.deepEqual(result.slowest.host, { drawStart: 6, drawEnd: 8, presented: 28 });
});
