// Rule fixtures explicitly start without random initial life; production worlds are populated.
export * from '../www/engine.js';
import { World as Aquarium } from '../www/engine.js';
export class World extends Aquarium {
  constructor(now, id) { super(now, id, { populate: false }); }
}
