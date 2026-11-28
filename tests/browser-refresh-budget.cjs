const { once } = require('node:events');
const { writeFile } = require('node:fs/promises');

function recordDraw(renderer, frames, page, trace) {
  const draw = renderer.draw.bind(renderer);
  renderer.draw = (...args) => {
    const sequence = frames.length;
    const prefix = `tide.refresh.${page}.${sequence}`;
    if (trace) performance.mark(prefix + '.start');
    const start = performance.now();
    draw(...args);
    const drawMs = performance.now() - start;
    if (trace) {
      performance.mark(prefix + '.end');
      performance.clearMarks(prefix + '.start');
      performance.clearMarks(prefix + '.end');
    }
    const poses = [];
    const cells = renderer.paintedFish || [];
    const step = Math.max(1, Math.floor(cells.length / 3 / 96)) * 3;
    if (trace) for (let i = 0; i < cells.length; i += step) {
      const x = cells[i], y = cells[i + 1], size = renderer.paintedSize;
      if (x + size / 2 < 0 || y + size / 2 < 0 || x + size / 2 >= renderer.width || y + size / 2 >= renderer.height) continue;
      poses.push([cells[i + 2].id, x, y]);
    }
    frames.push({ sequence, at: performance.timeOrigin + start, draw: drawMs,
      tick: args[0].data.tick, visible: cells.length / 3, poses });
  };
}

async function startTrace(browser) {
  const client = await browser.newBrowserCDPSession();
  const complete = once(client, 'Tracing.tracingComplete');
  await client.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,toplevel', transferMode: 'ReturnAsStream' });
  return async filename => {
    await client.send('Tracing.end');
    const [{ stream, dataLossOccurred }] = await complete;
    if (!stream || dataLossOccurred) throw new Error('浏览器跟踪不完整');
    const chunks = [];
    try {
      for (;;) {
        const { data, base64Encoded, eof } = await client.send('IO.read', { handle: stream, size: 1024 * 1024 });
        chunks.push(Buffer.from(data, base64Encoded ? 'base64' : 'utf8'));
        if (eof) break;
      }
    } finally {
      await client.send('IO.close', { handle: stream });
      await client.detach();
    }
    const json = Buffer.concat(chunks);
    await writeFile(filename, json);
    return JSON.parse(json);
  };
}

function readPresentations(events, page, start, end) {
  const startMarks = new Map(), samples = new Map(), presentation = new Map();
  const prefix = `tide.refresh.${page.page}.`;
  const sorted = events.filter(event => event.name.startsWith('AnimationFrame') || event.name.startsWith(prefix))
    .sort((a, b) => (a.args?.data?.callTime ?? a.ts) - (b.args?.data?.callTime ?? b.ts));
  for (const event of sorted) {
    const { name, ph, args, pid, tid, ts, tts } = event;
    const thread = `${pid}:${tid}`;
    if (name === 'AnimationFrame' && ph === 'b') samples.set(thread, args.id);
    if (name === 'AnimationFrame' && ph === 'e') samples.delete(thread);
    if (name === 'AnimationFrame::Presentation') presentation.set(`${thread}:${args.id}`, ts);
    if (!name.startsWith(prefix)) continue;
    const [sequence, phase] = name.slice(prefix.length).split('.');
    if (phase === 'start') startMarks.set(Number(sequence), { ts: args.data.callTime, tts, pid, tid });
    else {
      const start = startMarks.get(Number(sequence));
      if (start) Object.assign(start, { endTs: args.data.callTime, endTts: tts, frame: `${thread}:${samples.get(thread)}` });
    }
  }
  const drawn = [];
  const displayed = new Map();
  for (const frame of page.frames) {
    const mark = startMarks.get(frame.sequence);
    if (!mark?.endTs) continue;
    const drawCpu = (mark.endTts - mark.tts) / 1000;
    if (Number.isFinite(drawCpu)) drawn.push({ at: frame.at, drawCpu });
    const presented = presentation.get(mark.frame);
    if (!(presented >= mark.endTs)) continue;
    const at = frame.at + (presented - mark.ts) / 1000;
    displayed.set(presented, { ...frame, at, traceTs: presented, drawStartTs: mark.ts, drawEndTs: mark.endTs,
      drawToPresent: (presented - mark.endTs) / 1000 });
  }
  const rows = [...displayed.values()].sort((a, b) => a.at - b.at);
  const moving = [];
  let previous = new Map();
  for (const frame of rows) {
    let changed = false;
    const current = new Map();
    for (const [id, x, y] of frame.poses) {
      const p = previous.get(id);
      if (p && (x - p[0]) ** 2 + (y - p[1]) ** 2 >= .01) changed = true;
      current.set(id, [x, y]);
    }
    if (changed) moving.push(frame);
    previous = current;
  }
  const thread = startMarks.values().next().value;
  const work = events.filter(event => event.pid === thread?.pid && event.tid === thread?.tid && event.dur >= 1000 &&
    (event.name === 'ThreadControllerImpl::RunTask' || event.name === 'BlinkScheduler_PerformMicrotaskCheckpoint' ||
      event.name === 'HandlePostMessage' || /GC|AnimationFrame/.test(event.name)));
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1], after = rows[i];
    if (after.at > start && before.at < end) gaps.push({ before, after, ms: after.at - before.at });
  }
  const longestGaps = gaps.sort((a, b) => b.ms - a.ms).slice(0, 5).map(({ before, after, ms }) => ({
    ms, afterMs: after.at - start, tickChanged: before.tick !== after.tick,
    tasks: work.filter(task => task.ts < after.traceTs && task.ts + task.dur > before.traceTs)
      .sort((a, b) => b.dur - a.dur).slice(0, 5)
      .map(task => ({ name: task.name, wallMs: task.dur / 1000, cpuMs: task.tdur / 1000 }))
  }));
  return { drawn, rows, moving, longestGaps };
}

function distribution(values) {
  const sorted = values.sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n };
  const ms = value => Math.round(value * 1000) / 1000;
  const percentile = fraction => ms(sorted[Math.ceil(n * fraction) - 1]);
  const over20 = sorted.filter(value => value > 20).length;
  return { n, min: ms(sorted[0]), median: percentile(.5), p95: percentile(.95), p99: percentile(.99),
    max: ms(sorted.at(-1)), over20, over20Pct: Math.round(over20 / n * 10000) / 100 };
}

function cadence(rows, start, end) {
  const gaps = [];
  let previous;
  for (const row of rows) {
    if (previous && row.at > start && previous.at < end) gaps.push(row.at - previous.at);
    if (row.at >= end) break;
    previous = row;
  }
  const first = rows[0]?.at, last = rows.at(-1)?.at;
  return { ...distribution(gaps), startCovered: first <= start, endCovered: last >= end,
    ...(first > start ? { initialUnobservedMs: Math.min(first, end) - start } : {}),
    ...(last < end ? { finalUnobservedMs: end - Math.max(last, start) } : {}) };
}

function frameSummary(page, presentations, start, end, authority = page.steps, requests = []) {
  const inWindow = frame => frame.at >= start && frame.at < end;
  const result = {
    frames: cadence(page.frames, start, end),
    draw: distribution(page.frames.filter(inWindow).map(frame => frame.draw))
  };
  if (!presentations) return result;
  const firstMoving = new Map();
  for (const frame of presentations.moving) if (!firstMoving.has(frame.tick)) firstMoving.set(frame.tick, frame.at);
  const firstVisible = new Map();
  for (const frame of presentations.rows) if (frame.poses?.length && !firstVisible.has(frame.tick)) firstVisible.set(frame.tick, frame);
  const commits = authority.filter(inWindow);
  const visibleAfterCommit = commits.map(commit => firstMoving.get(commit.tick) - commit.at).filter(ms => Number.isFinite(ms) && ms >= 0);
  const requestToConfirmed = [];
  const endName = page.node === page.leader ? 'host' : 'peer';
  for (const request of requests) {
    const frame = firstVisible.get(request.tick);
    if (!request.committed || !frame || !Number.isFinite(request.traceAt) || frame.drawStartTs < request.traceAt) continue;
    const elapsed = ts => (ts - request.traceAt) / 1000;
    (request.display ??= {})[endName] = { drawStart: elapsed(frame.drawStartTs), drawEnd: elapsed(frame.drawEndTs),
      presented: elapsed(frame.traceTs) };
    requestToConfirmed.push(elapsed(frame.traceTs));
  }
  return { ...result,
    drawCpu: distribution(presentations.drawn.filter(inWindow).map(frame => frame.drawCpu)),
    presented: cadence(presentations.rows, start, end),
    visibleMotion: cadence(presentations.moving, start, end),
    framesPresented: presentations.rows.filter(inWindow).length,
    framesWithMotion: presentations.moving.filter(inWindow).length,
    longestPresentationGaps: presentations.longestGaps,
    drawToPresent: distribution(presentations.rows.filter(inWindow).map(frame => frame.drawToPresent)),
    authorityToVisibleMotion: { ...distribution(visibleAfterCommit), commitsWithoutObservedMotion: commits.length - visibleAfterCommit.length },
    requestToConfirmedFrame: { ...distribution(requestToConfirmed), requestsWithoutObservedFrame: requests.length - requestToConfirmed.length }
  };
}

function bothDisplays(requests) {
  const completed = [];
  let slowest;
  for (const { tick, display } of requests) {
    if (!display?.host || !display.peer) continue;
    const ms = Math.max(display.host.presented, display.peer.presented);
    completed.push(ms);
    if (!slowest || slowest.ms < ms) slowest = { tick, ms, ...display };
  }
  return { ...distribution(completed), requested: requests.length, missing: requests.length - completed.length, slowest };
}

module.exports = { recordDraw, frameSummary, startTrace, readPresentations, bothDisplays };
