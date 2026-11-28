// A fish can join only its own group or a visible leader's group. To decide
// whether a companion was still free, resolve only leaders before that turn.
export function schoolMembership(ordered, sources, neighbors, eligible, motion, all) {
  const owners = new Int32Array(ordered.length), decided = new Uint8Array(ordered.length);
  const positions = new Uint32Array(ordered.length), possible = new Array(ordered.length);
  // For dense dependencies or many requests the ordinary forward pass is cheaper.
  let budget = Math.min(256, ordered.length), full;
  function assignedBefore(point, stop) {
    const i = point.slot;
    if (owners[i]) return owners[i] <= stop;
    const leaders = possible[i] ??= sources(point);
    let cursor = positions[i];
    while (!full && cursor < leaders.length && leaders[cursor] < stop) {
      resolve(leaders[cursor++]);
      if (owners[i]) return true;
    }
    positions[i] = Math.max(positions[i], cursor);
    return false;
  }
  function resolve(i) {
    if (full || decided[i]) return;
    if (!budget--) { full = all(); return; }
    const point = ordered[i];
    if (eligible(point) && !assignedBefore(point, i)) {
      const members = [];
      for (const neighbor of neighbors(point)) {
        if (full) return;
        if (!eligible(neighbor) || assignedBefore(neighbor, i)) continue;
        members.push(neighbor.slot);
        if (members.length === 4) break;
      }
      if (members.length >= 2) {
        owners[i] = i + 1;
        for (const slot of members) owners[slot] = i + 1;
      }
    }
    decided[i] = 1;
  }
  return point => {
    if (full) return full.get(point.id);
    const assigned = eligible(point) && assignedBefore(point, ordered.length);
    return full ? full.get(point.id) : assigned ? motion(ordered[owners[point.slot] - 1]) : undefined;
  };
}
