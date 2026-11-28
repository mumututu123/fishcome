// Perfetto exports frame identifiers as signed int64 JSON numbers. Keep their
// decimal spelling so adjacent frames remain distinct in JavaScript.
function decodeGraphicsTrace(json) {
  return JSON.parse(json.replace(/("(?:surface_frame_trace_id|display_trace_id)"\s*:\s*)(-?\d+)/g, '$1"$2"')
    .replace(/("aggregated_surface_frame_trace_ids"\s*:\s*\[)([^\]]*)/g, (_, start, ids) => start + ids.replace(/-?\d+/g, id => `"${id}"`)));
}

const thread = e => `${e.pid}:${e.tid}`;

function indexOffscreenPresentations(events) {
  const swaps = new Map(), receives = new Map(), aggregates = new Map(), dispatches = new Map(), presentations = new Map();
  const begin = new Map(), displayed = new Set();
  const eventTime = e => e.args?.data?.callTime ?? e.ts;
  for (const e of events.slice().sort((a, b) => eventTime(a) - eventTime(b))) {
    if (e.name === 'Display::FrameDisplayed') displayed.add(`${thread(e)}:${e.ts}`);
    if (e.name === 'CanvasResourceDispatcher::DispatchFrame') {
      const key = thread(e);
      if (!dispatches.has(key)) dispatches.set(key, []);
      dispatches.get(key).push(e);
    }
    if (e.name === 'Graphics.Pipeline.DrawAndSwap') {
      const id = `${thread(e)}:${e.id2?.local}`;
      if (e.ph === 'b') begin.set(id, begin.has(id) ? null : e);
      if (e.ph === 'e' && begin.has(id)) {
        const start = begin.get(id), key = thread(e);
        if (start) {
          if (!presentations.has(key)) presentations.set(key, []);
          presentations.get(key).push({ ts: start.ts, presented: e.ts });
        }
        begin.delete(id);
      }
    }
    const row = e.args?.chrome_graphics_pipeline;
    if (!row) continue;
    if (row.step === 'STEP_RECEIVE_COMPOSITOR_FRAME') receives.set(row.surface_frame_trace_id, e);
    if (row.step === 'STEP_DRAW_AND_SWAP') swaps.set(row.display_trace_id, e);
    if (row.step === 'STEP_SURFACE_AGGREGATION') for (const id of row.aggregated_surface_frame_trace_ids || []) {
      if (!aggregates.has(id)) aggregates.set(id, []);
      aggregates.get(id).push(e);
    }
  }

  const sinks = [...receives.values()].filter(e => {
    const id = e.args.chrome_graphics_pipeline.frame_sink_id;
    return id?.frame_sink_client_id > 0 && id.frame_sink_id >= 0x80000000;
  }).sort((a, b) => a.ts - b.ts);
  for (const rows of presentations.values()) rows.sort((a, b) => a.ts - b.ts);
  function firstAt(rows, at) {
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].ts < at) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  return (draw, next) => {
    // Match one canvas dispatch to one child-surface receive. The exact child
    // identifier then has to appear in a swap with display feedback.
    const dispatchRows = dispatches.get(thread(draw));
    if (!dispatchRows) return;
    const i = firstAt(dispatchRows, draw.endTs), dispatch = dispatchRows[i];
    if (!dispatch || dispatch.ts >= next) return;
    const n = firstAt(sinks, dispatch.ts), received = sinks[n];
    if (!received || received.ts >= (dispatchRows[i + 1]?.ts ?? Infinity)) return;
    if (sinks[n + 1]?.ts < (dispatchRows[i + 1]?.ts ?? Infinity)) return;
    const id = received.args.chrome_graphics_pipeline.surface_frame_trace_id;
    for (const aggregate of aggregates.get(id) || []) {
      if (aggregate.ts < received.ts) continue;
      const swap = swaps.get(aggregate.args.chrome_graphics_pipeline.display_trace_id);
      if (!swap || thread(swap) !== thread(aggregate) || aggregate.ts < swap.ts || aggregate.ts >= swap.ts + swap.dur) continue;
      const rows = presentations.get(thread(swap)) || [], index = firstAt(rows, swap.ts), matched = rows[index];
      if (!matched || matched.ts >= swap.ts + swap.dur || rows[index + 1]?.ts < swap.ts + swap.dur) continue;
      if (matched.presented >= aggregate.ts && displayed.has(`${thread(swap)}:${matched.presented}`)) {
        return { presented: matched.presented, dispatch: dispatch.ts, received: received.ts, aggregate: aggregate.ts };
      }
    }
  };
}

module.exports = { decodeGraphicsTrace, indexOffscreenPresentations };
