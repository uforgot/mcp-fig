// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginRevisionRuntime({ cloneData }) {
  let revision = 1;
  const changes = [];
  const revisionReadCache = new Map();
  const pendingInternalChanges = [];
  const internalChangeWindowMs = 2000;

  function current() {
    return revision;
  }

  async function revisionCached(key, loader) {
    const cacheKey = `${revision}:${key}`;
    if (revisionReadCache.has(cacheKey)) {
      return cloneData(revisionReadCache.get(cacheKey));
    }
    const value = await loader();
    revisionReadCache.set(cacheKey, cloneData(value));
    return value;
  }

  function recordChange(action, nodeIds) {
    revision += 1;
    revisionReadCache.clear();
    pendingInternalChanges.push({
      timestamp: Date.now(),
      nodeIds: new Set(nodeIds),
    });
    changes.push({
      revision: String(revision),
      action,
      nodeIds: [...nodeIds],
      timestamp: new Date().toISOString(),
    });
    if (changes.length > 500) changes.splice(0, changes.length - 500);
  }

  function recordExternalChange(event) {
    const cutoff = Date.now() - internalChangeWindowMs;
    while (pendingInternalChanges[0]?.timestamp < cutoff) {
      pendingInternalChanges.shift();
    }
    const documentChanges = event?.documentChanges;
    if (!Array.isArray(documentChanges) || documentChanges.length === 0) {
      revision += 1;
      revisionReadCache.clear();
      return;
    }
    const matchedIndexes = new Set();
    const claimedIdsByIndex = new Map();
    let isInternalBatch = true;
    for (const change of documentChanges) {
      if (change.origin !== "LOCAL") {
        isInternalBatch = false;
        continue;
      }
      const matchingIndex = pendingInternalChanges.findIndex(
        (pending, index) =>
          pending.nodeIds.has(change.id) &&
          !claimedIdsByIndex.get(index)?.has(change.id),
      );
      if (matchingIndex < 0) {
        isInternalBatch = false;
        continue;
      }
      const claimedIds = claimedIdsByIndex.get(matchingIndex) ?? new Set();
      claimedIds.add(change.id);
      claimedIdsByIndex.set(matchingIndex, claimedIds);
      matchedIndexes.add(matchingIndex);
    }
    for (const index of [...matchedIndexes].sort((a, b) => b - a)) {
      pendingInternalChanges.splice(index, 1);
    }
    if (isInternalBatch) return;
    revision += 1;
    revisionReadCache.clear();
  }

  function getChanges() {
    return cloneData(changes);
  }

  return {
    current,
    revisionCached,
    recordChange,
    recordExternalChange,
    getChanges,
  };
}
