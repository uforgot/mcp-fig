// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginErrors() {
  /**
   * @param {string} code
   * @param {string} message
   * @param {boolean} [retryable]
   * @param {Record<string, unknown>} [details]
   * @returns {never}
   */
  function fail(code, message, retryable = false, details) {
    const error = /** @type {Error & { bridge?: Record<string, unknown> }} */ (
      new Error(message)
    );
    error.bridge = {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    };
    throw error;
  }

  function assertNodeIds(value) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((id) => typeof id !== "string" || !id)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "nodeIds must contain at least one explicit node ID.",
      );
    }
  }

  return { fail, assertNodeIds };
}
