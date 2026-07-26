import { DesktopPluginFigmaBridge } from "../dist/bridge/desktop-plugin.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");
const pluginSettleMs = Number(
  process.env.MCP_FIG_CANARY_PLUGIN_SETTLE_MS ?? "2000",
);
const clientId = `live-plugin-canary-${process.pid}`;
const client = new ServiceClient({
  socketPath: process.env.MCP_FIG_SERVICE_SOCKET ?? servicePaths().socketPath,
  clientId,
});
const bridge = new DesktopPluginFigmaBridge(client, { clientId });
let created;
let fileKey;
let cleanupStarted = false;
let runError;
let cleanupError;

function findPage(node) {
  if (node.type === "PAGE") return node;
  for (const child of node.children ?? []) {
    const page = findPage(child);
    if (page) return page;
  }
  return undefined;
}

async function waitForPlugin() {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await bridge.status();
    if (
      status.connected &&
      status.connectionState === "ready" &&
      Date.now() - startedAt >= pluginSettleMs
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Plugin did not connect to the service within ${timeoutMs}ms.`,
  );
}

async function waitForDeleted(nodeId, targetFileKey) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [node] = await bridge.getNodes([nodeId], targetFileKey);
      if (!node) return;
    } catch (error) {
      if (error?.code === "NODE_NOT_FOUND") return;
      if (error?.code !== "NOT_CONNECTED") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Canary node ${nodeId} remained after cleanup.`);
}

try {
  const health = await client.health();
  const connected = await waitForPlugin();
  fileKey = connected.fileKey;
  if (!fileKey) throw new Error("Connected Plugin did not provide a file key.");

  const initialSelection = await bridge.getSelection(fileKey);
  const document = await bridge.getDocument(fileKey);
  const page = findPage(document);
  if (!page) throw new Error("No PAGE node was returned by the live document.");

  [created] = await bridge.createNode({
    fileKey,
    parentId: page.id,
    nodeType: "FRAME",
    name: "MCP Fig Persistent Service Canary",
    props: { x: 80, y: 80, width: 320, height: 180 },
    idempotencyKey: `live-create-${process.pid}`,
  });
  if (!created) throw new Error("Live create returned no node.");

  await bridge.updateNodes({
    fileKey,
    nodeIds: [created.id],
    patch: {
      name: "MCP Fig Persistent Service Canary - PASS",
      opacity: 0.72,
    },
    idempotencyKey: `live-update-${process.pid}`,
  });
  const [readback] = await bridge.getNodes([created.id], fileKey);
  if (readback?.name !== "MCP Fig Persistent Service Canary - PASS") {
    throw new Error(
      `Live write/readback did not match: ${JSON.stringify(readback)}`,
    );
  }

  const deletedId = created.id;
  cleanupStarted = true;
  await bridge.deleteNodes({
    fileKey,
    nodeIds: [deletedId],
    idempotencyKey: `live-cleanup-${process.pid}`,
  });
  created = undefined;
  await waitForDeleted(deletedId, fileKey);

  console.log(
    JSON.stringify(
      {
        passed: true,
        transport: "persistent-service-ipc",
        servicePid: health.pid,
        fileKey,
        fileName: connected.fileName,
        initialSelectionCount: initialSelection.length,
        selection: true,
        read: true,
        write: true,
        readback: true,
        cleanup: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  runError = error;
} finally {
  if (created && fileKey) {
    try {
      if (!cleanupStarted) {
        cleanupStarted = true;
        await bridge.deleteNodes({
          fileKey,
          nodeIds: [created.id],
          idempotencyKey: `live-cleanup-finally-${process.pid}`,
        });
      }
      await waitForDeleted(created.id, fileKey);
      created = undefined;
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await bridge.close();
  } catch (error) {
    cleanupError ??= error;
  }
}
if (cleanupError) {
  if (runError) {
    throw new AggregateError(
      [runError, cleanupError],
      "Live Plugin canary failed and cleanup did not complete.",
    );
  }
  throw cleanupError;
}
if (runError) throw runError;
