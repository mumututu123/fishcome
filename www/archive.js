import { chooseReferral } from './referral.js';
import { mergeTravel } from './fish-status.js';

export const ARCHIVE = Object.freeze({ age: 7 * 86400000, period: 86400000, threshold: 8 * 1024 * 1024, chunkSize: 256 * 1024, maxChunk: 1024 * 1024, fragmentSize: 384 * 1024, maxRecord: 32 * 1024 * 1024 });
export const ARCHIVE_FIELDS = ['ops', 'chars', 'breeding', 'travel', 'chats', 'chatSources', 'fishes', 'scenes'];
export const emptyArchiveState = (at = 0) => ({ version: 1, at, chunks: {} });
const json = value => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);
export function archiveDependencies(data) {
  const keep = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, new Set()]));
  const fish = id => { if (!id) return; if (id.startsWith('born:')) birth(id.slice(5)); else keep.ops.add(id); };
  const birth = id => { if (keep.breeding.has(id)) return; keep.breeding.add(id); const r = data.breeding[id]; if (r) { fish(r.male); fish(r.female); } };
  for (const f of Object.values(data.fishes)) { fish(f.id); keep.travel.add(f.id); }
  for (const r of Object.values(data.breeding || {})) if (r.status === 'active') birth(r.id);
  for (const [id, scene] of Object.entries(data.scenes)) { keep.ops.add(id); if (scene.poseId) keep.ops.add(scene.poseId); }
  for (const c of Object.values(data.chars)) if (c.kind !== 'burn') {
    keep.chars.add(c.id); keep.ops.add(c.id.slice(0, 36));
    for (const event of c.path) { if (event.birth) birth(event.birth); if (event.reason === 'expire') keep.ops.add(event.id?.slice(0, 36)); }
    if (c.wild?.source.startsWith('cell:')) { const source = c.wild.source.slice(5), root = data.chars[source]; keep.chars.add(source); keep.ops.add(source.slice(0, 36)); if (root) keep.ops.add(root.entity); }
    if (c.chat) keep.chats.add(c.chat);
  }
  for (const r of Object.values(data.life?.bonds || {})) { fish(r.a); fish(r.b); }
  for (const [id, r] of Object.entries(data.life?.places || {})) { fish(id); keep.ops.add(r.scene); }
  for (const [id, r] of Object.entries(data.life?.haunts || {})) { fish(id); keep.ops.add(r.scene); }
  for (const event of Object.values(data.life?.events || {})) {
    for (const id of event.fishes) fish(id);
    for (const id of event.plants) {
      keep.chars.add(id); const c = data.chars[id];
      for (const step of c?.path || []) if (step.birth) birth(step.birth);
      if (c?.wild?.source.startsWith('cell:')) { const source = c.wild.source.slice(5); keep.chars.add(source); keep.ops.add(source.slice(0, 36)); }
    }
  }
  for (const r of Object.values(data.life?.stories || {})) { fish(r.fish); fish(r.other); for (const id of r.parents || []) fish(id); if (r.scene) keep.ops.add(r.scene); }
  for (const id of Object.keys(data.chatSources || {})) keep.chats.add(id);
  for (const message of Object.values(data.chats || {}).sort((a, b) => b.body.t - a.body.t || a.id.localeCompare(b.id)).slice(0, 80)) keep.chats.add(message.id);
  for (const op of Object.values(data.ops)) if (op.kind === 'sceneEdit' && data.chars[op.cell]?.kind !== 'burn') keep.ops.add(op.id);
  return keep;
}
export function archivePlan(data, now, { pressure = false } = {}) {
  const keep = archiveDependencies(data), cutoff = now - (pressure ? ARCHIVE.period : ARCHIVE.age), records = Object.fromEntries(ARCHIVE_FIELDS.map(field => [field, {}]));
  for (const field of ARCHIVE_FIELDS) for (const [id, record] of Object.entries(data[field] || {})) {
    if (field === 'fishes' || field === 'scenes' || field === 'chatSources') continue;
    if (keep[field].has(id)) continue;
    const at = field === 'ops' ? record.t : field === 'chars' ? Math.max(record.created || 0, record.moveAt || 0, ...record.path.map(e => e.t || 0)) : field === 'chats' ? record.body.t : field === 'breeding' ? record.at : Math.max(record.since || 0, ...Object.keys(record.days || {}).map(day => Date.parse(day + 'T23:59:59+08:00')));
    if (at > cutoff || field === 'chars' && record.kind !== 'burn' || field === 'travel' && data.fishes[id] || field === 'breeding' && record.status === 'active') continue;
    records[field][id] = record;
  }
  return records;
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
export async function archiveHash(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join(''); }
function base64(bytes) { let text = ''; for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(text); }
function unbase64(text) { if (typeof text !== 'string' || text.length > ARCHIVE.maxChunk * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('归档编码无效'); return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
function description(raw, id, size) {
  const times = Object.values(raw.records.chats).map(m => m.body.t);
  const result = { id, version: 1, rawSize: size, counts: Object.fromEntries(Object.keys(raw.records).map(f => [f, Object.keys(raw.records[f]).length])), chatMin: times.length ? Math.min(...times) : null, chatMax: times.length ? Math.max(...times) : null };
  if (raw.fragment) { const { data, ...fragment } = raw.fragment; result.fragment = fragment; if (!fragment.index) result.counts[fragment.field] = 1; } return result;
}
export async function encodeArchive(records, roots, fragment) {
  const referenced = new Set(); for (const op of Object.values(records.ops || {})) { for (const root of op.roots || []) referenced.add(root); if (op.genesis) referenced.add(op.genesis); }
  for (const cell of Object.values(records.chars || {})) { if (cell.wild?.origin) referenced.add(cell.wild.origin); if (cell.plankton?.seed) referenced.add(cell.plankton.seed); }
  for (const m of [...Object.values(records.chats || {}), ...Object.values(records.chatSources || {})]) for (const root of m.body.roots) referenced.add(root);
  const compactRoots = Object.fromEntries(Object.entries(roots).filter(([root]) => referenced.has(root))); if (!Object.keys(compactRoots).length && Object.keys(roots).length) { const root = Object.keys(roots).sort()[0]; compactRoots[root] = roots[root]; }
  const bytes = encoder.encode(json({ version: 1, roots: compactRoots, records, ...(fragment ? { fragment } : {}) })); if (bytes.length > ARCHIVE.maxChunk) throw new Error('单份归档过大'); const raw = JSON.parse(decoder.decode(bytes));
  const id = await archiveHash(bytes), compressed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  return { manifest: description(raw, id, bytes.length), encoded: base64(compressed), raw };
}
export async function decodeArchive(encoded, manifest) {
  if (!manifest || !/^[0-9a-f]{64}$/.test(manifest.id) || !Number.isInteger(manifest.rawSize) || manifest.rawSize < 1 || manifest.rawSize > ARCHIVE.maxChunk) throw new Error('归档目录无效');
  const reader = new Blob([unbase64(encoded)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader(), parts = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > ARCHIVE.maxChunk || size > manifest.rawSize) { await reader.cancel(); throw new Error('归档解压超限'); } parts.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  if (size !== manifest.rawSize || await archiveHash(bytes) !== manifest.id) throw new Error('归档内容哈希不符');
  const raw = JSON.parse(decoder.decode(bytes)); if (raw.version !== 1 || !raw.roots || !raw.records || ARCHIVE_FIELDS.slice(0, 5).some(f => !raw.records[f]) || Object.keys(raw.records).some(f => !ARCHIVE_FIELDS.includes(f) || !raw.records[f] || typeof raw.records[f] !== 'object' || Array.isArray(raw.records[f]))) throw new Error('归档内容无效');
  if (raw.fragment) { const f = raw.fragment; if (!ARCHIVE_FIELDS.includes(f.field) || typeof f.id !== 'string' || f.id.length > 512 || !/^[0-9a-f]{64}$/.test(f.hash) || !Number.isInteger(f.index) || !Number.isInteger(f.total) || f.index < 0 || f.index >= f.total || f.total > Math.ceil(ARCHIVE.maxRecord / ARCHIVE.fragmentSize) || unbase64(f.data).length > ARCHIVE.fragmentSize) throw new Error('归档分片无效'); }
  if (!same(description(raw, manifest.id, size), manifest)) throw new Error('归档目录与内容不符'); for (const field of ARCHIVE_FIELDS) raw.records[field] ||= {}; return raw;
}
export async function archiveChunks(records, roots) {
  const chunks = []; let batch = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])), bytes = 0;
  for (const field of ARCHIVE_FIELDS) for (const [id, record] of Object.entries(records[field]).sort(([a], [b]) => a.localeCompare(b))) {
    const recordBytes = encoder.encode(json(record)), size = recordBytes.length + id.length + 8;
    if (size > ARCHIVE.maxChunk / 2) {
      if (recordBytes.length > ARCHIVE.maxRecord) throw new Error('单条历史超过安全归档范围，保留原记录');
      if (bytes) { chunks.push(await encodeArchive(batch, roots)); batch = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])); bytes = 0; }
      const hash = await archiveHash(recordBytes), total = Math.ceil(recordBytes.length / ARCHIVE.fragmentSize);
      for (let index = 0; index < total; index++) chunks.push(await encodeArchive(Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])), roots, { field, id, hash, index, total, data: base64(recordBytes.subarray(index * ARCHIVE.fragmentSize, (index + 1) * ARCHIVE.fragmentSize)) }));
      continue;
    }
    if (bytes && bytes + size > ARCHIVE.chunkSize) { chunks.push(await encodeArchive(batch, roots)); batch = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])); bytes = 0; }
    batch[field][id] = record; bytes += size;
  }
  if (bytes) chunks.push(await encodeArchive(batch, roots)); await assembleFragments(chunks); return chunks;
}
export async function assembleFragments(chunks, state, load) {
  const groups = new Map(); for (const chunk of chunks) if (chunk.raw.fragment) { const f = chunk.raw.fragment, key = `${f.field}:${f.id}:${f.hash}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(chunk); }
  for (const group of groups.values()) {
    const sample = group[0].raw.fragment, parts = new Map(group.map(c => [c.raw.fragment.index, c]));
    for (const manifest of Object.values(state?.chunks || {})) if (manifest.fragment?.field === sample.field && manifest.fragment.id === sample.id && manifest.fragment.hash === sample.hash && !parts.has(manifest.fragment.index)) { const chunk = await load(manifest.id); parts.set(manifest.fragment.index, chunk); }
    if (parts.size !== sample.total) throw new Error('归档分片不完整');
    const bytes = []; let size = 0; for (let index = 0; index < sample.total; index++) { const f = parts.get(index)?.raw.fragment; if (!f || f.field !== sample.field || f.id !== sample.id || f.hash !== sample.hash || f.total !== sample.total) throw new Error('归档分片不一致'); const part = unbase64(f.data); bytes.push(part); size += part.length; }
    if (size > ARCHIVE.maxRecord) throw new Error('归档记录解压超限'); const joined = new Uint8Array(size); let offset = 0; for (const b of bytes) { joined.set(b, offset); offset += b.length; }
    if (await archiveHash(joined) !== sample.hash) throw new Error('归档原记录哈希不符'); const record = JSON.parse(decoder.decode(joined));
    const first = parts.get(0); first.logical = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, f === sample.field ? { [sample.id]: record } : {}]));
    if (!group.includes(first)) group[0].logical = first.logical;
  }
}
export function validArchiveState(state) { return state === undefined || !!state && state.version === 1 && Number.isFinite(state.at) && state.at >= 0 && state.chunks && !Array.isArray(state.chunks) && Object.keys(state.chunks).length <= 100000 && Object.entries(state.chunks).every(([id, m]) => id === m.id && /^[0-9a-f]{64}$/.test(id) && m.version === 1 && Number.isInteger(m.rawSize) && m.rawSize > 0 && m.rawSize <= ARCHIVE.maxChunk); }
export function mergeArchiveState(a, b) {
  const left = a || emptyArchiveState(), right = b || emptyArchiveState(); if (!validArchiveState(left) || !validArchiveState(right)) throw new Error('归档目录无效');
  const chunks = { ...left.chunks }; for (const [id, manifest] of Object.entries(right.chunks)) { if (chunks[id] && !same(chunks[id], manifest)) throw new Error('已有归档目录不可覆盖'); chunks[id] = manifest; }
  return { version: 1, at: Math.max(left.at, right.at), chunks };
}
export function operationValue(op, actor) { return (op.kind === 'referral' && op.inviter === actor ? 10 : 0) + (op.actor === actor ? op.kind === 'earn' ? 1 : -(op.cost || 0) : 0); }
function opSummary(op) { return { id: op.id, kind: op.kind, actor: op.actor, cost: op.cost, inviter: op.inviter, t: op.t }; }
export class ArchiveStore {
  constructor({ load } = {}) { this.load = load; this.packs = new Map(); this.manifests = {}; this.ids = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, new Map()])); this.cache = new Map(); this.bigCache = new Map(); this.overrides = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])); this.summary = { ops: {}, ledger: {}, serials: {}, catalog: {}, lastMeals: new Map(), grassMeals: new Set(), mealSources: new Map() }; }
  async ingest(chunk, chooseChar) {
    if (this.manifests[chunk.manifest.id]) return;
    const changes = [];
    for (const field of ARCHIVE_FIELDS) for (const [id, record] of Object.entries((chunk.logical || chunk.raw.records)[field])) if (this.ids[field].has(id)) {
      const old = await this.get(field, id); let chosen = old;
      if (field === 'chars') chosen = chooseChar(old, record);
      else if (field === 'ops') { if (old.kind === 'referral' && record.kind === 'referral') chosen = chooseReferral(old, record); else { const { proof: p, ...a } = old, { proof: q, ...b } = record; if (!same(a, b)) throw new Error('归档操作记录不可覆盖'); } }
      else if (field === 'chats' || field === 'chatSources') { if (!same(old, record)) throw new Error('归档聊天记录不可覆盖'); }
      else if (field === 'travel') chosen = mergeTravel(old, record);
      else if (field === 'breeding') {
        const born = record.status === 'born', oldBorn = old.status === 'born', terminal = record.status !== 'active', oldTerminal = old.status !== 'active';
        if (born && !oldBorn || !oldBorn && terminal && !oldTerminal || born === oldBorn && terminal === oldTerminal && ((born ? record.at < old.at : record.at > old.at) || record.at === old.at && json(record).localeCompare(json(old)) > 0)) chosen = record;
      } else if ((record.posAt || 0) > (old.posAt || 0) || record.posAt === old.posAt && json(record).localeCompare(json(old)) > 0) chosen = record;
      if (!same(old, chosen)) changes.push({ field, id, old, chosen });
    }
    this.addVerified(chunk);
    for (const { field, id, old, chosen } of changes) {
      this.overrides[field][id] = chosen;
      if (field === 'ops') { for (const actor of new Set([old.actor, old.inviter, chosen.actor, chosen.inviter].filter(Boolean))) this.summary.ledger[actor] = (this.summary.ledger[actor] || 0) - operationValue(old, actor) + operationValue(chosen, actor); this.summary.ops[id] = opSummary(chosen); }
      if (field === 'breeding' && chosen.status === 'born') { const b = chosen.baby; this.summary.catalog[b.id] = { id: b.id, actor: b.actor, nick: b.nick, name: b.name, nameAuto: b.nameAuto, nameOrdinal: b.nameOrdinal, gender: b.gender, created: b.created, parents: b.parents, size: b.cells.length }; }
      if (field === 'chars') this.summary.mealSources.set(id, { wild: !!chosen.wild, events: chosen.path.filter(e => e.reason === 'eat').map(e => ({ target: e.target, t: e.t })) });
    }
    if (changes.some(c => c.field === 'chars')) { this.summary.lastMeals.clear(); this.summary.grassMeals.clear(); for (const source of this.summary.mealSources.values()) for (const e of source.events) { this.summary.lastMeals.set(e.target, Math.max(this.summary.lastMeals.get(e.target) ?? -Infinity, e.t)); if (source.wild) this.summary.grassMeals.add(e.target); } }
  }
  // addVerified is called only after original signatures/source records have been checked.
  addVerified(chunk) {
    const { manifest, encoded, raw } = chunk; if (this.manifests[manifest.id]) return;
    this.packs.set(manifest.id, encoded); this.manifests[manifest.id] = manifest;
    const logical = chunk.logical || raw.records;
    if (raw.fragment && chunk.logical) { this.bigCache.set(raw.fragment.hash, logical[raw.fragment.field][raw.fragment.id]); while (this.bigCache.size > 2) this.bigCache.delete(this.bigCache.keys().next().value); }
    for (const field of ARCHIVE_FIELDS) for (const [id, record] of Object.entries(logical[field])) {
      if (this.ids[field].has(id)) continue; this.ids[field].set(id, manifest.id);
      if (field === 'ops') {
        this.summary.ops[id] = opSummary(record);
        if (record.kind === 'earn') this.summary.serials[record.actor] = Math.max(this.summary.serials[record.actor] || 0, record.serial);
        for (const actor of new Set([record.actor, record.inviter].filter(Boolean))) this.summary.ledger[actor] = (this.summary.ledger[actor] || 0) + operationValue(record, actor);
        if (record.kind === 'fish') this.summary.catalog[id] = { id, actor: record.actor, nick: record.nick, gender: record.gender, name: record.name, created: record.t, size: record.cells.length, parents: [] };
      }
      if (field === 'breeding' && record.status === 'born') { const baby = record.baby; this.summary.catalog[baby.id] = { id: baby.id, actor: baby.actor, nick: baby.nick, name: baby.name, nameAuto: baby.nameAuto, nameOrdinal: baby.nameOrdinal, gender: baby.gender, created: baby.created, parents: baby.parents, size: baby.cells.length }; }
      if (field === 'chars') { this.summary.mealSources.set(id, { wild: !!record.wild, events: record.path.filter(e => e.reason === 'eat').map(e => ({ target: e.target, t: e.t })) }); for (const e of record.path) if (e.reason === 'eat') { this.summary.lastMeals.set(e.target, Math.max(this.summary.lastMeals.get(e.target) ?? -Infinity, e.t)); if (record.wild) this.summary.grassMeals.add(e.target); } }
    }
    this.remember(manifest.id, raw);
    if (this.load) while (this.packs.size > 4) this.packs.delete(this.packs.keys().next().value);
  }
  remember(id, raw) { this.cache.delete(id); this.cache.set(id, raw); while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value); }
  async raw(id) { const cached = this.cache.get(id); if (cached) { this.remember(id, cached); return cached; } const encoded = this.packs.get(id) || await this.load?.(id); if (!encoded) throw new Error('缺少历史归档'); const raw = await decodeArchive(encoded, this.manifests[id]); this.remember(id, raw); return raw; }
  async get(field, id) {
    if (this.overrides[field][id]) return this.overrides[field][id]; const chunk = this.ids[field].get(id); if (!chunk) return undefined;
    const fragment = this.manifests[chunk].fragment; if (!fragment) return (await this.raw(chunk)).records[field][id];
    if (this.bigCache.has(fragment.hash)) return this.bigCache.get(fragment.hash);
    const first = { manifest: this.manifests[chunk], raw: await this.raw(chunk) }; await assembleFragments([first], { chunks: this.manifests }, async key => ({ manifest: this.manifests[key], raw: await this.raw(key) }));
    const record = first.logical[field][id]; this.bigCache.set(fragment.hash, record); while (this.bigCache.size > 2) this.bigCache.delete(this.bigCache.keys().next().value); return record;
  }
  async dependencies(incoming, current) {
    const extra = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}])), pending = [];
    const need = (field, id) => { if (id && this.ids[field].has(id) && !extra[field][id]) pending.push([field, id]); };
    const fish = id => id?.startsWith('born:') ? need('breeding', id.slice(5)) : need('ops', id);
    for (const field of ARCHIVE_FIELDS) for (const id of Object.keys(incoming[field] || {})) need(field, id);
    const refs = data => {
      for (const c of Object.values(data.chars || {})) { need('ops', c.id.slice(0, 36)); for (const e of c.path) if (e.birth) need('breeding', e.birth); if (c.wild?.source.startsWith('cell:')) { need('chars', c.wild.source.slice(5)); need('ops', c.wild.source.slice(5, 41)); } }
      for (const f of Object.values(data.fishes || {})) fish(f.id);
      for (const r of Object.values(data.breeding || {})) { fish(r.male); fish(r.female); }
      for (const id of Object.keys(data.travel || {})) fish(id);
      for (const r of Object.values(data.life?.bonds || {})) { fish(r.a); fish(r.b); }
      for (const [id, r] of Object.entries(data.life?.places || {})) { fish(id); need('ops', r.scene); }
      for (const [id, r] of Object.entries(data.life?.haunts || {})) { fish(id); need('ops', r.scene); }
      for (const event of Object.values(data.life?.events || {})) { for (const id of event.fishes) fish(id); for (const id of event.plants) need('chars', id); }
      for (const r of Object.values(data.life?.stories || {})) { fish(r.fish); fish(r.other); for (const id of r.parents || []) fish(id); if (r.scene) need('ops', r.scene); }
    };
    refs(incoming);
    while (pending.length) {
      const [field, id] = pending.pop(); if (extra[field][id] || current[field]?.[id]) continue;
      const record = await this.get(field, id); if (!record) continue; extra[field][id] = record;
      if (field === 'breeding') { fish(record.male); fish(record.female); }
      if (field === 'chars') refs({ chars: { [id]: record } });
    }
    return extra;
  }
  async records(state) {
    const result = Object.fromEntries(ARCHIVE_FIELDS.map(f => [f, {}]));
    for (const id of Object.keys(state?.chunks || this.manifests)) { const raw = await this.raw(id); for (const field of ARCHIVE_FIELDS) Object.assign(result[field], raw.records[field]); if (raw.fragment && !raw.fragment.index) result[raw.fragment.field][raw.fragment.id] = await this.get(raw.fragment.field, raw.fragment.id); }
    for (const field of ARCHIVE_FIELDS) for (const id of Object.keys(result[field])) result[field][id] = await this.get(field, id); return result;
  }
  async chats(limit, hot, state) {
    const result = { ...hot }, chunks = Object.values(state?.chunks || this.manifests).filter(m => m.counts.chats).sort((a, b) => b.chatMax - a.chatMax || a.id.localeCompare(b.id));
    for (const manifest of chunks) {
      const sorted = Object.values(result).sort((a, b) => b.body.t - a.body.t); if (sorted.length >= limit && sorted[limit - 1].body.t > manifest.chatMax) break;
      Object.assign(result, (await this.raw(manifest.id)).records.chats);
    }
    return result;
  }
}
export async function compactKnown(world, store) {
  if (!Object.keys(store.manifests).length) return;
  const keep = archiveDependencies(world.data), candidates = [];
  for (const field of ['ops', 'chars', 'breeding', 'travel', 'chats']) for (const [id, record] of Object.entries(world.data[field])) {
    if (keep[field].has(id) || !store.ids[field].has(id) || field === 'chars' && record.kind !== 'burn') continue;
    candidates.push([field, id, await store.get(field, id)]);
  }
  // Recheck references after asynchronous disk reads; a new fish or edit may now need a proof.
  const current = archiveDependencies(world.data);
  for (const [field, id, record] of candidates) if (!current[field].has(id) && same(world.data[field][id], record)) delete world.data[field][id];
  world.dirty = true; world.foodRevision++;
}
