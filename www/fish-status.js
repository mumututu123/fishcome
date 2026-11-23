export const DAY = 24 * 60 * 60 * 1000;
export function shanghaiDay(now) { return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
export function validTravel(record) {
  return record && Number.isFinite(record.since) && record.since >= 0 && record.days && typeof record.days === 'object' && !Array.isArray(record.days) && Object.entries(record.days).every(([day, distance]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day && Number.isFinite(distance) && distance >= 0);
}
export function mergeTravel(left, right) {
  if (!validTravel(right)) throw new Error('鱼运动记录无效');
  if (!left) return structuredClone(right);
  const days = { ...left.days }; for (const [day, distance] of Object.entries(right.days)) days[day] = Math.max(days[day] || 0, distance);
  return { since: Math.min(left.since, right.since), days };
}
export function mealIndex(chars, now) {
  const fish = new Map(), seen = new Set();
  for (const cell of Object.values(chars)) for (const [index, event] of (cell.path || []).entries()) {
    if (event.reason !== 'eat' || !event.target || !Number.isFinite(event.t) || event.t <= now - DAY) continue;
    const id = `${event.target}:${event.id || `${cell.id}:${index}`}`; if (seen.has(id)) continue; seen.add(id);
    if (!fish.has(event.target)) fish.set(event.target, []); fish.get(event.target).push(event.t);
  }
  for (const times of fish.values()) times.sort((a, b) => a - b); return fish;
}
function upperBound(times, value) { let low = 0, high = times.length; while (low < high) { const mid = (low + high) >>> 1; if (times[mid] <= value) low = mid + 1; else high = mid; } return low; }
export function fishStatus(fish, travel, meals = [], now = Date.now()) {
  const lastFed = Number.isFinite(fish.lastFed) ? fish.lastFed : fish.created, day = shanghaiDay(now);
  return { day, movement: travel?.days[day] || 0, meals24: upperBound(meals, now) - upperBound(meals, now - DAY), hungry: now - lastFed >= DAY, hoursSinceFed: Math.max(0, (now - lastFed) / 3600000), neverFed: lastFed <= fish.created && !meals.length, trackedSince: travel?.since, partialMovement: !!travel && travel.since > fish.created };
}
