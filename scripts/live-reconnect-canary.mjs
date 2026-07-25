import {
  DesktopPluginBridgeHost,
  DesktopPluginFigmaBridge,
} from "../dist/bridge/desktop-plugin.js";

const token = process.env.MCP_FIG_PLUGIN_TOKEN;
const port = Number(process.env.MCP_FIG_PLUGIN_PORT ?? "3847");
const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");

if (!token) throw new Error("MCP_FIG_PLUGIN_TOKEN is required.");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    "MCP_FIG_PLUGIN_PORT must be an integer between 1 and 65535.",
  );
}

let host;
let bridge;
let created;
let targetFileKey;

function createBridge() {
  host = new DesktopPluginBridgeHost({ token, port, sessionTtlMs: 5_000 });
  bridge = new DesktopPluginFigmaBridge(host, {
    clientId: `live-reconnect-canary-${process.pid}`,
  });
}

async function waitForPlugin(label) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    const status = await bridge.status();
    if (status.connected && status.connectionState === "ready") {
      return { status, elapsedMs: Date.now() - started };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms.`);
}

createBridge();
await host.listen();
console.log(
  JSON.stringify({
    ready: true,
    origin: `http://127.0.0.1:${port}`,
    message: "Run MCP Fig Live Bridge and pair it for reconnect canary.",
  }),
);

try {
  const initial = await waitForPlugin("Initial Plugin session");
  const fileKey = initial.status.fileKey;
  if (!fileKey) throw new Error("Paired Plugin did not provide a file key.");
  targetFileKey = fileKey;
  const selectionBefore = await bridge.getSelection(fileKey);

  await host.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  createBridge();
  const restartStarted = Date.now();
  await host.listen();
  const recovered = await waitForPlugin("Restarted Plugin session");
  const recoveryMs = Date.now() - restartStarted;

  const selectionAfter = await bridge.getSelection(fileKey);
  const document = await bridge.getDocument(fileKey);
  const page = document.children?.find((node) => node.type === "PAGE");
  if (!page) throw new Error("No PAGE node was returned after reconnect.");

  [created] = await bridge.createNode({
    fileKey,
    parentId: page.id,
    nodeType: "FRAME",
    name: "MCP Fig Reconnect Canary - PASS",
    props: { x: 440, y: 80, width: 240, height: 120 },
  });
  if (!created) throw new Error("Post-reconnect write returned no node.");
  const [verified] = await bridge.getNodes([created.id], fileKey);
  if (verified?.name !== "MCP Fig Reconnect Canary - PASS") {
    throw new Error("Post-reconnect write readback did not match.");
  }
  await bridge.deleteNodes({ fileKey, nodeIds: [created.id] });
  created = undefined;

  console.log(
    JSON.stringify(
      {
        passed: true,
        fileKey,
        fileName: recovered.status.fileName,
        recoveryMs,
        initialPairMs: initial.elapsedMs,
        selectionBefore,
        selectionAfter,
        readAfterReconnect: true,
        writeAfterReconnect: true,
        cleanup: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (created && bridge && targetFileKey) {
    await bridge
      .deleteNodes({ fileKey: targetFileKey, nodeIds: [created.id] })
      .catch(() => undefined);
  }
  await host?.close();
}
