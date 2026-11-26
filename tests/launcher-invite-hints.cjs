const { spawn } = require('node:child_process');
const { launcherPath } = require('./release-fixtures.cjs');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:39345';
const child = spawn(launcherPath, ['--headless', '--loopback', '--port', '39345'], { windowsHide: true, stdio: 'ignore' });
const events = new AbortController();
async function main() {
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(origin + '/health')).ok) break; } catch {} if (Date.now() > deadline) throw new Error('启动器未就绪'); await new Promise(resolve => setTimeout(resolve, 100)); }
  const meta = await (await fetch(origin + '/local/meta')).json(), node = crypto.randomUUID();
  async function post(route, data) { const response = await fetch(origin + '/local/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: meta.token, node, ...data }) }); assert(response.ok); return response.json(); }
  await post('register', { nick: 'hint-test' });
  const stream = await fetch(origin + `/local/events?node=${node}&token=${encodeURIComponent(meta.token)}`, { signal: AbortSignal.any([events.signal, AbortSignal.timeout(5000)]) });
  const first = await stream.body.getReader().read();
  assert(new TextDecoder().decode(first.value).startsWith(': ready\n\n'), '信令流必须立即发送就绪正文，不等待15秒心跳');
  await post('presence', { peers: 1, hints: [{ id: 'neighbor', url: meta.url }] });
  const status = await (await fetch(origin + '/status')).json(); assert.equal(status.clients.length, 1); assert.equal(status.clients[0].peers, 1); assert.equal(status.hints.length, 1, '邻居数组必须被本地启动器保存'); assert.equal(status.hints[0].url, meta.url);
  console.log('原生启动器接收并传播非明文邻居邀请码通过');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { events.abort(); child.kill(); });
