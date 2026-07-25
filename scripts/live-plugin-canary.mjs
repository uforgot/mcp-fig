import {
  DesktopPluginBridgeHost,
  DesktopPluginFigmaBridge,
} from "../dist/bridge/desktop-plugin.js";

const token = process.env.MCP_FIG_PLUGIN_TOKEN;
const port = Number(process.env.MCP_FIG_PLUGIN_PORT ?? "3847");
const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");

if (!token) {
  throw new Error("MCP_FIG_PLUGIN_TOKEN is required.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(
    "MCP_FIG_PLUGIN_PORT must be an integer between 1 and 65535.",
  );
}

const host = new DesktopPluginBridgeHost({ token, port });
const bridge = new DesktopPluginFigmaBridge(host, {
  clientId: `live-canary-${process.pid}`,
});

function findPage(node) {
  if (node.type === "PAGE") return node;
  for (const child of node.children ?? []) {
    const page = findPage(child);
    if (page) return page;
  }
  return undefined;
}

async function waitForPlugin() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await bridge.status();
    if (status.connected) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Plugin did not pair within ${timeoutMs}ms.`);
}

await host.listen();
console.log(
  JSON.stringify({
    ready: true,
    origin: `http://127.0.0.1:${port}`,
    message: "Run MCP Fig Live Bridge in a blank Figma file and pair it.",
  }),
);

try {
  const connected = await waitForPlugin();
  const document = await bridge.getDocument(connected.fileKey);
  const page = findPage(document);
  if (!page) throw new Error("No PAGE node was returned by the live document.");

  const selectionBefore = await bridge.getSelection(connected.fileKey);
  const [created] = await bridge.createNode({
    fileKey: connected.fileKey,
    parentId: page.id,
    nodeType: "FRAME",
    name: "MCP Fig Live Canary",
    props: { x: 80, y: 80, width: 320, height: 160 },
  });
  if (!created) throw new Error("Live create returned no node.");

  const [updated] = await bridge.updateNodes({
    fileKey: connected.fileKey,
    nodeIds: [created.id],
    patch: { name: "MCP Fig Live Canary - PASS" },
  });
  await bridge.layout({
    action: "apply",
    fileKey: connected.fileKey,
    nodeIds: [created.id],
    layout: {
      layoutMode: "HORIZONTAL",
      gap: 12,
      padding: 16,
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
    },
  });
  const validation = await bridge.layout({
    action: "validate",
    fileKey: connected.fileKey,
    nodeIds: [created.id],
  });
  const [verified] = await bridge.getNodes([created.id], connected.fileKey);

  console.log(
    JSON.stringify(
      {
        passed: true,
        fileKey: connected.fileKey,
        fileName: connected.fileName,
        selectionBefore,
        node: verified ?? updated,
        validation,
      },
      null,
      2,
    ),
  );
} finally {
  await host.close();
}
