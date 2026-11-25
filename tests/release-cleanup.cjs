const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

const windows = process.platform === 'win32';

function runPowerShell(command, env) {
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, stdio: 'pipe', env: { ...process.env, ...env }
  }).trim();
}

function windowsUpdateOwners(launches) {
  const owners = {};
  for (const [port, directory] of launches) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.update-[a-f0-9]{32}$/.test(entry.name)) continue;
      let pid;
      try {
        pid = Number(fs.readFileSync(path.join(directory, entry.name, '.owner'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Number.isSafeInteger(pid) && pid > 0) (owners[port] ||= []).push(pid);
    }
  }
  return owners;
}

function runningLaunchers(root, launches, launcherName) {
  if (windows) {
    const output = runPowerShell(`
      $prefix = $env:TIDE_FIXTURE_ROOT + [IO.Path]::DirectorySeparatorChar
      foreach ($proc in (Get-Process -ErrorAction Stop | Where-Object ProcessName -EQ $env:TIDE_FIXTURE_PROCESS)) {
        if ($proc.Path -and $proc.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $proc.Id }
      }
      $owners = ConvertFrom-Json -AsHashtable -InputObject $env:TIDE_FIXTURE_OWNERS
      if ($owners.Count -gt 0) {
        foreach ($listener in (Get-NetTCPConnection -ErrorAction Stop)) {
          if ($listener.State -ne 'Listen' -or $listener.LocalAddress -ne '127.0.0.1') { continue }
          $recorded = $owners[[string]$listener.LocalPort]
          if ($recorded -contains $listener.OwningProcess) { $listener.OwningProcess }
        }
      }
    `, {
      TIDE_FIXTURE_ROOT: root,
      TIDE_FIXTURE_PROCESS: path.parse(launcherName).name,
      TIDE_FIXTURE_OWNERS: JSON.stringify(windowsUpdateOwners(launches))
    });
    return output ? [...new Set(output.split(/\s+/).map(Number))] : [];
  }
  return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`);
      if (exe.startsWith(root + path.sep) && path.basename(exe.replace(/ \(deleted\)$/, '')) === launcherName) return [Number(pid)];
    } catch { }
    return [];
  });
}

async function cleanupReleaseFixtures({ root, parent, children, launches, launcherName }) {
  await Promise.all(children.map(async child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    child.kill();
    await exited;
  }));
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), parent);
  assert.match(path.basename(root), /^fishcome-e2e-[a-z0-9]+$/i);
  const deadline = Date.now() + 10000;
  for (;;) {
    const pids = runningLaunchers(root, launches, launcherName);
    for (const pid of pids) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!pids.length) {
      if (!windows) {
        fs.rmSync(root, { recursive: true });
        break;
      }
      try {
        runPowerShell(`
          $ErrorActionPreference = 'Stop'
          try {
            Remove-Item -LiteralPath $env:TIDE_FIXTURE_ROOT -Recurse
          } catch [System.IO.IOException], [System.UnauthorizedAccessException] {
            if (Test-Path -LiteralPath $env:TIDE_FIXTURE_ROOT) {
              Write-Error $_ -ErrorAction Continue
              exit 23
            }
          }
        `, { TIDE_FIXTURE_ROOT: root });
        break;
      } catch (error) {
        if (error.status !== 23 || Date.now() >= deadline) throw error;
      }
    } else if (Date.now() >= deadline) {
      throw new Error(`测试启动器退出超时，目录 ${root}`);
    }
    await pause(200);
  }
}

module.exports = { cleanupReleaseFixtures };
