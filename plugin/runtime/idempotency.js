// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginIdempotency({ canonicalJson, cloneData, fail }) {
  const results = new Map();

  function prepare(fileKey, command) {
    if (!command.idempotencyKey) return undefined;
    const cacheKey = `${fileKey}\u0000${command.idempotencyKey}`;
    const fingerprint = canonicalJson({
      method: command.method,
      params: command.params || {},
    });
    const existing = results.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        fail(
          "INVALID_ARGUMENT",
          `Idempotency key ${command.idempotencyKey} was reused with a different payload.`,
        );
      }
      return {
        cacheKey,
        fingerprint,
        replayed: true,
        data: cloneData(existing.data),
      };
    }
    return { cacheKey, fingerprint, replayed: false };
  }

  function store(prepared, data) {
    if (!prepared) return;
    results.set(prepared.cacheKey, {
      fingerprint: prepared.fingerprint,
      data: cloneData(data),
    });
    if (results.size > 1_000) {
      const oldest = results.keys().next().value;
      if (oldest) results.delete(oldest);
    }
  }

  return { prepare, store };
}
