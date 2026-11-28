import { CONFIG } from './engine.js';
import { verifyEnvelope } from './storage.js';

import { stepDigest } from './step-digest.js';
export { stepDigest };

// Network.receive authenticates each direct control envelope. Both sides
// validate its enclosed user signatures before voting for the ordered list.
export class OrderedSteps {
  constructor({ epoch, tick, proof, leader, send, validOp }) {
    Object.assign(this, { epoch, tick, proof, leader, send, validOp });
  }
  async verifyInputs(inputs) {
    if (!Array.isArray(inputs) || inputs.length > 64) throw new Error('这一步的操作批次无效');
    const ids = new Set();
    for (const op of inputs) {
      if (op?.kind !== 'op' || op.body?.actor !== op.actor || ids.has(op.body.id) ||
          !await verifyEnvelope(op) || !await this.validOp(op)) throw new Error('这一步缺少有效的操作签名或来源');
      ids.add(op.body.id);
    }
  }
  async offer(inputs, archive) {
    if (!this.leader || this.next || this.closed) return;
    const base = this.tick, previous = this.proof;
    const slot = this.next = { tick: base + CONFIG.step, inputs, archive };
    await this.verifyInputs(inputs);
    slot.digest = await stepDigest([this.epoch, previous, slot.tick, inputs, archive ?? null]);
    if (this.next === slot && !this.closed) await this.send({ action: 'offer', epoch: this.epoch, base, previous, inputs, archive });
  }
  async receive(body) {
    if (this.closed || body.epoch !== this.epoch || body.base !== this.tick || body.previous !== this.proof) return;
    if (body.action === 'offer' && !this.leader) {
      if (this.next) return;
      const slot = this.next = { tick: this.tick + CONFIG.step, inputs: body.inputs, archive: body.archive };
      await this.verifyInputs(slot.inputs);
      slot.digest = await stepDigest([this.epoch, this.proof, slot.tick, slot.inputs, slot.archive ?? null]);
      if (this.next === slot && !this.closed) await this.reply('accept', slot);
    } else if (body.action === 'accept' && this.leader && this.next?.digest && this.next.digest === body.digest && !this.next.sealed) {
      const slot = this.next;
      await this.reply('seal', slot);
      if (this.next === slot && !this.closed) slot.sealed = true;
    } else if (body.action === 'seal' && !this.leader && this.next?.digest && this.next.digest === body.digest) {
      this.next.sealed = true;
    }
  }
  reply(action, slot) {
    return this.send({ action, epoch: this.epoch, base: this.tick, previous: this.proof, digest: slot.digest });
  }
  take(currentTick) {
    const slot = this.next;
    if (this.closed || !slot?.sealed || slot.taken || currentTick !== this.tick) return;
    slot.taken = true;
    return slot;
  }
  async complete(slot, result) {
    if (this.closed || !slot.taken || this.next !== slot || result.tick !== slot.tick) throw new Error('共同结算的步号不连续');
    if (!/^[0-9a-f]{64}$/.test(result.changesDigest)) throw new Error('共同结算缺少实际变化摘要');
    const proof = await stepDigest([slot.digest, result.changesDigest, result.outcomes]);
    if (this.closed || this.next !== slot) return;
    this.proof = proof;
    this.tick = slot.tick;
    this.next = undefined;
    return proof;
  }
  close() { this.closed = true; }
}
