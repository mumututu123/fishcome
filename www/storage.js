import { beginCheckpoint, checkpointChanged, checkpointCommitted, readCheckpoint } from './checkpoint-pages.js';
import { PAGE_HEAD, currentKey, readOldBundle, oldBranch } from './legacy-checkpoint.js';

const DATABASE = 'tide-world-v1';
let opening;
let restoringBackup = false;
export function database() { return opening ||= new Promise((resolve, reject) => { const r = indexedDB.open(DATABASE, 1); r.onupgradeneeded = () => r.result.createObjectStore('items'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
export async function get(name) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const store = db.transaction('items').objectStore('items');
    const key = name === 'checkpoint' ? PAGE_HEAD : currentKey(name);
    const request = store.get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (request.result === undefined && name !== key) {
        const old = store.get(name);
        old.onerror = () => reject(old.error);
        old.onsuccess = () => {
          if (name === 'checkpoint') readCheckpoint(store, old.result, resolve, reject);
          else resolve(old.result);
        };
      } else if (name === 'checkpoint') readCheckpoint(store, request.result, resolve, reject);
      else resolve(request.result);
    };
  });
}
export function getMany(names) { return Promise.all(names.map(name => get(name))); }
export function set(name, value) { return putMany([[name, value]]); }
// The update handoff must merge one coherent checkpoint and its account
// metadata before a compare-and-swap against this exact revision.
export async function readHandoffCheckpoint() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items'), store = tx.objectStore('items'), state = {};
    const head = store.get(PAGE_HEAD);
    head.onsuccess = () => {
      if (!head.result?.revision) { reject(new Error('本地存档已更换，请重新打开游戏。')); return; }
      state.revision = head.result.revision;
      readCheckpoint(store, head.result, value => { state.checkpoint = value; }, reject, false);
    };
    for (const key of ['identity', 'histories', 'known']) {
      const request = store.get(currentKey(key));
      request.onsuccess = () => { state[key] = request.result; };
    }
    tx.oncomplete = () => resolve(state);
    tx.onabort = () => reject(tx.error || new Error('读取其他页面的存档失败'));
  });
}
export async function getOldBranch(id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items'); tx.onerror = () => reject(tx.error);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', 'readwrite');
    const store = tx.objectStore('items');
    let cache, failure, captured, snapshotOnly, writingCheckpoint = false;
    tx.oncomplete = () => { if (writingCheckpoint) checkpointCommitted(cache); resolve(captured); };
    tx.onabort = () => {
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
          } else store.put(value, currentKey(name));
        }
        if (options.replace && options.generation !== undefined) store.put(options.generation + 1, currentKey('saveGeneration'));
      } catch (error) { abort(error); }
    };
    const proceed = () => {
      if (typeof source !== 'function' && !source.some(([name]) => name === 'checkpoint')) write();
      else {
        const head = store.get(PAGE_HEAD);
        head.onsuccess = () => {
          if (!head.result || options.mirrorLegacy) readOldBundle(store, bundle => write(head.result ?? bundle.checkpoint, bundle));
          else write(head.result);
        };
      }
    };
    const verifyCheckpointAndProceed = () => {
      if (options.checkpoint === undefined) { proceed(); return; }
      const head = store.get(PAGE_HEAD);
      head.onerror = () => abort(head.error);
      head.onsuccess = () => {
        const compare = current => {
          if (JSON.stringify(current ?? null) !== JSON.stringify(options.checkpoint)) abort(new Error('扫描后存档已更新，请重新扫描'));
          else proceed();
        };
        if (head.result === undefined) {
          const old = store.get('checkpoint');
          old.onerror = () => abort(old.error);
          old.onsuccess = () => readCheckpoint(store, old.result, compare, abort);
        } else readCheckpoint(store, head.result, compare, abort);
      };
    };
    if (options.generation === undefined) { verifyCheckpointAndProceed(); return; }
    const check = store.get(currentKey('saveGeneration'));
    check.onerror = () => abort(check.error);
    check.onsuccess = () => {
      if ((check.result ?? 0) !== options.generation) abort(new Error('存档已在其他页面更换，请刷新后再试'));
      else verifyCheckpointAndProceed();
    };
  });
}
export function download(name, data) { const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }

const enc = new TextEncoder();
const actorHashes = new Map();
export async function actorId(jwk) { const text = `${jwk.crv}:${jwk.x}:${jwk.y}`; if (actorHashes.has(text)) return actorHashes.get(text); const bytes = await crypto.subtle.digest('SHA-256', enc.encode(text)); const id = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); actorHashes.set(text, id); return id; }
export async function newIdentity(nick, generation) { const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); const pub = await crypto.subtle.exportKey('jwk', pair.publicKey), secret = await crypto.subtle.exportKey('jwk', pair.privateKey); const identity = { nick, pub, secret, actor: await actorId(pub), remainder: 0, serial: 0, registration: { at: Date.now(), joined: false } }; await putMany([['identity', identity]], { generation }); return identity; }
export async function signer(identity) { const key = await crypto.subtle.importKey('jwk', identity.secret, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); return async value => { const bytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(JSON.stringify(value))); return btoa(String.fromCharCode(...new Uint8Array(bytes))); }; }
const keys = new Map();
export async function verifyEnvelope(message) {
  if (typeof message?.actor !== 'string' || message.from?.slice(0, 16) !== message.actor.slice(0, 16)) return false;
  if (!message || typeof message.id !== 'string' || message.id.length !== 36 || typeof message.from !== 'string' || !message.key || typeof message.signature !== 'string') return false;
  try { const actor = await actorId(message.key); if (actor !== message.actor) return false; if (!keys.has(actor)) keys.set(actor, await crypto.subtle.importKey('jwk', message.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])); const { signature, ...body } = message; const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0)); return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.get(actor), bytes, enc.encode(JSON.stringify(body))); } catch { return false; }
}
