import { inviteDetails } from './invite.js';

export const REFERRAL_REWARD = 10;
export function referralError(op) {
  if (!/^[0-9a-f]{64}$/.test(op.actor) || !/^[0-9a-f]{64}$/.test(op.inviter) || op.actor === op.inviter || op.id !== `${op.actor}:referral` || op.cost !== 0 || !Number.isFinite(op.registeredAt) || op.registeredAt < 0 || op.registeredAt > op.t || typeof op.invitation !== 'string' || !op.invitation.startsWith('YL1.') || op.invitation.length > 1024 || !Array.isArray(op.roots) || !op.roots.length) return '推广奖励记录无效';
  return '';
}
export async function verifyReferral(op) {
  if (referralError(op)) return false;
  try { const details = await inviteDetails(op.invitation); return !details.actor || details.actor === op.inviter; } catch { return false; }
}
// Copies of one account can connect concurrently. Pick the same first claim in every merge order.
export function chooseReferral(left, right) {
  if (!left) return right;
  const order = left.t - right.t || left.inviter.localeCompare(right.inviter) || left.invitation.localeCompare(right.invitation) || JSON.stringify(left).localeCompare(JSON.stringify(right));
  return order <= 0 ? left : right;
}
