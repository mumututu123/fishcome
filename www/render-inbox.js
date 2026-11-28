// The page orders accepted updates. The producer's separate port can deliver
// its packet on either side of that permission, or without one after a retry.
export class RenderInbox {
  constructor(apply, prepare) {
    this.apply = apply;
    this.prepare = prepare;
    this.offers = new Map();
    this.updates = [];
    this.revision = 0;
  }

  reset(generation) {
    for (const { port } of this.offers.values()) port.close();
    this.offers.clear();
    this.updates.length = 0;
    this.generation = generation;
    this.revision++;
  }

  offer({ id, generation, port, stableRoster }) {
    if (generation !== this.generation) { port.close(); return; }
    const entry = { port };
    this.offers.set(id, entry);
    port.onmessage = ({ data }) => {
      if (this.offers.get(id) !== entry) return;
      entry.changes = data;
      port.close();
      if (stableRoster && (!this.updates.length || this.updates[0].permit === id)) {
        entry.prepared = this.prepare(data);
        entry.revision = this.revision;
      }
      this.flush();
    };
  }

  cancel(id) {
    this.offers.get(id)?.port.close();
    this.offers.delete(id);
  }

  update(data) {
    if (data.generation !== this.generation) return;
    this.updates.push(data);
    this.flush();
  }

  flush() {
    while (this.updates.length) {
      const { permit, ...update } = this.updates[0];
      let prepared;
      if (permit !== undefined) {
        const entry = this.offers.get(permit);
        if (!entry?.changes) return;
        update.changes = entry.changes;
        if (entry.revision === this.revision) prepared = entry.prepared;
        this.cancel(permit);
      }
      this.updates.shift();
      this.apply(update, prepared);
      this.revision++;
    }
  }
}
