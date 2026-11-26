export const PAGE_HEAD = 'checkpoint-head';
const META = ['identity', 'histories', 'known'];
const BRANCH = 'checkpoint-old-version';
const branchRange = () => IDBKeyRange.bound([BRANCH], [BRANCH, []]);
export const currentKey = name => META.includes(name) ? ['checkpoint-meta', name] : name;

function legacyStamp(checkpoint) {
  return JSON.stringify([checkpoint?.at, checkpoint?.lastOnlineAt, checkpoint?.world?.tick, Object.keys(checkpoint?.world?.roots || {})]);
}
export const compatibilityMark = (checkpoint, token) => ({ token, stamp: legacyStamp(checkpoint) });
const diverged = (head, old) => !!old?.world && !!head?.legacy && (
  old.pagedBase !== head.legacy.token || legacyStamp(old) !== head.legacy.stamp
);

// All four legacy keys are read in the same transaction. An old application's
// identity belongs with its own world, including when it imported a backup.
export function readOldBundle(store, ready) {
  const bundle = { format: 'tide-backup-1' };
  const names = ['checkpoint', ...META];
  let left = names.length;
  for (const name of names) {
    const request = store.get(name);
    request.onsuccess = () => { bundle[name] = request.result; if (!--left) ready(bundle); };
  }
}

export function preserveOldBranch(store, head, bundle) {
  if (diverged(head, bundle.checkpoint)) store.put(bundle, [BRANCH, (bundle.checkpoint.at || Date.now()) + '-' + crypto.randomUUID()]);
}

export function mirrorOldVersion(store, head, checkpoint) {
  // Called at creation, deliberate import and hot-update cutover only.
  store.put({ ...checkpoint, pagedBase: head.legacy.token }, 'checkpoint');
  for (const name of META) {
    const value = store.get(currentKey(name));
    value.onsuccess = () => { if (value.result !== undefined) store.put(value.result, name); };
  }
}

export function legacyBranches(store, ready) {
  const head = store.get(PAGE_HEAD);
  head.onsuccess = () => {
    const keys = store.getAllKeys(branchRange());
    keys.onsuccess = () => {
      const branches = keys.result.map(([, id]) => ({ id, at: Number(id.split('-')[0]) }));
      if (!head.result?.legacy) { ready(branches); return; }
      const raw = store.get('checkpoint');
      raw.onsuccess = () => { if (diverged(head.result, raw.result)) branches.push({ id: 'live', at: raw.result.at }); ready(branches); };
    };
  };
}

export function oldBranch(store, id, ready) {
  if (id === 'live') {
    const head = store.get(PAGE_HEAD);
    head.onsuccess = () => readOldBundle(store, bundle => ready(diverged(head.result, bundle.checkpoint) ? bundle : undefined));
  } else {
    const request = store.get([BRANCH, id]);
    request.onsuccess = () => ready(request.result);
  }
}
