import { breedingForBroadcast, stopBreedingBroadcast } from './breeding.js';

function unseen(records, sent) {
  return sent ? Object.fromEntries(Object.entries(records).filter(([id]) => !sent.has(id))) : records;
}

export class WorldBroadcast {
  reset() {
    if (this.previous) stopBreedingBroadcast(this.previous.breeding);
    this.previous = null;
  }

  async send(network, data, now = Date.now()) {
    if (!network.live().length) { this.reset(); return; }
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.previous && this.previous.breeding !== data.breeding) this.reset();
      const previous = this.previous && now - this.previous.fullAt <= 30000 ? this.previous : null;
      const chars = {}, charMarks = new Map(), travel = {}, travelMarks = new Map();
      for (const [id, c] of Object.entries(data.chars)) {
        const mark = `${c.kind}:${c.entity}:${c.x}:${c.y}:${c.ch}:${c.color}:${c.editAt || 0}:${c.moveAt || 0}:${JSON.stringify(c.path)}`;
        charMarks.set(id, mark);
        if (previous?.chars.get(id) !== mark) chars[id] = c;
      }
      for (const [id, record] of Object.entries(data.travel)) {
        const mark = JSON.stringify(record);
        travelMarks.set(id, mark);
        if (previous?.travel.get(id) !== mark) travel[id] = record;
      }
      // The world can advance while the signature is being calculated.
      const packet = structuredClone({
        protocol: 1, roots: data.roots, terrain: data.terrain, tick: data.tick,
        seaweedHour: data.seaweedHour, bubbleMinute: data.bubbleMinute, bubbles: data.bubbles,
        chars, fishes: data.fishes, breeding: breedingForBroadcast(data.breeding, !previous),
        contacts: data.contacts, contactAt: data.contactAt, scenes: data.scenes, participants: data.participants,
        ops: unseen(data.ops, previous?.ops), notices: [], chats: unseen(data.chats, previous?.chats),
        chatSources: unseen(data.chatSources, previous?.chatSources), travel, life: data.life,
        legends: data.legends, ecology: data.ecology, archives: data.archives
      });
      this.previous = {
        fullAt: previous?.fullAt ?? now, breeding: data.breeding, chars: charMarks, travel: travelMarks, ops: new Set(Object.keys(data.ops)),
        chats: new Set(Object.keys(data.chats)), chatSources: new Set(Object.keys(data.chatSources))
      };
      return await network.broadcast('world', { delta: !!previous, world: packet });
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
