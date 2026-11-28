import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderInbox } from '../www/render-inbox.js';

function inbox() {
  const applied = [], prepared = [];
  const queue = new RenderInbox((update, stage) => applied.push([update, stage]), raw => {
    prepared.push(raw);
    return { raw };
  });
  queue.reset(1);
  function offer(id, generation = 1) {
    const port = { close() { this.closed = true; } };
    queue.offer({ id, generation, port, stableRoster: true });
    return { get closed() { return port.closed; }, send(raw) { port.onmessage?.({ data: raw }); } };
  }
  return { queue, applied, prepared, offer };
}

test('a prepared step remains private until its ordered page permission', () => {
  const { queue, applied, prepared, offer } = inbox();
  offer(1).send('future');
  assert.deepEqual(applied, []);
  assert.deepEqual(prepared, ['future']);
  queue.update({ generation: 1, permit: 1, startedAt: 25 });
  assert.deepEqual(applied, [[{ generation: 1, changes: 'future', startedAt: 25 }, { raw: 'future' }]]);
});

test('a pending permission serializes later edits, and invalidates preparations across changes', () => {
  const { queue, applied, offer } = inbox();
  const first = offer(1);
  queue.update({ generation: 1, permit: 1 });
  queue.update({ generation: 1, changes: 'food' });
  offer(2).send('second');
  queue.update({ generation: 1, permit: 2 });
  assert.deepEqual(applied, []);
  first.send('first');
  assert.deepEqual(applied, [
    [{ generation: 1, changes: 'first' }, { raw: 'first' }],
    [{ generation: 1, changes: 'food' }, undefined],
    [{ generation: 1, changes: 'second' }, undefined],
  ]);

  offer(3).send('third');
  queue.update({ generation: 1, changes: 'input' });
  queue.update({ generation: 1, permit: 3 });
  assert.deepEqual(applied.at(-1), [{ generation: 1, changes: 'third' }, undefined]);
});

test('input cancellation and new generations discard unconfirmed positions', () => {
  const { queue, applied, offer } = inbox();
  offer(1).send('rejected');
  queue.cancel(1);
  const old = offer(2);
  queue.update({ generation: 1, permit: 2 });
  queue.reset(2);
  assert.ok(old.closed);
  old.send('retired');
  queue.update({ generation: 1, permit: 1 });
  offer(3, 2).send('current');
  queue.update({ generation: 2, permit: 3 });
  assert.deepEqual(applied, [[{ generation: 2, changes: 'current' }, { raw: 'current' }]]);
});
