const DATABASE = 'tide-world-v1';
let opening;
export function database() { return opening ||= new Promise((resolve, reject) => { const r = indexedDB.open(DATABASE, 1); r.onupgradeneeded = () => r.result.createObjectStore('items'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
export async function get(name) { const db = await database(); return new Promise((resolve, reject) => { const r = db.transaction('items').objectStore('items').get(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
export async function set(name, value) { const db = await database(); return new Promise((resolve, reject) => { const tx = db.transaction('items', 'readwrite'); tx.objectStore('items').put(value, name); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('本地存档写入被中止')); }); }
export async function putMany(entries) { const db = await database(); return new Promise((resolve, reject) => { const tx = db.transaction('items', 'readwrite'); for (const [name, value] of entries) tx.objectStore('items').put(value, name); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('本地存档写入被中止')); }); }
export function download(name, data) { const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }

const enc = new TextEncoder();
const actorHashes = new Map();
export async function actorId(jwk) { const text = `${jwk.crv}:${jwk.x}:${jwk.y}`; if (actorHashes.has(text)) return actorHashes.get(text); const bytes = await crypto.subtle.digest('SHA-256', enc.encode(text)); const id = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); actorHashes.set(text, id); return id; }
export async function newIdentity(nick) { const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); const pub = await crypto.subtle.exportKey('jwk', pair.publicKey), secret = await crypto.subtle.exportKey('jwk', pair.privateKey); const identity = { nick, pub, secret, actor: await actorId(pub), remainder: 0, serial: 0, registration: { at: Date.now(), joined: false } }; await set('identity', identity); return identity; }
export async function signer(identity) { const key = await crypto.subtle.importKey('jwk', identity.secret, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); return async value => { const bytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(JSON.stringify(value))); return btoa(String.fromCharCode(...new Uint8Array(bytes))); }; }
const keys = new Map();
export async function verifyEnvelope(message) {
  if (typeof message?.actor !== 'string' || message.from?.slice(0, 16) !== message.actor.slice(0, 16)) return false;
  if (!message || typeof message.id !== 'string' || message.id.length !== 36 || typeof message.from !== 'string' || !message.key || typeof message.signature !== 'string') return false;
  try { const actor = await actorId(message.key); if (actor !== message.actor) return false; if (!keys.has(actor)) keys.set(actor, await crypto.subtle.importKey('jwk', message.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])); const { signature, ...body } = message; const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0)); return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.get(actor), bytes, enc.encode(JSON.stringify(body))); } catch { return false; }
}
