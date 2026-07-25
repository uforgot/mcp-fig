// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginDataHelpers() {
  function cloneData(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalJson(value) {
    function normalize(input) {
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === "object") {
        const output = {};
        for (const key of Object.keys(input).sort()) {
          output[key] = normalize(input[key]);
        }
        return output;
      }
      return input;
    }
    return JSON.stringify(normalize(value));
  }

  return { cloneData, canonicalJson };
}
