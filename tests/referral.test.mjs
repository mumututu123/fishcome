import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from './empty-world.mjs';
import { encodeInvite, decodeInvite, normalizeInvite, inviteDetails } from '../www/invite.js';
import { verifyReferral } from '../www/referral.js';
import { restoreCheckpoint } from '../www/lifecycle.js';
const inviter = 'a'.repeat(64), recruit = 'b'.repeat(64), other = 'c'.repeat(64), t = Date.now() - 1000;
async function reward(world, actor = recruit, owner = inviter, at = t) { return { id: `${actor}:referral`, kind: 'referral', actor, inviter: owner, nick: '新人', cost: 0, registeredAt: t - 1000, t: at, roots: world.roots, invitation: await encodeInvite('http://127.0.0.1:39241', owner) }; }
test('账号邀请码保留路由并稳定携带发码账号，旧邀请码兼容', async () => {
  const code = await encodeInvite('http://127.0.0.1:39241', inviter);
  assert.equal(await decodeInvite(code), 'http://127.0.0.1:39241'); assert.equal((await inviteDetails(code)).actor, inviter); assert.equal(await normalizeInvite(code), code);
  assert.equal((await inviteDetails(await encodeInvite('http://127.0.0.1:39241'))).actor, undefined);
  await assert.rejects(() => encodeInvite('http://127.0.0.1:39241', 'invalid'));
  await assert.rejects(() => decodeInvite(code.slice(0, -2)));
});
test('一个新账号奖励发码账号10字，新用户仍为20，多新人可累计并消费', async () => {
  const world = new World(t), op = await reward(world); assert(await verifyReferral(op)); assert(world.apply(op).ok);
  assert.equal(world.wallet(inviter), 30); assert.equal(world.wallet(recruit), 20);
  assert(world.apply(await reward(world, other)).ok); assert.equal(world.wallet(inviter), 40);
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 15, y: Math.floor(index / 15), ch: '#', color: '#aabbcc' }));
  assert(world.apply({ id: crypto.randomUUID(), kind: 'scene', actor: inviter, nick: '发码者', cost: 30, cells, x: 10, y: 10, t }).ok); assert.equal(world.wallet(inviter), 10);
});
test('重复提交、恢复、世界合流不重复奖励，奖励可抵扣负余额', async () => {
  const a = new World(t), b = new World(t); const op = await reward(a); a.apply(op); b.apply(op);
  assert(a.apply(op).duplicate); a.merge(b.serialize()); a.merge(b.serialize()); assert.equal(a.wallet(inviter), 30);
  const restored = restoreCheckpoint({ world: a.serialize(), lastOnlineAt: t }, t + 1000); assert.equal(restored.world.wallet(inviter), 30);
  const cells = Array.from({ length: 15 }, (_, x) => ({ x, y: 0, ch: '#', color: '#aabbcc' }));
  for (const world of [a, b]) assert(world.apply({ id: crypto.randomUUID(), kind: 'fish', actor: inviter, nick: '发码者', cost: 15, cells, x: world === a ? 50 : 100, y: 10, t }).ok);
  a.merge(b.serialize()); assert.equal(a.wallet(inviter), 0);
});
test('自邀、错误标识、异常注册时间、费用及不匹配的邀请码不能奖励', async () => {
  const world = new World(t), op = await reward(world);
  for (const changes of [{ inviter: recruit }, { id: crypto.randomUUID() }, { registeredAt: t + 1000 }, { registeredAt: -1 }, { inviter: 'bad' }, { cost: -10 }, { cost: 1 }, { roots: [] }]) assert.equal(world.apply({ ...op, ...changes }).ok, false);
  assert.equal(await verifyReferral({ ...op, inviter: other }), false); assert.equal(await verifyReferral({ ...op, invitation: 'YL1.bad.bad' }), false); assert.equal(world.wallet(inviter), 20);
});
test('同一账号并发归属按首次记录稳定收敛，不能同时奖励两个发码者', async () => {
  const a = new World(t), b = new World(t), first = await reward(a), second = await reward(b, recruit, other, t + 1); a.apply(second); b.apply(first);
  const aa = a.serialize(), bb = b.serialize(); a.merge(bb); b.merge(aa);
  assert.equal(a.wallet(inviter), 30); assert.equal(a.wallet(other), 20); assert.equal(b.wallet(inviter), 30); assert.equal(b.wallet(other), 20);
});
test('世界湮灭后按现有规则重置配额，不把上一轮奖励重复带入新世界', async () => {
  const world = new World(t); world.apply(await reward(world));
  const next = restoreCheckpoint({ world: world.serialize(), lastOnlineAt: t }, t + 240 * 3600000);
  assert(next.expired); assert.equal(next.world.wallet(inviter), 20);
});
