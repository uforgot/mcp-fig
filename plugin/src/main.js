figma.showUI(__html__, { width: 360, height: 300, themeColors: true });

const dataHelpers = createPluginDataHelpers();
const errors = createPluginErrors();
const metrics = createPluginMetrics();
const revision = createPluginRevisionRuntime(dataHelpers);
const fileIdentity = createPluginIdentity({ figma, revision });
const idempotency = createPluginIdempotency({ ...dataHelpers, ...errors });
const nodeHelpers = createPluginNodeHelpers({
  figma,
  fail: errors.fail,
  countSceneTraversal: metrics.countSceneTraversal,
});
const coreNode = createCoreNodeDomain({
  figma,
  ...errors,
  ...dataHelpers,
  revisionCached: revision.revisionCached,
  recordChange: revision.recordChange,
  getChanges: revision.getChanges,
  countSceneTraversal: metrics.countSceneTraversal,
  ...nodeHelpers,
});
const layout = createLayoutDomain({
  ...errors,
  cloneData: dataHelpers.cloneData,
  countSceneTraversal: metrics.countSceneTraversal,
  recordChange: revision.recordChange,
  ...nodeHelpers,
});
const component = createComponentDomain({
  figma,
  fail: errors.fail,
  revisionCached: revision.revisionCached,
  countSceneTraversal: metrics.countSceneTraversal,
  recordChange: revision.recordChange,
  ...nodeHelpers,
});
const instance = createInstanceDomain({
  ...errors,
  recordChange: revision.recordChange,
  ...nodeHelpers,
  resolveComponent: component.resolveComponent,
});
const tokens = createTokensDomain({
  figma,
  fail: errors.fail,
  revisionCached: revision.revisionCached,
  countSceneTraversal: metrics.countSceneTraversal,
  recordChange: revision.recordChange,
  nodeById: nodeHelpers.nodeById,
});

async function execute(command) {
  const identity = fileIdentity();
  if (command.fileKey !== identity.key) {
    errors.fail(
      "FILE_NOT_TARGETED",
      `Command targets ${command.fileKey}, but this plugin owns ${identity.key}.`,
      true,
    );
  }
  const prepared = idempotency.prepare(identity.key, command);
  if (prepared?.replayed) return prepared.data;
  if (
    command.expectedRevision &&
    command.expectedRevision !== identity.revision
  ) {
    errors.fail(
      "REVISION_CONFLICT",
      `Expected revision ${command.expectedRevision}, but file ${identity.key} is at ${identity.revision}.`,
      true,
      {
        fileKey: identity.key,
        expectedRevision: command.expectedRevision,
        actualRevision: identity.revision,
        targetNodeIds: command.targetNodeIds || [],
      },
    );
  }

  let result;
  if (
    command.method.startsWith("document.") ||
    ["selection.get", "changes.get"].includes(command.method) ||
    command.method.startsWith("node.")
  ) {
    result = await coreNode.command(command.method, command.params || {});
  } else if (command.method === "layout") {
    result = await layout.command(command.params || {});
  } else if (command.method === "component") {
    result = await component.command(command.params || {});
  } else if (command.method === "instance") {
    result = await instance.command(command.params || {});
  } else if (command.method === "tokens") {
    result = await tokens.command(command.params || {});
  } else {
    errors.fail(
      "UNSUPPORTED_BY_BRIDGE",
      `Unknown Desktop Plugin method ${command.method}.`,
    );
  }
  idempotency.store(prepared, result);
  return result;
}

figma.ui.onmessage = async (message) => {
  if (message?.type === "bridge-bootstrap") {
    figma.ui.postMessage({ type: "bridge-bootstrap", file: fileIdentity() });
    return;
  }
  if (message?.type !== "bridge-command" || !message.command) return;
  const requestId = message.command.requestId;
  metrics.start();
  const figmaApiStartedAt = new Date().toISOString();
  try {
    const data = await execute(message.command);
    const figmaApiCompletedAt = new Date().toISOString();
    figma.ui.postMessage({
      type: "bridge-result",
      requestId,
      ok: true,
      data,
      revision: String(revision.current()),
      figmaApiStartedAt,
      figmaApiCompletedAt,
      sceneTraversalNodeCount: metrics.sceneTraversalNodeCount(),
    });
  } catch (error) {
    const figmaApiCompletedAt = new Date().toISOString();
    const bridge = error?.bridge || {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
    figma.ui.postMessage({
      type: "bridge-result",
      requestId,
      ok: false,
      error: bridge,
      revision: String(revision.current()),
      figmaApiStartedAt,
      figmaApiCompletedAt,
      sceneTraversalNodeCount: metrics.sceneTraversalNodeCount(),
    });
  } finally {
    metrics.finish();
  }
};

figma.ui.postMessage({ type: "bridge-bootstrap", file: fileIdentity() });

figma.on("selectionchange", () => {
  figma.ui.postMessage({ type: "bridge-bootstrap", file: fileIdentity() });
});

async function initializeDocumentChangeTracking() {
  await figma.loadAllPagesAsync();
  figma.on("documentchange", () => {
    revision.recordExternalChange();
    figma.ui.postMessage({ type: "bridge-bootstrap", file: fileIdentity() });
  });
}

void initializeDocumentChangeTracking();
