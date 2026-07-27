// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginIdentity({ figma, revision }) {
  const localFileIdKey = "mcp-fig.local-file-id.v1";
  const validLocalFileId = (value) =>
    typeof value === "string" && /^[a-z0-9-]{16,80}$/.test(value);
  const existingLocalFileId = figma.root.getPluginData(localFileIdKey);
  let localFileId = validLocalFileId(existingLocalFileId)
    ? existingLocalFileId
    : "";
  if (!figma.fileKey && !localFileId) {
    const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 14)}`;
    figma.root.setPluginData(localFileIdKey, generated);
    const persisted = figma.root.getPluginData(localFileIdKey);
    localFileId = validLocalFileId(persisted) ? persisted : generated;
  }
  const localFileName = figma.root.name || "Untitled Figma file";
  let localFileNameKey = "";
  for (let index = 0; index < localFileName.length; index += 1) {
    localFileNameKey += localFileName
      .charCodeAt(index)
      .toString(16)
      .padStart(4, "0");
  }
  const fileKey = figma.fileKey || `local:${localFileId}:${localFileNameKey}`;

  return function fileIdentity() {
    return {
      key: fileKey,
      name: localFileName,
      revision: String(revision.current()),
    };
  };
}
