// Preserve the enumeration order of the source character table when a cell
// enters or leaves a body. Old group arrays remain valid for the movement grid.
export class BodyMembership {
  constructor(table, activeKinds) {
    this.table = table;
    this.activeKinds = activeKinds;
    this.rank = new Map();
    this.next = 0;
    this.owners = new Map();
    this.members = new Map();
    this.active = new Set();
    this.pending = new Set();
    this.groups = new Map();
    this.first = new Map();
    for (const key of Object.keys(table)) {
      this.rank.set(key, this.next++);
      const cell = table[key];
      if (activeKinds.includes(cell.kind)) this.active.add(key);
      if (cell.kind !== 'fish') continue;
      this.addMember(key, cell.entity);
      let body = this.groups.get(cell.entity);
      if (!body) {
        this.groups.set(cell.entity, body = []);
        this.first.set(cell.entity, key);
      }
      body.push(cell);
    }
  }
  addMember(key, id) {
    this.owners.set(key, id);
    let keys = this.members.get(id);
    if (!keys) this.members.set(id, keys = new Set());
    keys.add(key);
  }
  compare(a, b) {
    const x = Number(a) >>> 0, y = Number(b) >>> 0;
    const ax = x !== 0xffffffff && String(x) === a, by = y !== 0xffffffff && String(y) === b;
    if (ax || by) return ax && by ? x - y : ax ? -1 : 1;
    return this.rank.get(a) - this.rank.get(b);
  }
  mark(key, tableEdit, deleting) {
    if (tableEdit) {
      if (deleting) this.rank.delete(key);
      else if (!Object.hasOwn(this.table, key)) this.rank.set(key, this.next++);
    }
    this.pending.add(key);
  }
  flush() {
    if (!this.pending.size) return;
    const affected = new Set();
    for (const key of this.pending) {
      const cell = this.table[key];
      if (this.activeKinds.includes(cell?.kind)) this.active.add(key); else this.active.delete(key);
      if (this.owners.has(key)) {
        const old = this.owners.get(key);
        affected.add(old);
        this.members.get(old).delete(key);
        this.owners.delete(key);
      }
      if (cell?.kind === 'fish') {
        this.addMember(key, cell.entity);
        affected.add(cell.entity);
      }
    }
    this.pending.clear();
    if (!affected.size) return;
    const groups = new Map(this.groups), first = this.first;
    let reorder = false;
    for (const id of affected) {
      const members = this.members.get(id);
      if (!members.size) {
        this.members.delete(id);
        groups.delete(id);
        first.delete(id);
        continue;
      }
      const ordered = [...members].sort((a, b) => this.compare(a, b));
      if (!groups.has(id) || first.get(id) !== ordered[0]) reorder = true;
      first.set(id, ordered[0]);
      groups.set(id, ordered.map(key => this.table[key]));
    }
    this.previous = this.groups;
    this.change = { ids: affected, sameOrder: !reorder && this.previous.size === groups.size };
    this.groups = reorder ? new Map([...groups].sort(([a], [b]) => this.compare(first.get(a), first.get(b)))) : groups;
  }
  activeCells() {
    this.flush();
    return [...this.active].sort((a, b) => this.compare(a, b)).map(key => this.table[key]);
  }
  edits(before, after) {
    if (this.previous === before && this.groups === after) return this.change;
  }
}
