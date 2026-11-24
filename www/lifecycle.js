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
  if (!expired) { world.data = { ...world.data, ...clone(checkpoint.world), ecology: checkpoint.world.ecology || newEcology(now, true), terrain: clone(terrainOf(checkpoint.world)) }; world.data.bubbles = mergeBubbles({}, checkpoint.world.bubbles, now, world.data.chars); world.data.bubbleMinute = checkpoint.world.bubbleMinute ?? Math.floor(now / MINUTE); world.data.tick = now; world.initializeTracking(now); }
  else { world.data.chatSources = clone(checkpoint.world.chats || {}); world.reconcileChatFloor(now); }
  return { world, expired, expiresAt };
}
