export const DAY = 24 * 60 * 60 * 1000;
export const MEAL_INTERVAL = 60 * 60 * 1000;
// Creation/birth sets lastFed for hunger, but is not a meal.
export function lastMealAt(fish, recorded) {
  let latest = Number.isFinite(recorded) ? recorded : -Infinity;
  if (Number.isFinite(fish.lastMealAt)) latest = Math.max(latest, fish.lastMealAt);
  if (Number.isFinite(fish.lastFed) && fish.lastFed > fish.created) latest = Math.max(latest, fish.lastFed);
  return latest === -Infinity ? undefined : latest;
}
export function feedingStatus(fish, now, recorded) {
  const last = lastMealAt(fish, recorded), nextMealAt = last === undefined ? undefined : last + MEAL_INTERVAL;
  return { lastMealAt: last, nextMealAt, canEat: nextMealAt === undefined || now >= nextMealAt };
}
export function shanghaiDay(now) { return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function validMovementDay(day) {
  if (day.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const month = Number(day.slice(5, 7)), date = Number(day.slice(8, 10));
  if (!date || month < 1 || month > 12) return false;
  if (month === 2 && date === 29) {
    const year = Number(day.slice(0, 4));
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }
  return date <= daysInMonth[month - 1];
}
function validTravelDays(days) {
  for (const day in days) if (Object.hasOwn(days, day)) {
    const distance = days[day];
    if (!Number.isFinite(distance) || distance < 0 || !validMovementDay(day)) return false;
  }
  return true;
}
export function validTravel(record) {
  return record && Number.isFinite(record.since) && record.since >= 0 && record.days && typeof record.days === 'object' && !Array.isArray(record.days) && validTravelDays(record.days);
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
  const eaten = upperBound(meals, now), feeding = feedingStatus(fish, now, eaten ? meals[eaten - 1] : undefined);
  return { day, movement: travel?.days[day] || 0, meals24: eaten - upperBound(meals, now - DAY), hungry: now - lastFed >= DAY, hoursSinceFed: Math.max(0, (now - lastFed) / 3600000), neverFed: feeding.lastMealAt === undefined, ...feeding, trackedSince: travel?.since, partialMovement: !!travel && travel.since > fish.created };
}
