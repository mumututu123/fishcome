import { World } from '/engine.js';
import { WorkerSimulation } from '/simulation-worker.js';

// Clock the game's real worker without enabling instrumentation in the shipped page.
const step = World.prototype.step, receive = WorkerSimulation.prototype.receive;
let rules;
World.prototype.step = function (...args) {
  const start = performance.now();
  const result = step.apply(this, args);
  rules = performance.now() - start;
  return result;
};
WorkerSimulation.prototype.receive = function (message) {
  const start = performance.now();
  const result = receive.call(this, message);
  if (message.kind === 'step') result.measurement = { tick: this.world.data.tick, rules, handle: performance.now() - start };
  return result;
};
