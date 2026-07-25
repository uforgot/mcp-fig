// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginRevisionRuntime({ cloneData }) {
  let revision = 1;
  const changes = [];
  const revisionReadCache = new Map();

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
    changes.push({
      revision: String(revision),
      action,
      nodeIds: [...nodeIds],
      timestamp: new Date().toISOString(),
    });
    if (changes.length > 500) changes.splice(0, changes.length - 500);
  }

  function recordExternalChange() {
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
