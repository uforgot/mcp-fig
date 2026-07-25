// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginIdentity({ figma, revision }) {
  return function fileIdentity() {
    return {
      key: figma.fileKey || `local:${figma.root.id}`,
      name: figma.root.name || "Untitled Figma file",
      revision: String(revision.current()),
    };
  };
}
