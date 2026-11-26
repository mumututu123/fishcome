import { World, CONFIG, clone } from './engine.js';
import { terrainOf } from './geography.js';
import { MINUTE, mergeBubbles } from './bubbles.js';
import { newEcology } from './ecology.js';

// Older checkpoints have only at (save time), or tick (last simulation time).
export function restoreCheckpoint(checkpoint, now = Date.now()) {
  if (!checkpoint?.world) return { world: new World(now), expired: false };
  const lastOnlineAt = [checkpoint.lastOnlineAt, checkpoint.at, checkpoint.world.tick].find(Number.isFinite);
  const expiresAt = Number.isFinite(lastOnlineAt) ? lastOnlineAt + CONFIG.offlineLife : undefined;
  const expired = !Number.isFinite(expiresAt) || now >= expiresAt;
  const world = new World(now, undefined, { populate: expired });
  if (!expired) { world.data = { ...world.data, ...clone(checkpoint.world), ecology: checkpoint.world.ecology || newEcology(now, true), terrain: clone(terrainOf(checkpoint.world)) }; if (!checkpoint.world.ecology) for (const c of Object.values(world.data.chars)) if (c.kind === 'seaweed' && c.created < now && c.ecoGraceAt === undefined) c.ecoGraceAt = now; world.data.bubbles = mergeBubbles({}, checkpoint.world.bubbles, now, world.data.chars); world.data.bubbleMinute = checkpoint.world.bubbleMinute ?? Math.floor(now / MINUTE); world.data.tick = now; world.initializeTracking(now); }
  else { world.data.chatSources = clone(checkpoint.world.chats || {}); world.reconcileChatFloor(now); }
  if (!expired) world.resolveLegends(now);
  if (!expired) world.resolvePopulation(now);
  return { world, expired, expiresAt };
}
