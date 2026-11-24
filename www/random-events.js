import { wrapX, deltaX } from './geography.js';

export const EVENTS = Object.freeze({ period: 360000, opening: 2000, limit: 32, chance: 45 });
export const EVENT_KINDS = Object.freeze(['whale', 'hiccup', 'bottle', 'meeting', 'blossom', 'meteor', 'radio', 'parade']);
const DURATIONS = { whale: 32000, hiccup: 22000, bottle: 60000, meeting: 18000, blossom: 32000, meteor: 16000, radio: 30000, parade: 18000 };
const TITLES = { whale: '深海巨影', hiccup: '海洋打了个嗝', bottle: '漂流瓶路过', meeting: '鱼群临时开会', blossom: '海底开花', meteor: '流星掉进海里', radio: '海洋电台', parade: '倒着游的游行' };
const hash = text => { let n = 2166136261; for (const ch of text) n = Math.imul(n ^ ch.codePointAt(0), 16777619); return n >>> 0; };
const distance = (a, b) => Math.max(Math.abs(deltaX(a.x, b.x)), Math.abs(a.y - b.y));
const seedOf = data => data.terrain?.seed || Object.keys(data.roots).sort()[0];
export const eventTitle = kind => TITLES[kind] || '';
export function eventSchedule(roots, seed, slot) {
  const started = slot * EVENTS.period, id = `ambient:${seed}:${slot}`;
  if (!Number.isInteger(slot) || slot < 0 || !Object.hasOwn(roots, seed) || !Number.isFinite(roots[seed]) || started < roots[seed] || hash(`occasion:${id}`) % 100 >= EVENTS.chance) return null;
  const kind = EVENT_KINDS[(hash(`kind:${id}`) >>> 8) % EVENT_KINDS.length];
  return { id, seed, slot, started, kind, duration: DURATIONS[kind], rare: (hash(`rare:${id}`) >>> 16) % 16 === 0, direction: (hash(`direction:${id}`) >>> 24) % 2 ? 1 : -1 };
}
export function activeEvent(data, now = data.tick) {
  const seed = seedOf(data), slot = Math.floor(now / EVENTS.period);
  for (const event of Object.values(data.life?.events || {})) {
    if (event.seed !== seed || event.slot !== slot) continue;
    const schedule = eventSchedule(data.roots, event.seed, event.slot);
    if (schedule && now >= event.at && now < schedule.started + schedule.duration) return { ...event, ...schedule };
  }
  return null;
}
export function eventPosition(event, now) {
  const seconds = Math.max(0, (now - event.started) / 1000);
  return { x: wrapX(event.x + (event.kind === 'bottle' ? seconds * .35 * event.direction : event.kind === 'whale' ? (seconds - 16) * event.direction : event.kind === 'meteor' ? seconds * 1.8 * event.direction : 0)), y: event.y + (event.kind === 'bottle' ? Math.sin(seconds / 3) * .3 : event.kind === 'meteor' ? seconds * 4.7 : 0) };
}
export function eventLetter(event) {
  if (event.rare) return { text: '？', author: '全文完' };
  const letters = [
    '如果你看到这封信，说明我已经漂得很远了。',
    '海很大，不过今天能遇见你，已经很够了。',
    '我本来想写一个长故事，后来决定先游一会儿。',
    '如果找不到方向，先吐一个泡泡。它知道哪里是上面。',
    '这里没有急事。可以把这句话再读一遍。',
    '有一条鱼让我转告你：今天的水温刚刚好。'
  ];
  return { text: letters[hash(`letter:${event.id}`) % letters.length], author: '某条不愿透露名字的鱼' };
}
export function radioLines(event) {
  const forecasts = ['今日适合缓慢前进。', '今日宜发呆，局部有咕噜。', '前方水域平静，祝你游得自在。'];
  return ['沙……沙……这里是海底。', forecasts[hash(`forecast:${event.id}`) % forecasts.length], '向正在发呆的鱼问好。', event.rare ? '主播去吃草了。' : '本次播音到这里，咕噜。'];
}
export function radioTranscript(event, now) { return radioLines(event).slice(0, Math.max(0, Math.min(4, Math.floor((now - event.started) / 7000) + 1))); }
export function eventNarration(kind) {
  return { whale: '看见深处一道巨大的影子，安静地游了过去', hiccup: '听见海打了个嗝：今天的海，好像吃得很饱', bottle: '看见一封信随着水流，去往下一片水域', meeting: '参加了一次临时会议，讨论了一会儿，似乎没有结论', blossom: '看见海草开了花，像亮起一盏小灯', meteor: '看见一颗星星，游得比自己还快', radio: '听见海底电台断断续续地向发呆的鱼问好', parade: '和熟鱼一起转了个头：刚才的方向不算' }[kind] || '';
}
export function planEvent(world, schedule, now, context) {
  const points = [...context.points.values()].sort((a, b) => hash(`${schedule.id}:${a.id}`) - hash(`${schedule.id}:${b.id}`) || a.id.localeCompare(b.id));
  const healthy = p => !world.breedingState(p.id) && now - world.data.fishes[p.id].lastFed < 86400000;
  let focus = points[0], fishes = [], plants = [];
  if (['meeting', 'parade'].includes(schedule.kind)) {
    for (const point of points.filter(healthy)) {
      const companions = (context.neighbors.get(point.id) || []).filter(q => healthy(q) && world.data.life?.bonds[[point.id, q.id].sort().join('|')]?.seconds >= 45);
      const group = [point.id];
      for (const companion of companions) if (group.length < 4 && group.every(id => (context.neighbors.get(companion.id) || []).some(q => q.id === id))) group.push(companion.id);
      if (group.length >= 3) { focus = point; fishes = group; break; }
    }
    if (!fishes.length) return null;
  }
  if (['hiccup', 'blossom'].includes(schedule.kind)) {
    const weeds = Object.values(world.data.chars).filter(c => c.kind === 'seaweed' && (schedule.kind !== 'blossom' || now - c.created >= 3600000));
    weeds.sort((a, b) => hash(`${schedule.id}:${a.id}`) - hash(`${schedule.id}:${b.id}`) || a.id.localeCompare(b.id));
    if (!weeds.length) return null;
    focus = weeds[0]; plants = weeds.filter(c => distance(c, focus) <= 8).slice(0, 7).map(c => c.id).sort();
  }
  const x = wrapX(focus?.x ?? hash(`x:${schedule.id}`) % 1000);
  let y = focus?.y ?? 25;
  if (schedule.kind === 'whale') y = world.floorAt(x) - 18;
  if (schedule.kind === 'bottle') y = 5;
  if (schedule.kind === 'meteor') y = 2;
  if (schedule.kind === 'radio') y = Math.min(55, Math.max(8, y));
  if (!fishes.length) fishes = points.filter(p => distance(p, { x, y: schedule.kind === 'meteor' ? p.y : y }) <= 35).slice(0, 4).map(p => p.id);
  return { id: schedule.id, seed: schedule.seed, slot: schedule.slot, kind: schedule.kind, at: now, x, y, fishes, plants };
}
export function updateEvents(world, now, context, continuous, record) {
  const life = world.data.life, seed = seedOf(world.data), slot = Math.floor(now / EVENTS.period), started = slot * EVENTS.period;
  life.events ||= {}; life.eventThrough ||= {};
  if (now >= started && (life.eventThrough[seed] ?? -1) < slot) {
    // Mark even an empty/unsuitable slot: refreshing cannot retry a quiet sea.
    life.eventThrough[seed] = slot; world.dirty = true;
    const schedule = eventSchedule(world.data.roots, seed, slot);
    if (continuous && now - started < EVENTS.opening && schedule) {
      const event = planEvent(world, schedule, now, context);
      if (event) {
        life.events[event.id] = event;
        for (const fish of event.fishes) record(world, 'ambient', fish, now, { event: event.id, eventSeed: seed, eventSlot: slot });
      }
    }
  }
  if (Object.keys(life.events).length > EVENTS.limit) life.events = Object.fromEntries(Object.entries(life.events).sort(([a, x], [b, y]) => y.at - x.at || a.localeCompare(b)).slice(0, EVENTS.limit));
}
export function validEvent(event, roots, fish, now, chars) {
  const schedule = event && eventSchedule(roots, event.seed, event.slot);
  if (event && Object.keys(event).some(key => !['id', 'seed', 'slot', 'kind', 'at', 'x', 'y', 'fishes', 'plants'].includes(key))) return false;
  if (!schedule || event.id !== schedule.id || event.kind !== schedule.kind || !Number.isFinite(event.at) || event.at < schedule.started || event.at >= schedule.started + EVENTS.opening || event.at > now || !Number.isFinite(event.x) || event.x < 0 || event.x >= 1000 || !Number.isFinite(event.y) || event.y < 0 || event.y > 101) return false;
  if (!Array.isArray(event.fishes) || event.fishes.length > 4 || new Set(event.fishes).size !== event.fishes.length || !event.fishes.every(fish) || !Array.isArray(event.plants) || event.plants.length > 7 || new Set(event.plants).size !== event.plants.length) return false;
  const plantsRequired = ['hiccup', 'blossom'].includes(schedule.kind), groupRequired = ['meeting', 'parade'].includes(schedule.kind);
  if (groupRequired && event.fishes.length < 3 || plantsRequired !== (event.plants.length > 0)) return false;
  return event.plants.every(id => typeof id === 'string' && id.length <= 200 && (!chars || !!chars[id]?.wild && chars[id].created <= event.at));
}
export function eventMotion(data, fishId, now, context) {
  const event = activeEvent(data, now); if (!event || !['meeting', 'parade'].includes(event.kind) || now - event.started >= 12000 || !event.fishes.includes(fishId)) return null;
  const nearby = new Set((context.neighbors.get(fishId) || []).map(q => q.id));
  if (!event.fishes.every(id => id === fishId || nearby.has(id))) return null;
  return event.kind === 'meeting' ? { dx: 0, dy: 0 } : { dx: event.direction * (now - event.started < 6000 ? 1 : -1), dy: 0 };
}
