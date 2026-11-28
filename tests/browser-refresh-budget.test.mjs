import assert from 'node:assert/strict';
import test from 'node:test';
import { readPresentations, frameSummary, bothDisplays, scheduledSteps, matchStepStarts } from './browser-refresh-budget.cjs';
import { decodeGraphicsTrace, readGraphicsEvents } from './offscreen-presentation.cjs';

test('连续多轮的图层跟踪可跨块读取，保留原始帧编号并拒绝截断', async () => {
  const event = { name: 'Graphics.Pipeline', args: { chrome_graphics_pipeline: { step: 'STEP_DRAW_AND_SWAP', display_trace_id: 0 }, text: '}"[\\' } };
  const source = JSON.stringify({ traceEvents: [event] }).replace('"display_trace_id":0', '"display_trace_id":9223372036854775701');
  const result = await readGraphicsEvents([...source]);
  assert.deepEqual(result, decodeGraphicsTrace(source));
  await assert.rejects(readGraphicsEvents([source.slice(0, -2)]), /截断/);
});

test('只采入场时仍按相同步号核对双方实际提交，并保留未提交和旧通道', () => {
  const requests = [500, 1000, 1500].map(tick => ({ tick, agreed: true, committed: true }));
  const peers = [{ tick: 500, agreed: true, committed: true }, { tick: 1000, agreed: true, committed: false }];
  matchStepStarts(requests, peers);
  assert.equal(requests[0].peerSteps[0].committed, true);
  assert.equal(requests[1].peerSteps[0].committed, false);
  assert.equal(requests[2].peerSteps, undefined);
  assert.equal(requests[0].peerSteps[0].startFromHost, undefined);
  assert.equal(requests[0].traceAt, undefined);
});

test('独立画布必须找到同一子图层与实际合成器呈现', () => {
  const worker = (name, ts) => ({ name, ts, pid: 1, tid: 2, tts: ts, args: { data: { callTime: ts } } });
  const viz = (name, ts, fields = {}) => ({ name, ts, pid: 3, tid: 4, ...fields });
  const pipeline = (step, ts, fields) => viz('Graphics.Pipeline', ts, { dur: 30, args: { chrome_graphics_pipeline: { step, ...fields } } });
  const child = '9223372036854775701', other = '9223372036854775702', display = '21';
  const trace = [worker('tide.refresh.A.owner.0.start', 1000), worker('tide.refresh.A.owner.0.end', 2000),
    worker('CanvasResourceDispatcher::DispatchFrame', 2010),
    pipeline('STEP_RECEIVE_COMPOSITOR_FRAME', 2015, { surface_frame_trace_id: child, frame_sink_id: { frame_sink_client_id: 6, frame_sink_id: 2147483648 } }),
    pipeline('STEP_DRAW_AND_SWAP', 2020, { display_trace_id: display }),
    pipeline('STEP_SURFACE_AGGREGATION', 2025, { display_trace_id: display, aggregated_surface_frame_trace_ids: [other, child] }),
    viz('Graphics.Pipeline.DrawAndSwap', 2030, { ph: 'b', id2: { local: '0x1' } }),
    viz('Graphics.Pipeline.DrawAndSwap', 8000, { ph: 'e', id2: { local: '0x1' } }), viz('Display::FrameDisplayed', 8000)];
  const raw = JSON.stringify(trace).replace(/"(922337203685477570[12]|21)"/g, '$1');
  const events = decodeGraphicsTrace(raw), page = { page: 'A', frames: [{ at: 1, sequence: 0, owner: true, poses: [1, 20, 30] }] };
  assert.equal(readPresentations(events, page, 0, 15).rows[0].traceTs, 8000);
  assert.equal(readPresentations(events.slice(0, -1), page, 0, 15).rows.length, 0);
  events[7].args = { status: 'canceled' };
  assert.equal(readPresentations(events, page, 0, 15).rows.length, 0);
  delete events[7].args;
  events[5].args.chrome_graphics_pipeline.aggregated_surface_frame_trace_ids.pop();
  assert.equal(readPresentations(events, page, 0, 15).rows.length, 0);
});

test('低延迟主线程画布不能拿先于自身提交的页面回执验收', () => {
  const worker = (name, ts, args = {}, ph) => ({ name, ts, pid: 1, tid: 2, args, ph });
  const page = { page: 'A', surface: { desynchronized: true }, frames: [{ sequence: 0, at: 1.1, poses: [1, 4, 7] }] };
  const blink = [worker('AnimationFrame', 1000, { id: 4 }, 'b'),
    worker('tide.refresh.A.0.start', 1100, { data: { callTime: 1100 } }),
    worker('tide.refresh.A.0.end', 2000, { data: { callTime: 2000 } }),
    worker('AnimationFrame', 2020, { id: 4 }, 'e'), worker('AnimationFrame::Presentation', 2100, { id: 4 })];
  const frames = [...blink, worker('CanvasResourceDispatcher::DispatchFrame', 2120),
    { name: 'Graphics.Pipeline', ts: 2200, pid: 3, tid: 4, args: { chrome_graphics_pipeline: {
      step: 'STEP_RECEIVE_COMPOSITOR_FRAME', surface_frame_trace_id: '-1', frame_sink_id: { frame_sink_client_id: 6, frame_sink_id: 2147483648 }
    } } }, { name: 'Display::FrameDisplayed', ts: 8250, pid: 3, tid: 4 }];
  assert.equal(readPresentations(blink, { ...page, surface: { desynchronized: false } }, 0, 15).rows[0].traceTs, 2100);
  assert.equal(readPresentations(blink, page, 0, 15).rows.length, 0);
  const unverified = readPresentations(frames, page, 0, 15);
  assert.equal(unverified.rows.length, 0);
  assert.equal(unverified.unverifiedCanvas, 1);
  assert.equal(readPresentations(frames, { ...page, surface: undefined }, 0, 15).rows.length, 0);
});

test('双端本地结算从最先发起的请求计时，遗漏对方的时标或确认均不能通过', () => {
  const requests = [500, 1000, 1500, 2000].map((tick, sequence) => ({ tick, sequence, agreed: sequence > 0 }));
  const peers = [{ tick: 1000, sequence: 4, agreed: true, committed: true },
    { tick: 2000, sequence: 5, agreed: true, committed: true }];
  matchStepStarts(requests, peers, new Map([[0, 900], [1, 10000], [2, 20000], [3, 30000]]), new Map([[4, 6000]]));
  assert.deepEqual(requests.map(r => r.traceAt), [900, 6000, undefined, undefined]);
  assert.equal(requests[1].peerSteps[0].startFromHost, -4);
});

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
