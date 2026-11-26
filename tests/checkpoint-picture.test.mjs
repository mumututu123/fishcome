import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, World } from '../www/engine.js';
import { CheckpointPictures } from '../www/checkpoint-picture.js';

const makeWorld = id => new World(0, id, { populate: false, ambient: false });
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
test('编码期间合流或更换世界，两次并发存档都取得新世界的新合影', async () => {
  for (const replace of [false, true]) {
    let world = makeWorld('A'), renders = 0;
    world.data.fishes.one = {};
    const started = gate(), finish = gate();
    const pictures = new CheckpointPictures(() => world, async target => {
      const label = 'image:' + target.roots.join() + ':' + Object.keys(target.data.fishes).length;
      if (++renders === 1) { started.release(); await finish.promise; }
      return label;
    });
    const first = pictures.prepare(true);
    await started.promise;
    const concurrent = pictures.prepare();
    if (replace) world = makeWorld('B');
    else {
      pictures.changed(world, null);
      world.data.roots.B = 0;
    }
    world.data.fishes.two = {};
    world.data.participants = { p: '甲', q: '乙' };
    finish.release();
    for (const prepared of await Promise.all([first, concurrent])) {
      const photo = pictures.atCut(prepared);
      assert.deepEqual(photo.roots, world.roots);
      assert.equal(photo.participants, 2);
      assert.deepEqual(photo.counts, world.counts());
      assert.equal(photo.image, 'image:' + world.roots.join() + ':' + world.counts().fish);
    }
    assert.equal(renders, 2);
    const prepared = await pictures.prepare();
    pictures.changed(world, null);
    assert.equal(pictures.atCut(prepared), undefined, '等候存档事务时的更改使旧照片失效');
  }
});
test('持续自然步进只编码一次，统计跟随出生、移除、食物过期和写入时刻', async () => {
  const world = makeWorld('A'), started = gate(), finish = gate();
  world.data.chars.food = { kind: 'food', born: 0 };
  world.data.chars.body = { kind: 'fish' };
  world.data.fishes.one = {};
  let renders = 0;
  const pictures = new CheckpointPictures(() => world, async () => {
    renders++; started.release(); await finish.promise; return 'image';
  });
  const pending = pictures.prepare();
  await started.promise;
  function apply(tables, tick) {
    pictures.beforePatch(world, { tables });
    for (const [field, edits] of Object.entries(tables)) {
      for (const id of edits.remove) delete world.data[field][id];
      for (const [id, row] of edits.set) world.data[field][id] = row;
    }
    world.data.tick = tick;
    pictures.changed(world, { tables });
  }
  for (let tick = 1; tick < 10; tick++) {
    apply({ fishes: { set: [['one', { x: tick }]], remove: [], addedCount: 0, removedCount: 0 } }, tick);
  }
  apply({ fishes: { set: [['two', {}]], remove: [], addedCount: 1, removedCount: 0 },
    chars: { set: [['born', { kind: 'fish' }], ['body', { kind: 'burn' }]], remove: [] } }, CONFIG.foodLife);
  finish.release();
  const prepared = await pending;
  assert.equal(renders, 1);
  assert.deepEqual(pictures.atCut(prepared).counts, world.counts());
  apply({ chars: { set: [['fresh', { kind: 'food', born: CONFIG.foodLife }]], remove: ['born'] },
    fishes: { set: [], remove: ['two'], addedCount: 0, removedCount: 1 } }, CONFIG.foodLife + 1);
  assert.deepEqual(pictures.atCut(prepared).counts, world.counts());
});

test('分批统计期间删除已读和未读字符，同时补入食物，最后数量准确', async t => {
  let timer = 0;
  t.mock.method(performance, 'now', () => { timer += 6; return timer; });
  const world = makeWorld('A');
  for (let i = 0; i < 1200; i++) world.data.chars[i] = { kind: 'fish' };
  let renders = 0;
  const pictures = new CheckpointPictures(() => world, async () => String(++renders));
  const task = pictures.prepare();
  const charPatch = { tables: { chars: { set: [['fresh', { kind: 'food', born: 0 }]], remove: ['10', '900'] } } };
  pictures.beforePatch(world, charPatch);
  delete world.data.chars['10']; delete world.data.chars['900'];
  world.data.chars.fresh = charPatch.tables.chars.set[0][1];
  pictures.changed(world, charPatch);
  const photo = pictures.atCut(await task);
  assert.deepEqual(photo.counts, world.counts());
  assert.equal(renders, 1);
});
test('合影编码期间投食会重拍，昵称更新只需刷新元数据', async () => {
  const world = makeWorld('A'), started = gate(), finish = gate();
  let renders = 0;
  const pictures = new CheckpointPictures(() => world, async () => {
    const label = Object.keys(world.data.chars).join();
    if (++renders === 1) { started.release(); await finish.promise; }
    return label;
  });
  const task = pictures.prepare(true);
  await started.promise;
  const input = { tables: { chars: { set: [['feed', { kind: 'food', born: 0 }]], remove: [] } } };
  pictures.beforePatch(world, input);
  world.data.chars.feed = input.tables.chars.set[0][1];
  pictures.changed(world, input, 'input');
  finish.release();
  const prepared = await task;
  assert.equal(prepared.picture.image, 'feed');
  assert.equal(renders, 2);
  world.data.participants = { a: '甲', b: '乙' };
  pictures.changed(world, { tables: { participants: {} } }, 'input');
  assert.equal(pictures.atCut(prepared).participants, 2);
});
