// Single source of truth for multiplayer world rules. build.ps1 parses the JSON literal inside Object.freeze(...).
export const WORLD_RULES = Object.freeze({
  "genesis": 1,
  "life": 4,
  "legends": 1,
  "feeding": 1,
  "ecology": 1,
  "population": 2,
  "archives": 1
});

export const RULES_VERSION = Object.values(WORLD_RULES).join('.');

export function rulesCompatible(other) {
  if (!other || typeof other !== 'object' || Array.isArray(other)) return false;
  const ownKeys = Object.keys(WORLD_RULES);
  const otherKeys = Object.keys(other);
  if (ownKeys.length !== otherKeys.length) return false;
  for (const key of ownKeys) {
    if (!Object.prototype.hasOwnProperty.call(other, key) || other[key] !== WORLD_RULES[key]) return false;
  }
  return true;
}
