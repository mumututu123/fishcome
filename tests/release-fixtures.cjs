const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { cleanupReleaseFixtures } = require('./release-cleanup.cjs');

const project = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const launcherName = windows ? '鱼来.exe' : 'fishcome';
const launcherPath = process.env.TIDE_TEST_LAUNCHER || path.join(project, 'dist', '鱼来', launcherName);
const assetName = version => `fishcome-${version}-${windows ? 'windows' : 'linux-amd64'}.zip`;

function powershell(args, options) {
  const result = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...args], {
    cwd: project, encoding: 'utf8', windowsHide: true, ...options
  });
  return result.trim();
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(port, expectedVersion, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const body = await res.json();
        if (body.ok && body.version === expectedVersion && body.handoffReady === true) return body;
      }
    } catch { }
    await pause(200);
  }
  throw new Error(`端口 ${port} 上的 ${expectedVersion} 启动器未能在超时内就绪`);
}

async function postLocal(port, token, node, route, payload = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/local/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, node, ...payload }),
    signal: AbortSignal.timeout(30000)
  });
  return { status: res.status, body: await res.json() };
}

function printVersion(exePath) {
  const out = execFileSync(exePath, ['--print-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return JSON.parse(out);
}

function makeZip(zipPath, entries) {
  powershell(['-Command', `
    $ErrorActionPreference = 'Stop'
    $entries = ConvertFrom-Json -InputObject $env:TIDE_FIXTURE_ZIP_ENTRIES
    $archive = [IO.Compression.ZipFile]::Open($env:TIDE_FIXTURE_ZIP, [IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($fixture in $entries) {
        $entry = $archive.CreateEntry($fixture.name)
        if ($fixture.source) { $entry.ExternalAttributes = ([int]0x81ED) -shl 16 }
        $stream = $entry.Open()
        try {
          if ($fixture.source) {
            $file = [IO.File]::OpenRead($fixture.source)
            try { $file.CopyTo($stream) } finally { $file.Dispose() }
          } else {
            $bytes = [Text.Encoding]::UTF8.GetBytes($fixture.text)
            $stream.Write($bytes, 0, $bytes.Length)
          }
        } finally { $stream.Dispose() }
      }
    } finally { $archive.Dispose() }
  `], { env: { ...process.env, TIDE_FIXTURE_ZIP: zipPath, TIDE_FIXTURE_ZIP_ENTRIES: JSON.stringify(entries) } });
}

function unpackZip(file, directory) {
  powershell(['-Command', `
    $ErrorActionPreference = 'Stop'
    [IO.Compression.ZipFile]::ExtractToDirectory($env:TIDE_FIXTURE_ZIP, $env:TIDE_FIXTURE_DESTINATION)
  `], { env: { ...process.env, TIDE_FIXTURE_ZIP: file, TIDE_FIXTURE_DESTINATION: directory } });
}

async function withReleaseFixtures(test) {
  assert(windows || process.platform === 'linux', '发行包验证需要 Windows 或 Linux');
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'fishcome-e2e-'));
  const archivesDir = path.join(root, 'archives');
  const children = [];
  const launches = new Map();
  try {
    fs.mkdirSync(archivesDir);
    await test({ root, archivesDir, buildVersion, startLauncher });
  } finally {
    await cleanupReleaseFixtures({ root, parent, children, launches, launcherName });
  }

  function buildVersion(version, name, source = project) {
    const dir = path.join(root, name);
    const output = path.join(root, `${name}-built`);
    const zip = path.join(archivesDir, assetName(version));
    const env = { ...process.env };
    delete env.GITHUB_ENV;
    powershell(['-File', path.join(source, 'build.ps1'), '-Version', version, '-OutputDirectory', output, '-ArchiveDirectory', archivesDir], { env });
    unpackZip(zip, dir);
    const exe = path.join(dir, launcherName);
    fs.accessSync(exe, fs.constants.X_OK);
    return { dir, zip, exe };
  }

  async function startLauncher(exePath, port, env = {}) {
    const child = spawn(exePath, ['--headless', '--loopback', '--port', String(port)], {
      cwd: path.dirname(exePath), windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, ...env }
    });
    children.push(child);
    launches.set(port, path.dirname(exePath));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
}

module.exports = { assetName, launcherName, launcherPath, availablePort, waitForHealth, postLocal, printVersion, makeZip, unpackZip, withReleaseFixtures };
