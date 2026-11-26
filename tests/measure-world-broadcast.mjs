import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WorldBroadcast } from '../www/world-broadcast.js';

export async function measureWorldBroadcast(data) {
  const channel = new WorldBroadcast();
  const network = { live: () => [1], broadcast: (kind, body) => body };
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const results = {};
  for (const [name, now] of [['full', data.tick], ['delta', data.tick + 1000]]) {
    const packet = await channel.send(network, data, now);
    assert.equal(packet.delta, name === 'delta');
    const expected = Object.values(data.breeding).filter(record => name === 'full' || record.status === 'active');
    assert.deepEqual(Object.keys(packet.world.breeding).sort(), expected.map(record => record.id).sort());
    results[name] = { records: expected.length, breeding_json_bytes: bytes(packet.world.breeding), body_json_bytes: bytes(packet) };
  }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const file = process.argv[2];
  assert(file, '用法：node tests/measure-world-broadcast.mjs 快照或备份.json');
  const input = JSON.parse(await readFile(file, 'utf8'));
  console.log(JSON.stringify(await measureWorldBroadcast(input.checkpoint?.world ?? input.world ?? input), null, 2));
}
