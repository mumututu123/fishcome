import { beginCheckpoint, checkpointChanged, checkpointCommitted, pagedRevision, readCheckpoint } from './checkpoint-pages.js';
export { atCheckpointBoundary } from './checkpoint-pages.js';
import { PAGE_HEAD, currentKey, migrateOldMetadata, readOldBundle, oldBranch } from './legacy-checkpoint.js';

const DATABASE = 'tide-world-v1';
let opening;
let restoringBackup = false;
const snapshotRevisions = new WeakMap();
export function database() { return opening ||= new Promise((resolve, reject) => { const r = indexedDB.open(DATABASE, 1); r.onupgradeneeded = () => r.result.createObjectStore('items'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
export async function getMany(names, { observeCheckpoint = true } = {}) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items'), store = tx.objectStore('items'), values = [];
    tx.oncomplete = () => resolve(values);
    tx.onabort = () => reject(tx.error || new Error('本地存档读取被中止'));
    names.forEach((name, i) => {
      const key = name === 'checkpoint' ? PAGE_HEAD : currentKey(name);
      const receive = raw => {
        if (name !== 'checkpoint') { values[i] = raw; return; }
        readCheckpoint(store, raw, value => {
          if (value && typeof value === 'object') snapshotRevisions.set(value, pagedRevision(raw) ?? null);
          values[i] = value;
        }, reject, observeCheckpoint);
      };
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result === undefined && name !== key) {
          const old = store.get(name);
          old.onsuccess = () => receive(old.result);
        } else receive(request.result);
      };
    });
  });
}
export async function get(name, options) { return (await getMany([name], options))[0]; }
// Live diagnostics already have a world snapshot. Only a legacy save without
// a page revision needs a full read for the later compare-and-swap.
export async function readCheckpointVersion() {
  const revision = pagedRevision(await get(PAGE_HEAD));
  if (revision === undefined) return (await get('checkpoint', { observeCheckpoint: false })) ?? null;
  const version = { revision };
  snapshotRevisions.set(version, revision);
  return version;
}
export function sameStoredCheckpoint(a, b) {
  const first = snapshotRevisions.get(a), second = snapshotRevisions.get(b);
  if (first != null || second != null) return first === second;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
export function set(name, value) { return putMany([[name, value]]); }
// The update handoff must merge one coherent checkpoint and its account
// metadata before a compare-and-swap against this exact revision.
export async function readHandoffCheckpoint() {
  const [checkpoint, identity, histories, known, generation = 0] = await getMany(
    ['checkpoint', 'identity', 'histories', 'known', 'saveGeneration'], { observeCheckpoint: false });
  const revision = snapshotRevisions.get(checkpoint);
  if (!revision) throw new Error('本地存档已更换，请重新打开游戏。');
  return { checkpoint, identity, histories, known, revision, generation };
}
export const LEGACY_NOTICE_SEEN = 'legacy-progress-notice-seen';
export async function claimLegacyNotice() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite'), store = tx.objectStore('items');
    const request = store.get(LEGACY_NOTICE_SEEN);
    request.onsuccess = () => { if (request.result === undefined) store.put(true, LEGACY_NOTICE_SEEN); };
    tx.oncomplete = () => resolve(request.result === undefined);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getOldBranch(id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items'); tx.onabort = () => reject(tx.error || new Error('旧版存档读取被中止'));
    oldBranch(tx.objectStore('items'), id, resolve);
  });
}
export async function putMany(source, options) {
  for (;;) {
    if (restoringBackup) throw new Error('正在载入备份');
    try { return await writeEntries(source, options); }
    catch (error) { if (error !== checkpointChanged) throw error; }
  }
}

// The old page can still receive pagehide, timer or network callbacks after
// import. Once this transaction commits only the newly loaded page may save.
export async function replaceFromBackup(entries, options = {}) {
  if (restoringBackup) throw new Error('正在载入备份');
  restoringBackup = true;
  try { await writeEntries(entries, { ...options, immutableSource: true, mirrorLegacy: true }); }
  catch (error) { restoringBackup = false; throw error; }
}

async function writeEntries(source, options = {}) {
  const db = await database();
  const signal = options.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    const store = tx.objectStore('items');
    let cache, failure, captured, snapshotOnly, writingCheckpoint = false;
    const cancel = () => {
      try { tx.abort(); failure = signal.reason; }
      catch (error) { if (error.name !== 'InvalidStateError') throw error; } // Already committing.
    };
    signal?.addEventListener('abort', cancel, { once: true });
    tx.oncomplete = () => {
      signal?.removeEventListener('abort', cancel);
      if (writingCheckpoint) checkpointCommitted(cache);
      resolve(captured);
    };
    tx.onabort = () => {
      signal?.removeEventListener('abort', cancel);
      if (snapshotOnly) { resolve(captured); return; }
      if (writingCheckpoint) checkpointCommitted(null);
      reject(failure || tx.error || new Error('本地存档写入被中止'));
    };
    const abort = error => { if (!failure) { failure = error; tx.abort(); } };
    const write = (prior, legacyBundle) => {
      try {
        const entries = typeof source === 'function' ? source() : source;
        for (const [name, value] of new Map(entries)) {
          if (name === 'checkpoint') {
            writingCheckpoint = true;
            // Caller-supplied snapshots without a mutation journal may be reused immediately.
            const snapshot = options.simulationChanges || options.immutableSource ? value : structuredClone(value);
            beginCheckpoint(store, prior, snapshot, { ...options, legacyBundle }, (result, data, discard) => {
              cache = result; captured = data;
              if (discard) { snapshotOnly = true; tx.abort(); }
            }, abort);
            if (snapshotOnly || failure) return;
          } else store.put(value, currentKey(name));
        }
        if (options.replace && options.generation !== undefined) store.put(options.generation + 1, currentKey('saveGeneration'));
      } catch (error) { abort(error); }
    };
    const verifyPrior = (prior, ready) => {
      if (options.checkpoint === undefined) { ready(); return; }
      const expected = snapshotRevisions.get(options.checkpoint), revision = pagedRevision(prior);
      const checked = matches => matches ? ready() : abort(new Error('扫描后存档已更新，请重新扫描'));
      if (expected != null || (expected === null && revision !== undefined)) checked(expected === revision);
      else readCheckpoint(store, prior, current => {
        try { checked(JSON.stringify(current ?? null) === JSON.stringify(options.checkpoint)); }
        catch (error) { abort(error); }
      }, abort, false);
    };
    const proceed = () => {
      if (options.checkpoint === undefined && typeof source !== 'function' && !source.some(([name]) => name === 'checkpoint')) {
        write(); return;
      }
      const head = store.get(PAGE_HEAD);
      head.onsuccess = () => {
        if (head.result && !options.mirrorLegacy) verifyPrior(head.result, () => write(head.result));
        else readOldBundle(store, bundle => {
          const prior = head.result ?? bundle.checkpoint;
          verifyPrior(prior, () => migrateOldMetadata(store, bundle, () => write(prior, bundle)));
        });
      };
    };
    if (options.generation === undefined) { proceed(); return; }
    const check = store.get(currentKey('saveGeneration'));
    check.onsuccess = () => {
      if ((check.result ?? 0) !== options.generation) abort(new Error('存档已在其他页面更换，请刷新后再试'));
      else if (options.registerIdentity) {
        const legacy = store.count('identity'), current = store.count(currentKey('identity'));
        current.onsuccess = () => {
          if (legacy.result || current.result) abort(new Error('其他页面已建立身份，请刷新后继续'));
          else proceed();
        };
      }
      else proceed();
    };
  });
}
export function download(name, data) { const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }

const enc = new TextEncoder();
const actorHashes = new Map();
export async function actorId(jwk) { const text = `${jwk.crv}:${jwk.x}:${jwk.y}`; if (actorHashes.has(text)) return actorHashes.get(text); const bytes = await crypto.subtle.digest('SHA-256', enc.encode(text)); const id = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); actorHashes.set(text, id); return id; }
export async function newIdentity(nick, generation) { const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); const pub = await crypto.subtle.exportKey('jwk', pair.publicKey), secret = await crypto.subtle.exportKey('jwk', pair.privateKey); const identity = { nick, pub, secret, actor: await actorId(pub), remainder: 0, serial: 0, registration: { at: Date.now(), joined: false } }; await putMany([['identity', identity]], { generation, registerIdentity: generation !== undefined }); return identity; }
export async function signer(identity) {
  const key = await crypto.subtle.importKey('jwk', identity.secret, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  async function signBytes(bytes) {
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes);
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }
  return Object.assign(value => signBytes(enc.encode(JSON.stringify(value))), { bytes: signBytes });
}
const keys = new Map();
export async function verifyEnvelope(message) {
  if (typeof message?.actor !== 'string' || message.from?.slice(0, 16) !== message.actor.slice(0, 16)) return false;
  if (!message || typeof message.id !== 'string' || message.id.length !== 36 || typeof message.from !== 'string' || !message.key || typeof message.signature !== 'string') return false;
  try { const actor = await actorId(message.key); if (actor !== message.actor) return false; if (!keys.has(actor)) keys.set(actor, await crypto.subtle.importKey('jwk', message.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])); const { signature, ...body } = message; const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0)); return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.get(actor), bytes, enc.encode(JSON.stringify(body))); } catch { return false; }
}
