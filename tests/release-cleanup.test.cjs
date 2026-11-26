const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { cleanupReleaseFixtures } = require('./release-cleanup.cjs');

const windows = process.platform === 'win32';
const windowsOnly = { skip: !windows };

function createFixtures(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'fishcome-e2e-'));
  const listeners = [];
  t.after(async () => {
    for (const { child } of listeners) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(listeners.map(({ exited }) => exited));
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^fishcome-e2e-[a-z0-9]+$/i);
    if (fs.existsSync(root)) {
      assert.equal(fs.realpathSync(root), root);
      if (windows) {
        execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference = 'Stop'; Remove-Item -LiteralPath $env:TIDE_CLEANUP_TEST_ROOT -Recurse"], {
          env: { ...process.env, TIDE_CLEANUP_TEST_ROOT: root }, windowsHide: true
        });
      } else {
        fs.rmSync(root, { recursive: true });
      }
    }
  });
  const launcherName = path.basename(root) + (windows ? '.exe' : '');
  return { parent, root, launcherName, children: [], launches: new Map(), listeners };
}

async function startListener(fixtures, executable = process.execPath) {
  const child = spawn(executable, ['-e', `
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  fixtures.listeners.push({ child, exited });
  const [data] = await Promise.race([
    once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
    exited.then(() => { throw new Error('测试进程在监听端口前退出'); })
  ]);
  const port = Number(data.toString());
  assert(Number.isInteger(port) && port > 0 && port <= 65535);
  return { child, port };
}

function recordOwner(root, suffix, pid) {
  const stage = path.join(root, `.update-${suffix.repeat(32)}`);
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, '.owner'), String(pid));
}

test('没有残留启动器时清理成功', async t => {
  const fixtures = createFixtures(t);
  await cleanupReleaseFixtures(fixtures);
  assert.equal(fs.existsSync(fixtures.root), false);
});

test('清理会等待仍在运行的测试子进程退出', async t => {
  const fixtures = createFixtures(t);
  const { child } = await startListener(fixtures);
  fixtures.children.push(child);

  await cleanupReleaseFixtures(fixtures);

  assert(child.exitCode !== null || child.signalCode !== null);
  assert.equal(fs.existsSync(fixtures.root), false);
});

test('回收在测试目录运行、未被直接跟踪的启动器', async t => {
  const fixtures = createFixtures(t);
  const executable = path.join(fixtures.root, fixtures.launcherName);
  fs.copyFileSync(process.execPath, executable);
  const { child } = await startListener(fixtures, executable);

  await cleanupReleaseFixtures(fixtures);

  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(fixtures.root), false);
});

test('Windows 按更新记录和端口回收未被直接跟踪的接管进程', windowsOnly, async t => {
  const fixtures = createFixtures(t);
  const { child, port } = await startListener(fixtures);
  recordOwner(fixtures.root, 'a', child.pid);
  fixtures.launches.set(port, fixtures.root);

  await cleanupReleaseFixtures(fixtures);

  // This is not a child from cleanup's point of view, so Node may deliver its exit event later.
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(fixtures.root), false);
});

test('Windows 不回收仅出现在更新记录、未监听该测试端口的进程', windowsOnly, async t => {
  const fixtures = createFixtures(t);
  const { port } = await startListener(fixtures);
  const { child } = await startListener(fixtures);
  recordOwner(fixtures.root, 'b', child.pid);
  fixtures.launches.set(port, fixtures.root);

  await cleanupReleaseFixtures(fixtures);

  assert.equal(process.kill(child.pid, 0), true);
  assert.equal(fs.existsSync(fixtures.root), false);
});
