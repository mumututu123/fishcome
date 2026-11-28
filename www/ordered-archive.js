import { emptyArchiveState, mergeArchiveState, observeArchiveDependencies, prepareCompaction } from './archive.js';
import { chooseClaim } from './engine.js';
import { loadReplicaArchives } from './replica.js';

export async function prepareOrderedArchive(world, store, boundary, load, persist, diagnostics) {
  const prior = world.data.archives || emptyArchiveState(), revision = store.revision;
  const archives = mergeArchiveState(prior, boundary);
  if (boundary.at < prior.at) throw new Error('归档边界已过期');
  const next = store.prepareIndex(), mealTargets = new Set(), dependencies = observeArchiveDependencies(world);
  try {
    await loadReplicaArchives({ roots: world.data.roots, archives: boundary }, next, load, {
      current: world.data, diagnostics, persist,
      ingest: async chunks => { for (const chunk of chunks) await next.ingest(chunk, chooseClaim, mealTargets); }
    });
    const compact = await prepareCompaction(world, next, dependencies);
    const meals = Array.from(mealTargets, id => [id, next.summary.lastMeals.get(id), next.summary.grassMeals.has(id)]);
    return {
      close: dependencies.close,
      commit() {
        if (store.revision !== revision || world.data.archives?.at !== prior.at) throw new Error('归档准备期间基准已变更');
        const removed = compact() || {};
        Object.assign(store, next);
        world.data.archives = archives;
        world.dirty = true;
        return { removed, meals };
      }
    };
  } catch (error) { dependencies.close(); throw error; }
}
