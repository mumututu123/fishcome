// Isolate existing mechanics from ambient schools, currents and extra food.
// life.test.mjs exercises the production ambient loop, including collisions/feeding.
export * from '../www/engine.js';
import { World as Aquarium } from '../www/engine.js';
export class World extends Aquarium {
  constructor(now, id) { super(now, id, { populate: false, ambient: false }); }
}
