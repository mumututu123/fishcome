import { World } from './engine.js';
import { Renderer, observationCamera } from './renderer.js';
import { applyResult } from './simulation-client.js';

let world, painter, generation, roster = [], active, animation;
const paintedKeys = ['paintedCells', 'paintedFish', 'paintedFishOwners', 'paintedCoordinates'];
const preparedFrames = Array.from({ length: 4 }, () => ({}));
let slot = 0;

function paint(now) {
  animation = undefined;
  if (!active || !world) return;
  const follow = painter.follow;
  if (follow) {
    const fish = painter.fishPose(world, follow.id, now);
    if (fish) painter.camera = observationCamera(fish, follow.body, painter.camera, follow.rect,
      painter.width, painter.height, painter.cell * painter.scale);
  }
  const frame = preparedFrames[slot++ % preparedFrames.length];
  for (const key of paintedKeys) painter[key] = frame[key];
  painter.draw(world, now);
  for (const key of paintedKeys) frame[key] = painter[key];
  frame.generation = generation;
  frame.at = performance.timeOrigin + performance.now();
  frame.paintedLeft = painter.paintedLeft;
  frame.paintedTop = painter.paintedTop;
  frame.paintedSize = painter.paintedSize;
  if (painter.viewport && !painter.viewport.remaining && painter.imageGeneration !== generation) {
    painter.imageGeneration = generation;
    postMessage({ ready: generation });
  }
  animation = requestAnimationFrame(paint);
}

function updateView({ dimensions, ...view }) {
  if (painter.width !== dimensions.width || painter.height !== dimensions.height || painter.dpr !== dimensions.dpr) painter.resize(dimensions);
  Object.assign(painter, view);
}

onmessage = ({ data }) => {
  if (data.canvas) painter = new Renderer(data.canvas, data.view.dimensions);
  if (data.view) updateView(data.view);
  if (data.base) {
    generation = data.generation;
    world = new World(data.base.tick, 'draw-owner', { populate: false });
    world.data = { ...world.data, ...data.base };
    roster = [];
    painter.cellIndex(world);
  }
  if (data.active !== undefined) active = data.active;
  if (data.generation === generation && data.changes) {
    if (data.roster) roster = data.roster;
    const changes = applyResult(world, { patch: data.changes, foodRevision: 0 }, roster);
    painter.worldChanged(world, changes, undefined, data.startedAt - performance.timeOrigin);
  }
  if (data.generation === generation && data.swims) painter.presentSwims(world, data.swims, data.startedAt - performance.timeOrigin);
  if (data.hit) {
    const [request, x, y, at] = data.hit;
    let frame;
    if (data.generation === generation) for (const candidate of preparedFrames) {
      if (candidate.generation === generation && candidate.at <= at && (!frame || candidate.at > frame.at)) frame = candidate;
    }
    postMessage({ request, hit: frame ? painter.hit(x, y, frame) : null });
  }
  if (active && world && animation === undefined) animation = requestAnimationFrame(paint);
};
