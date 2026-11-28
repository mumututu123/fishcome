import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const zig = process.env.ZIG || 'zig';
const version = execFileSync(zig, ['version'], { encoding: 'utf8' }).trim();
const expected = '0.17.0';
if (version !== expected) throw new Error('Use Zig ' + expected + ' to reproduce the checked-in swimming program. Got ' + version);
const temp = mkdtempSync(join(tmpdir(), 'fishcome-swimming-'));
try {
  const output = join(temp, 'swimming.wasm');
  execFileSync(zig, ['cc', '-target', 'wasm32-freestanding', '-O3', '-ffp-contract=off', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--strip-all', '-Wl,--export=swim', '-Wl,--export=swim_one', '-Wl,--export=__heap_base',
    '-o', output, 'native/swimming.c'], { cwd: root, stdio: 'inherit' });
  const encoded = readFileSync(output).toString('base64');
  const sourceHash = createHash('sha256').update(readFileSync(join(root, 'native/swimming.c'), 'utf8').replaceAll('\r\n', '\n')).digest('hex');
  const source = '// Generated from native/swimming.c by scripts/build-swimming.mjs. SHA-256 ' + sourceHash + '\n' +
    "export const swimProgram = new WebAssembly.Module(Uint8Array.from(atob('" + encoded + "'), char => char.charCodeAt(0)));\n";
  const file = join(root, 'www/swim-program.js');
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== source) throw new Error('Rebuild www/swim-program.js');
  } else writeFileSync(file, source);
} finally {
  rmSync(temp, { recursive: true });
}
