import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeInvite, decodeInvite, normalizeInvite } from '../www/invite.js';
test('邀请码稳定往返路由，分享文本不含明文IP、协议或端口', async () => {
  for (const url of ['http://192.168.1.20:39241', 'http://10.0.0.5:40000', 'http://127.0.0.1:39341', 'http://[::1]:39341', 'http://colleague.local:39241']) {
    const code = await encodeInvite(url); assert(code.startsWith('YL1.')); assert(!code.includes(new URL(url).hostname)); assert(!code.includes('http://')); assert.equal(await decodeInvite(code), new URL(url).origin); assert.equal(await encodeInvite(url), code);
  }
});
test('旧地址、末尾斜线、大小写域名与换行复制统一为同一个邀请码', async () => {
  const code = await encodeInvite('http://colleague.local:39241'); assert.equal(await normalizeInvite(' http://COLLEAGUE.local:39241/ '), code); assert.equal(await normalizeInvite(code.slice(0, 12) + '\n' + code.slice(12)), code);
});
test('损坏、截断、错误版本、校验失败的邀请码拒绝，不降级成请求地址', async () => {
  const code = await encodeInvite('http://127.0.0.1:39341');
  for (const bad of ['', 'YL1.', code.slice(0, -1), code.replace('YL1.', 'YL2.'), code.slice(0, -1) + (code.at(-1) === 'A' ? 'B' : 'A'), 'YL1.%%%.$$', 'YL1.' + 'A'.repeat(1100)]) await assert.rejects(() => decodeInvite(bad), /邀请码/);
});
test('路由格式不接受凭据、其他协议、缺失端口或非法端口', async () => {
  for (const value of ['https://192.168.1.20:39241', 'http://u:p@192.168.1.20:39241', 'http://192.168.1.20', 'file:///C:/test', 'http://192.168.1.20:80', 'http://192.168.1.20:65536', '不是邀请码']) await assert.rejects(() => normalizeInvite(value), /邀请码/);
});
