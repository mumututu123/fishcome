import { CONFIG, clone } from './engine.js';
import { fishOrigin, inheritedGlyph, validBreedingRecord, canonicalBirthFish, canonicalBirthPath } from './breeding.js';

const MAX_LOGS = 200;

export class DiagnosticLog {
  constructor(limit = MAX_LOGS) {
    this.limit = limit;
    this.entries = [];
  }
  record(level, source, message, detail = null) {
    const entry = {
      at: Date.now(),
      level,
      source,
      message: String(message || ''),
      ...(detail ? { detail } : {})
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return entry;
  }
  clear() {
    this.entries.length = 0;
  }
  list() {
    return this.entries.slice();
  }
  format() {
    if (!this.entries.length) return '暂无诊断日志。';
    return this.entries.map(entry => {
      const time = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19);
      const head = `[${time}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
      return entry.detail ? `${head}\n  ${JSON.stringify(entry.detail)}` : head;
    }).join('\n');
  }
}

export function buildOriginSources(data, extra = {}, current = null, chars) {
  return {
    ops: { ...extra?.ops, ...current?.ops, ...data?.ops },
    breeding: { ...extra?.breeding, ...current?.breeding, ...data?.breeding },
    roots: { ...current?.roots, ...data?.roots },
    chars: chars ?? { ...extra?.chars, ...current?.chars, ...data?.chars }
  };
}

export function inspectFishOrigin(id, fish, sources) {
  const source = fishOrigin(sources, id);
  const reasons = [];
  if (!fish || typeof fish !== 'object') {
    return { id, ok: false, reasons: ['invalid_object'], repairable: source ? 'blocked' : 'prune_orphan', summary: '鱼记录不是有效对象' };
  }
  if (fish.id !== id) reasons.push('id_mismatch');
  if (!source) {
    reasons.push(id.startsWith('born:') ? 'missing_breeding' : 'missing_origin_op');
  } else {
    if (fish.actor !== source.actor) reasons.push('actor_mismatch');
    if (fish.created !== source.created) reasons.push('created_mismatch');
  }
  if (id.startsWith('born:') ? fish.birth !== id.slice(5) : fish.birth != null) {
    reasons.push('birth_mismatch');
  }
  if (!reasons.length) return { id, ok: true, reasons: [] };

  const isBorn = id.startsWith('born:');
  const breedingId = isBorn ? id.slice(5) : null;
  const breedingRecord = breedingId ? sources.breeding?.[breedingId] : null;
  const opRecord = !isBorn ? sources.ops?.[id] : null;
  const hasTrustedBirth = !!(isBorn && breedingRecord?.status === 'born' && breedingRecord.baby?.id === id && validBreedingRecord(breedingRecord, sources));
  const hasTrustedOp = !!(!isBorn && opRecord?.kind === 'fish' && opRecord.id === id);
  const uncertainIdentity = fish.id != null && fish.id !== id;
  const repairable = hasTrustedBirth || hasTrustedOp ? 'safe' : source || breedingRecord?.status === 'born' || uncertainIdentity ? 'blocked' : 'prune_orphan';

  const parts = [];
  if (reasons.includes('id_mismatch')) parts.push(`键名与 fish.id 不一致（${fish.id}）`);
  if (reasons.includes('missing_origin_op')) parts.push('缺少创建操作凭据（ops 中无记录）');
  if (reasons.includes('missing_breeding')) {
    if (!breedingRecord) parts.push(`缺少繁殖记录（${breedingId}）`);
    else if (breedingRecord.status !== 'born') parts.push(`繁殖记录状态为 ${breedingRecord.status}，并非 born`);
    else parts.push('繁殖记录的 baby.id 与鱼编号不匹配');
  }
  if (reasons.includes('actor_mismatch')) parts.push(`归属不一致（鱼=${String(fish.actor).slice(0, 8)}，来源=${String(source.actor).slice(0, 8)}）`);
  if (reasons.includes('created_mismatch')) parts.push(`创建时间不一致（鱼=${fish.created}，来源=${source.created}，差值=${fish.created - source.created}ms）`);
  if (reasons.includes('birth_mismatch')) parts.push(`fish.birth（${fish.birth}）指向无效繁殖记录`);

  return {
    id,
    ok: false,
    reasons,
    repairable,
    summary: parts.join('；'),
    fish: {
      id: fish.id,
      actor: fish.actor,
      created: fish.created,
      birth: fish.birth || null,
      posAt: fish.posAt ?? null
    },
    source: source ? {
      actor: source.actor,
      created: source.created,
      gender: source.gender ?? null,
      from: isBorn ? 'breeding' : 'op'
    } : null,
    breedingStatus: breedingRecord?.status || null
  };
}

function needsTravelAlignment(travel, created) {
  return travel && typeof travel === 'object' && (!Number.isFinite(travel.since) || travel.since < created || travel.since > Date.now() + 60000);
}

export function inspectFishOrigins(data, extra = {}, current = null) {
  if (!data?.fishes || typeof data.fishes !== 'object') {
    return { totalFishes: 0, okCount: 0, issues: [], safeRepairable: 0, orphanCount: 0 };
  }
  const sources = buildOriginSources(data, extra, current);
  const issues = [];
  const pathRepairs = new Set();
  for (const cell of Object.values(data.chars || {})) {
    if (!Array.isArray(cell?.path) || !cell.path.some(e => e?.reason === 'birth')) continue;
    const aligned = canonicalBirthPath(cell, sources.breeding);
    if (aligned !== cell) aligned.path.forEach((event, i) => {
      if (event !== cell.path[i]) pathRepairs.add(event.target);
    });
  }
  let totalFishes = 0;
  for (const [id, fish] of Object.entries(data.fishes)) {
    totalFishes++;
    const result = inspectFishOrigin(id, fish, sources);
    if (!result.ok) { issues.push(result); continue; }
    const reasons = [];
    if (needsTravelAlignment(data.travel?.[id], fish.created)) reasons.push('travel_since');
    if (pathRepairs.has(id)) reasons.push('birth_path_time');
    if (reasons.length) issues.push({ id, ok: false, reasons, repairable: 'safe', summary: '出生凭据与运动或继承时间不一致' });
  }
  const safeRepairable = issues.filter(item => item.repairable === 'safe').length;
  const orphanCount = issues.filter(item => item.repairable === 'prune_orphan').length;
  return {
    totalFishes,
    okCount: totalFishes - issues.length,
    issues,
    safeRepairable,
    orphanCount
  };
}

export function repairFishOriginIssues(data, extra = {}, { mode = 'align' } = {}) {
  if (!data?.fishes || !data.ops || !data.chars) {
    return { changed: false, data, actions: [], remaining: [] };
  }
  const next = clone(data);
  const sources = buildOriginSources(next, extra, null);
  const report = inspectFishOrigins(next, extra, null);
  const actions = [];
  const trustedBreeding = {};
  const removedFishIds = new Set();

  for (const issue of report.issues) {
    const id = issue.id;
    const fish = next.fishes[id];
    if (issue.repairable === 'safe') {
      if (id.startsWith('born:')) {
        const record = sources.breeding[id.slice(5)];
        const base = { ...fish, id };
        const aligned = canonicalBirthFish(base, record);
        next.fishes[id] = aligned;
        trustedBreeding[record.id] = record;
        actions.push({ id, action: 'align_born', detail: issue.summary });
      } else {
        const op = sources.ops[id];
        const aligned = { ...fish, id, actor: op.actor, created: op.t };
        delete aligned.birth;
        if (fish.lastFed === fish.created && fish.lastMealAt == null) {
          aligned.lastFed = op.t;
          if (fish.hungerAt === fish.created + CONFIG.hunger) aligned.hungerAt = op.t + CONFIG.hunger;
        }
        next.fishes[id] = aligned;
        actions.push({ id, action: 'align_op', detail: issue.summary });
      }
      const travel = next.travel?.[id], created = next.fishes[id].created;
      if (needsTravelAlignment(travel, created)) travel.since = created;
    } else if (mode === 'align_and_prune' && issue.repairable === 'prune_orphan') {
      delete next.fishes[id];
      delete next.travel?.[id];
      removedFishIds.add(id);
      actions.push({ id, action: 'prune_orphan', detail: issue.summary });
    }
  }

  if (Object.keys(trustedBreeding).length) {
    for (const [cid, cell] of Object.entries(next.chars)) {
      if (!Array.isArray(cell?.path) || !cell.path.some(event => event?.reason === 'birth')) continue;
      const rebased = canonicalBirthPath(cell, trustedBreeding);
      if (rebased !== cell) next.chars[cid] = rebased;
    }
  }

  if (removedFishIds.size) {
    const children = new Map();
    for (const [bid, record] of Object.entries(next.breeding || {})) {
      for (const parent of [record.male, record.female]) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(bid);
      }
    }
    const removedBirths = new Set();
    for (const id of removedFishIds) {
      if (id.startsWith('born:')) removedBirths.add(id.slice(5));
      for (const bid of children.get(id) || []) {
        const record = next.breeding[bid];
        if (!record) continue;
        if (record.status === 'born') {
          const child = `born:${bid}`;
          removedFishIds.add(child);
          if (next.fishes[child]) actions.push({ id: child, action: 'prune_descendant' });
          delete next.fishes[child];
        }
        removedBirths.add(bid);
        delete next.breeding[bid];
      }
      delete next.travel?.[id];
    }
    for (const [contactId, contact] of Object.entries(next.contacts || {})) {
      if (removedFishIds.has(contact?.male) || removedFishIds.has(contact?.female)) delete next.contacts[contactId];
    }
    if (next.life) {
      for (const [key, bond] of Object.entries(next.life.bonds || {})) {
        if (removedFishIds.has(bond?.a) || removedFishIds.has(bond?.b)) delete next.life.bonds[key];
      }
      for (const id of removedFishIds) {
        if (next.life.places) delete next.life.places[id];
        if (next.life.haunts) delete next.life.haunts[id];
      }
      for (const [eid, event] of Object.entries(next.life.events || {})) {
        if (Array.isArray(event?.fishes) && event.fishes.some(id => removedFishIds.has(id))) delete next.life.events[eid];
      }
      for (const [sid, story] of Object.entries(next.life.stories || {})) {
        if (removedFishIds.has(story?.fish) || removedFishIds.has(story?.other) || (Array.isArray(story?.parents) && story.parents.some(id => removedFishIds.has(id)))) {
          delete next.life.stories[sid];
        }
      }
    }
    if (next.legends) {
      for (const id of removedFishIds) {
        if (next.legends.deaths) delete next.legends.deaths[id];
      }
      for (const [bid, burn] of Object.entries(next.legends.burns || {})) {
        if (removedFishIds.has(burn?.fish)) delete next.legends.burns[bid];
      }
      for (const event of Object.values(next.legends.events || {})) {
        for (const [aid, arm] of Object.entries(event?.arms || {})) {
          if (removedFishIds.has(arm?.fish)) delete event.arms[aid];
        }
      }
    }
    const reduced = new Set();
    const invalidStep = e => e.reason === 'eat' && removedFishIds.has(e.target) ||
      e.reason === 'birth' && (removedBirths.has(e.birth) || removedFishIds.has(e.target) || removedFishIds.has(e.from));
    for (const [cid, cell] of Object.entries(next.chars)) {
      const natural = cell.wild || cell.plankton || cell.ghost || cell.chat;
      if (!natural && removedFishIds.has(cid.slice(0, 36)) && !sources.ops[cid.slice(0, 36)]) {
        if (cell.kind === 'fish' && !removedFishIds.has(cell.entity)) reduced.add(cell.entity);
        delete next.chars[cid];
        continue;
      }
      const path = cell.path?.filter(e => !invalidStep(e));
      if (path && path.length !== cell.path.length) {
        cell.path = path;
        if (['fish', 'food'].includes(cell.kind) && !removedFishIds.has(cell.entity)) {
          const op = sources.ops[cid.slice(0, 36)];
          const initial = cell.wild ? '草' : cell.plankton ? '*' : cell.ghost ? '蛆' :
            op?.kind === 'food' ? op.ch : op?.cells?.[Number(cid.slice(37))]?.ch;
          const glyph = initial && inheritedGlyph(cell, initial, sources);
          if (glyph) cell.ch = glyph;
        }
      }
      if (cell.kind === 'fish' && removedFishIds.has(cell.entity)) {
        if (natural || sources.ops[cid.slice(0, 36)]) {
          cell.kind = 'burn';
          cell.entity = '';
          if (cell.plankton && !cell.path.some(e => e.reason === 'eat')) {
            cell.ch = '*';
            cell.born = cell.created;
          }
        } else delete next.chars[cid];
      }
    }
    if (reduced.size) {
      const sizes = new Map();
      for (const c of Object.values(next.chars)) if (c.kind === 'fish' && reduced.has(c.entity)) sizes.set(c.entity, (sizes.get(c.entity) || 0) + 1);
      for (const id of reduced) if ((sizes.get(id) || 0) < 2) throw new Error('清理会使其他存活鱼的身体不完整，请从完整备份恢复');
    }
  }

  const after = inspectFishOrigins(next, extra, null);
  return {
    changed: actions.length > 0,
    data: actions.length ? next : data,
    actions,
    remaining: after.issues
  };
}

// Free-form error messages can contain text from an imported file or a peer.
const originReasons = new Set(['invalid_object', 'id_mismatch', 'missing_origin_op', 'missing_breeding',
  'actor_mismatch', 'created_mismatch', 'birth_mismatch', 'travel_since', 'birth_path_time']);

export function diagnosticSummary(scan, entries) {
  const counts = { info: 0, warn: 0, error: 0 }, events = [];
  const sources = new Set(['start', 'backup', 'import', 'network', 'archive', 'hello', 'merge', 'world-full',
    'world-delta', 'diag-scan', 'diag-repair', 'diagnostics', 'checkpoint']);
  for (const { at, source, level, detail } of entries) {
    if (!Object.hasOwn(counts, level)) continue;
    counts[level]++;
    const event = { at: Number.isFinite(at) ? at : null, source: sources.has(source) ? source : 'other', level };
    if (Array.isArray(detail?.reasons)) event.reasons = detail.reasons.filter(reason => originReasons.has(reason));
    events.push(event);
  }
  const report = scan?.report;
  const reasons = {};
  for (const issue of report?.issues || []) {
    for (const reason of issue.reasons) if (originReasons.has(reason)) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { format: 'tide-diagnostics-1', at: Date.now(), logs: counts, events,
    scan: report ? { state: 'complete', target: scan.targetKind === 'memory' ? 'memory' : 'checkpoint',
      totalFishes: report.totalFishes, safeRepairable: report.safeRepairable, orphanCount: report.orphanCount, reasons,
      verified: !scan.verifyError } : { state: ['empty', 'archive_missing', 'failed'].includes(scan?.state) ? scan.state : 'unscanned' } };
}
