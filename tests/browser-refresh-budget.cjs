const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { readGraphicsEvents, indexOffscreenPresentations } = require('./offscreen-presentation.cjs');

const monotonicUs = () => Number(process.hrtime.bigint() / 1000n);

function calibrateTraceClock(events, samples) {
  const marks = new Map();
  for (const event of events) {
    const native = event.name === 'clock_sync' && event.ph === 'c';
    const id = native ? event.args?.sync_id : event.name;
    if (!id?.startsWith('tide.clock.')) continue;
    marks.set(id, marks.has(id) ? null : { kind: native ? 'native' : 'page',
      ts: native ? event.ts : event.args?.data?.callTime });
  }
  function measure(rows) {
    if (!rows || rows.length < 2) return;
    let low = -Infinity, high = Infinity;
    const stamps = [];
    for (const { id, before, after, kind } of rows) {
      const mark = marks.get(id);
      if (!mark || mark.kind !== kind || !Number.isSafeInteger(mark.ts) || !Number.isSafeInteger(before) ||
          !Number.isSafeInteger(after) || after < before || mark.ts <= (stamps.at(-1) ?? -Infinity)) return;
      stamps.push(mark.ts);
      // Both samples and the exported trace ticks have integer microsecond resolution.
      low = Math.max(low, before - mark.ts - 2);
      high = Math.min(high, after - mark.ts + 2);
    }
    if (low <= high) return { bounds: [low, high], stamps };
  }
  const before = measure(samples?.before), after = measure(samples?.after);
  if (!before || !after || before.stamps.at(-1) >= after.stamps[0]) return;
  const [a, b] = before.bounds, [c, d] = after.bounds;
  const intersection = [Math.max(a, c), Math.min(b, d)];
  if (intersection[0] > intersection[1]) return;
  return { intersection, bounds: [Math.min(a, c), Math.max(b, d)], offsetUs: (intersection[0] + intersection[1]) / 2,
    traceRange: [before.stamps.at(-1), after.stamps[0]], samples: [before.stamps.length, after.stamps.length],
    driftUs: Math.max(Math.abs(a - d), Math.abs(b - c)) };
}

function traceClockSkew(clocks) {
  if (clocks?.length !== 2 || clocks.some(clock => !clock)) return;
  const spanUs = Math.max(...clocks.map(clock => clock.bounds[1])) - Math.min(...clocks.map(clock => clock.bounds[0])) + 2;
  if (spanUs <= 1000) return spanUs / 1000;
}

function traceInstant(ts, clock) {
  if (!Number.isFinite(ts) || !clock || ts < clock.traceRange[0] || ts > clock.traceRange[1]) return;
  return { at: ts + clock.offsetUs, low: ts + clock.bounds[0] - 1, high: ts + clock.bounds[1] + 1 };
}

function recordDraw(renderer, frames, page, trace, owner = false) {
  const draw = renderer.draw.bind(renderer);
  const glyphIds = new Map();
  renderer.draw = (...args) => {
    const sequence = frames.length;
    const prefix = `tide.refresh.${page}.${owner ? 'owner.' : ''}${sequence}`;
    const beforeMark = performance.now();
    const start = trace ? performance.mark(prefix + '.start').startTime : beforeMark;
    const afterMark = trace && performance.now();
    draw(...args);
    const drawMs = performance.now() - start;
    if (trace) {
      performance.mark(prefix + '.end');
      performance.clearMarks(prefix + '.start');
      performance.clearMarks(prefix + '.end');
    }
    const poses = [];
    const cells = renderer.paintedFish || [];
    const coordinates = renderer.paintedCoordinates, visible = coordinates ? cells.length : cells.length / 3;
    const step = Math.max(1, Math.floor(visible / 96));
    if (trace) for (let i = 0; i < visible; i += step) {
      const x = coordinates ? coordinates[i * 2] : cells[i * 3];
      const y = coordinates ? coordinates[i * 2 + 1] : cells[i * 3 + 1], size = renderer.paintedSize;
      if (x + size / 2 < 0 || y + size / 2 < 0 || x + size / 2 >= renderer.width || y + size / 2 >= renderer.height) continue;
      const glyph = (coordinates ? cells[i] : cells[i * 3 + 2]).id;
      let ordinal = glyphIds.get(glyph);
      if (ordinal === undefined) { ordinal = glyphIds.size; glyphIds.set(glyph, ordinal); }
      // Keep exact coordinates and stable identity in a packed numeric array.
      // Retaining glyph strings beside boxed doubles on every frame perturbs GC.
      poses.push(ordinal, x, y);
    }
    frames.push({ sequence, at: performance.timeOrigin + start, draw: drawMs, ...(owner && { owner }),
      ...(trace && { beforeMark: performance.timeOrigin + beforeMark, afterMark: performance.timeOrigin + afterMark }),
      tick: args[0].data.tick, visible, poses });
  };
}

async function startTrace(browser, boundariesOnly, profileRules = false, offscreen = false) {
  const client = await browser.newBrowserCDPSession();
  const complete = once(client, 'Tracing.tracingComplete');
  const categories = ['__metadata', 'devtools.timeline', 'blink.user_timing'];
  if (offscreen) categories.push('blink', 'viz');
  if (profileRules) categories.push('disabled-by-default-v8.cpu_profiler');
  if (!boundariesOnly) categories.push('toplevel');
  await client.send('Tracing.start', { traceConfig: { includedCategories: categories, excludedCategories: ['*'],
    ...(offscreen && { traceBufferSizeInKb: 384 * 1024 }) }, transferMode: 'ReturnAsStream',
    ...(offscreen && { streamCompression: 'gzip' }) });
  const id = 'tide.clock.' + randomUUID();
  let native = true, clockError;
  async function bracketClock(phase) {
    const rows = [];
    try {
      for (let i = 0; i < 12; i++) {
        const syncId = id + '.' + phase + '.' + i;
        let before = monotonicUs();
        if (native) {
          try { await client.send('Tracing.recordClockSyncMarker', { syncId }); }
          catch (error) {
            if (!/not supported|wasn't found|method not found|unknown method/i.test(error.message)) throw error;
            native = false;
          }
        }
        if (!native) {
          const page = browser.contexts()[0]?.pages()[0];
          if (!page) throw Error('浏览器没有可记录时钟标记的页面');
          before = monotonicUs();
          await page.evaluate(name => { performance.mark(name); performance.clearMarks(name); }, syncId);
        }
        rows.push({ id: syncId, kind: native ? 'native' : 'page', before, after: monotonicUs() });
      }
    } catch (error) { clockError = error.message; return; }
    return rows;
  }
  const before = await bracketClock('before');
  return async filename => {
    const after = await bracketClock('after');
    await client.send('Tracing.end');
    const [{ stream, dataLossOccurred }] = await complete;
    if (!stream) throw new Error('浏览器未提供跟踪数据');
    const chunks = [];
    async function* readChunks() {
      for (;;) {
        const { data, base64Encoded, eof } = await client.send('IO.read', { handle: stream, size: 1024 * 1024 });
        yield Buffer.from(data, base64Encoded ? 'base64' : 'utf8');
        if (eof) break;
      }
    }
    try {
      if (dataLossOccurred) throw new Error('浏览器跟踪不完整');
      if (offscreen) await pipeline(readChunks(), createGunzip(), createWriteStream(filename));
      else for await (const bytes of readChunks()) chunks.push(bytes);
    } finally {
      await client.send('IO.close', { handle: stream });
      await client.detach();
    }
    let data;
    if (offscreen) data = await readGraphicsEvents(createReadStream(filename, { encoding: 'utf8' }));
    else {
      const json = Buffer.concat(chunks);
      await writeFile(filename, json);
      data = JSON.parse(json);
    }
    const clock = calibrateTraceClock(data.traceEvents, { before, after });
    return { ...data, clock, clockBrackets: { before, after }, clockError: clockError ||
      (!clock && '观察前后缺少可相互验证的宿主时钟标记') || undefined };
  };
}

function readPresentations(events, page, start, end, clock) {
  const startMarks = new Map(), samples = new Map(), presentation = new Map();
  const prefix = `tide.refresh.${page.page}.`;
  const dispatchThreads = new Set(events.filter(e => e.name === 'CanvasResourceDispatcher::DispatchFrame').map(e => `${e.pid}:${e.tid}`));
  const useCanvasFeedback = page.frames.some(frame => frame.owner) || page.surface?.desynchronized === true || dispatchThreads.size > 0;
  const canvasPresentation = useCanvasFeedback && indexOffscreenPresentations(events);
  const sorted = events.filter(event => event.name.startsWith('AnimationFrame') || event.name.startsWith(prefix))
    .sort((a, b) => (a.args?.data?.callTime ?? a.ts) - (b.args?.data?.callTime ?? b.ts));
  for (const event of sorted) {
    const { name, ph, args, pid, tid, ts, tts } = event;
    const thread = `${pid}:${tid}`;
    if (name === 'AnimationFrame' && ph === 'b') samples.set(thread, args.id);
    if (name === 'AnimationFrame' && ph === 'e') samples.delete(thread);
    if (name === 'AnimationFrame::Presentation') presentation.set(`${thread}:${args.id}`, ts);
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length), dot = tail.lastIndexOf('.');
    const sequence = tail.slice(0, dot), phase = tail.slice(dot + 1);
    if (phase === 'start') startMarks.set(sequence, { ts: args.data.callTime, tts, pid, tid });
    else {
      const start = startMarks.get(sequence);
      if (start) Object.assign(start, { endTs: args.data.callTime, endTts: tts, frame: `${thread}:${samples.get(thread)}` });
    }
  }
  const drawn = [];
  let unverifiedCanvas = 0;
  let minClockOffset = -Infinity, maxClockOffset = Infinity;
  const displayed = new Map();
  for (const frame of page.frames) {
    const mark = startMarks.get(`${frame.owner ? 'owner.' : ''}${frame.sequence}`);
    if (!mark?.endTs) continue;
    // The thread can be suspended inside performance.mark(). Its trace timestamp
    // lies between these two readings. Intersect every observation, allowing
    // 0.1 ms on either side for Chromium's non-isolated performance clock.
    minClockOffset = Math.max(minClockOffset, (frame.beforeMark ?? frame.at) - mark.ts / 1000 - .1);
    maxClockOffset = Math.min(maxClockOffset, (frame.afterMark ?? frame.at) - mark.ts / 1000 + .1);
    const drawCpu = (mark.endTts - mark.tts) / 1000;
    if (Number.isFinite(drawCpu)) drawn.push({ at: frame.at, drawCpu });
    const childSurface = frame.owner || page.surface?.desynchronized === true || dispatchThreads.has(`${mark.pid}:${mark.tid}`);
    // A low-latency 2D canvas submits its own surface. Blink's page frame can
    // be acknowledged before that submission, so require its own Viz receipt.
    const presented = childSurface ? canvasPresentation(mark, startMarks.get(`${frame.owner ? 'owner.' : ''}${frame.sequence + 1}`)?.ts ?? Infinity)?.presented
      : presentation.get(mark.frame);
    if (childSurface && !(presented >= mark.endTs)) unverifiedCanvas++;
    if (!(presented >= mark.endTs)) continue;
    const at = frame.at + (presented - mark.ts) / 1000;
    displayed.set(presented, { ...frame, at, traceTs: presented, drawStartTs: mark.ts, drawEndTs: mark.endTs,
      drawToPresent: (presented - mark.endTs) / 1000 });
  }
  const rows = [...displayed.values()].sort((a, b) => a.at - b.at);
  const moving = [];
  const longestMotionGaps = [];
  let previousIndices = new Map(), previousPoses = [];
  for (const frame of rows) {
    let changed = false;
    const current = new Map();
    const poses = frame.poses;
    for (let i = 0; i < poses.length; i += 3) {
      const prior = previousIndices.get(poses[i]);
      if (prior !== undefined && (poses[i + 1] - previousPoses[prior + 1]) ** 2 +
        (poses[i + 2] - previousPoses[prior + 2]) ** 2 >= .01) changed = true;
      current.set(poses[i], i);
    }
    if (changed) {
      const prior = moving.at(-1);
      if (prior && frame.at > start && prior.at < end) {
        const ms = frame.at - prior.at;
        if (longestMotionGaps.length < 5 || ms > longestMotionGaps.at(-1).ms) {
          longestMotionGaps.push({ ms, afterMs: frame.at - start, fromTick: prior.tick, toTick: frame.tick,
            fromFrame: prior.sequence, toFrame: frame.sequence });
          longestMotionGaps.sort((a, b) => b.ms - a.ms);
          if (longestMotionGaps.length > 5) longestMotionGaps.pop();
        }
      }
      moving.push(frame);
    }
    previousIndices = current;
    previousPoses = poses;
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
  // Page-clock estimates remain diagnostic. Inter-process acceptance uses
  // the independently bracketed trace clock supplied by the test host.
  return { drawn, rows, moving, longestGaps, longestMotionGaps, unverifiedCanvas, clock,
    clockOffsets: Number.isFinite(minClockOffset) && minClockOffset <= maxClockOffset ? [minClockOffset, maxClockOffset] : undefined };
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
    if (!request.committed || !frame || !Number.isFinite(request.traceAt)) continue;
    const clock = presentations.clock, bounds = request.traceStartBounds;
    const startFrame = clock && traceInstant(frame.drawStartTs, clock);
    const endFrame = clock && traceInstant(frame.traceTs, clock);
    if (bounds ? !startFrame || !endFrame || startFrame.low < bounds[1] : frame.drawStartTs < request.traceAt) continue;
    const elapsed = ts => (ts + (clock?.offsetUs ?? 0) - request.traceAt) / 1000;
    const display = { drawStart: elapsed(frame.drawStartTs), drawEnd: elapsed(frame.drawEndTs), presented: elapsed(frame.traceTs) };
    if (bounds) display.presentedUpper = (endFrame.high - bounds[0]) / 1000;
    (request.display ??= {})[endName] = display;
    requestToConfirmed.push(display.presentedUpper ?? display.presented);
  }
  return { ...result,
    drawCpu: distribution(presentations.drawn.filter(inWindow).map(frame => frame.drawCpu)),
    presented: cadence(presentations.rows, start, end),
    visibleMotion: cadence(presentations.moving, start, end),
    framesPresented: presentations.rows.filter(inWindow).length,
    framesWithMotion: presentations.moving.filter(inWindow).length,
    longestPresentationGaps: presentations.longestGaps,
    longestMotionGaps: presentations.longestMotionGaps,
    drawToPresent: distribution(presentations.rows.filter(inWindow).map(frame => frame.drawToPresent)),
    authorityToVisibleMotion: { ...distribution(visibleAfterCommit), commitsWithoutObservedMotion: commits.length - visibleAfterCommit.length },
    requestToConfirmedFrame: { ...distribution(requestToConfirmed), requestsWithoutObservedFrame: requests.length - requestToConfirmed.length }
  };
}

function bothDisplays(requests) {
  const completed = [];
  const drawToPresent = { host: [], peer: [] };
  let slowest;
  for (const { tick, display } of requests) {
    if (!display?.host || !display.peer) continue;
    const ms = Math.max(display.host.presentedUpper ?? display.host.presented, display.peer.presentedUpper ?? display.peer.presented);
    for (const side of ['host', 'peer']) drawToPresent[side].push(display[side].presented - display[side].drawEnd);
    completed.push(ms);
    if (!slowest || slowest.ms < ms) slowest = { tick, ms, ...display };
  }
  return { ...distribution(completed), requested: requests.length, missing: requests.length - completed.length, slowest,
    afterFirstDraw: { host: distribution(drawToPresent.host), peer: distribution(drawToPresent.peer) } };
}

function scheduledSteps(requests, phase, step, start, end) {
  const first = phase + Math.ceil((start - phase) / step) * step;
  const observed = new Set(requests.filter(row => row.display?.host && row.display.peer).map(row => row.tick));
  const attempted = new Set(requests.map(row => row.tick));
  const unrequested = [], unpresented = [];
  let expected = 0;
  for (let tick = first; tick < end; tick += step) {
    expected++;
    if (!attempted.has(tick)) unrequested.push(tick);
    if (!observed.has(tick)) unpresented.push(tick);
  }
  return { expected, unrequested, unpresented };
}

function matchStepStarts(requests, peers, hostMarks = new Map(), peerMarks = new Map(), clocks) {
  const validClocks = !clocks || traceClockSkew(clocks) !== undefined;
  const byTick = new Map();
  for (const row of peers) {
    if (!byTick.has(row.tick)) byTick.set(row.tick, []);
    byTick.get(row.tick).push(row);
  }
  for (const request of requests) {
    const hostStamp = hostMarks.get(request.marker ?? request.sequence);
    const others = byTick.get(request.tick) || [];
    const peerStamps = others.map(row => peerMarks.get(row.marker ?? row.sequence));
    const hostInstant = clocks && traceInstant(hostStamp, clocks[0]), peerInstants = clocks && peerStamps.map(ts => traceInstant(ts, clocks[1]));
    const host = clocks ? hostInstant?.at : hostStamp;
    const stamps = clocks ? peerInstants.map(stamp => stamp?.at) : peerStamps;
    // A sealed tick belongs to both engines. Its clock starts at the first
    // request, including earlier peer attempts. Missing evidence fails closed.
    request.traceAt = validClocks && Number.isFinite(host) && stamps.every(Number.isFinite) &&
      (!request.agreed || others.some(row => row.agreed && row.committed))
      ? Math.min(host, ...stamps) : undefined;
    if (clocks && request.traceAt !== undefined) request.traceStartBounds =
      [Math.min(hostInstant.low, ...peerInstants.map(stamp => stamp.low)), Math.min(hostInstant.high, ...peerInstants.map(stamp => stamp.high))];
    if (others.length) request.peerSteps = others.map((row, i) => ({
      agreed: row.agreed, committed: row.committed, compute: row.ms,
      startFromHost: Number.isFinite(stamps[i]) && Number.isFinite(host) ? (stamps[i] - host) / 1000 : undefined,
      rule: row.rule, toWorker: row.toWorker, inWorker: row.inWorker, fromWorker: row.fromWorker, authority: row.authority
    }));
  }
}

module.exports = { recordDraw, frameSummary, startTrace, readPresentations, bothDisplays, scheduledSteps, matchStepStarts,
  calibrateTraceClock, traceClockSkew };
