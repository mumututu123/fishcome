import { World, CONFIG, clone } from './engine.js';

// Older checkpoints have only at (save time), or tick (last simulation time).
export function restoreCheckpoint(checkpoint, now = Date.now()) {
  const world = new World(now);
  if (!checkpoint?.world) return { world, expired: false };
  const lastOnlineAt = [checkpoint.lastOnlineAt, checkpoint.at, checkpoint.world.tick].find(Number.isFinite);
  const expiresAt = Number.isFinite(lastOnlineAt) ? lastOnlineAt + CONFIG.offlineLife : undefined;
  const expired = !Number.isFinite(expiresAt) || now >= expiresAt;
  if (!expired) { world.data = { ...world.data, ...clone(checkpoint.world) }; world.data.tick = now; }
  else { world.data.chatSources = clone(checkpoint.world.chats || {}); world.reconcileChatFloor(now); }
  return { world, expired, expiresAt };
}
