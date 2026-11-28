import { World } from '/engine.js';
import { WorkerSimulation } from '/simulation-worker.js';

// Clock the game's real worker without enabling instrumentation in the shipped page.
const step = World.prototype.step, receive = WorkerSimulation.prototype.receive;
let rules, prepared;
World.prototype.step = function (...args) {
  const start = performance.now();
  const result = step.apply(this, args);
  rules = performance.now() - start;
  return result;
};
WorkerSimulation.prototype.receive = function (message) {
  if (message.kind === 'delivery-ping') return { tick: this.world.data.tick };
  if (message.kind === 'prepare-delivery') {
    if (prepared) throw new Error('已有等待交付的生态步');
    const start = performance.now();
    const result = receive.call(this, { kind: 'step', base: message.base, names: [], foods: [] });
    prepared = { base: message.base, result };
    return { elapsed: performance.now() - start };
  }
  if (prepared) {
    if (message.kind !== 'step' || message.base !== prepared.base || message.names.length || message.foods.length || message.archives?.length)
      throw new Error('预计算对照和真实生态请求不匹配');
    const { result } = prepared;
    prepared = undefined;
    return result;
  }
  const start = performance.now();
  const result = receive.call(this, message);
  if (message.kind === 'step') result.measurement = { tick: this.world.data.tick, rules, handle: performance.now() - start };
  return result;
};
