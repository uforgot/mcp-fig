import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const host = new DesktopPluginBridgeHost({ token, port });
const bridge = new DesktopPluginFigmaBridge(host, {
  clientId: `live-multi-agent-canary-${process.pid}`,
});
let created;
let fileKey;
const brokerClientScript = fileURLToPath(
  new URL("./broker-client-once.mjs", import.meta.url),
);

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
    if (status.connected && status.connectionState === "ready") return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Plugin did not pair within ${timeoutMs}ms.`);
}

async function stableRevision() {
  let previous;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const revision = (await bridge.status()).revision;
    if (revision && revision === previous) return revision;
    previous = revision;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Live revision did not stabilize before conflict test.");
}

function brokerRequest(clientId, method, params, targetFileKey) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [brokerClientScript], {
      env: {
        ...process.env,
        MCP_FIG_PLUGIN_TOKEN: token,
        MCP_FIG_PLUGIN_PORT: String(port),
        MCP_FIG_BROKER_REQUEST: JSON.stringify({
          clientId,
          method,
          params,
          options: { fileKey: targetFileKey },
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      let payload;
      try {
        payload = JSON.parse(stdout.trim());
      } catch {
        reject(
          new Error(
            `Broker child returned invalid output (${code}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      if (code === 0 && payload.ok) {
        resolve(payload.data);
        return;
      }
      reject(Object.assign(new Error(payload.error?.message), payload.error));
    });
  });
}

await host.listen();
console.log(
  JSON.stringify({
    ready: true,
    origin: `http://127.0.0.1:${port}`,
    message: "Run MCP Fig Live Bridge and pair it for multi-agent canary.",
  }),
);

try {
  const connected = await waitForPlugin();
  fileKey = connected.fileKey;
  if (!fileKey) throw new Error("Paired Plugin did not provide a file key.");
  const document = await bridge.getDocument(fileKey);
  const page = findPage(document);
  if (!page) throw new Error("No PAGE node was returned by the live document.");

  [created] = await bridge.createNode({
    fileKey,
    parentId: page.id,
    nodeType: "FRAME",
    name: "MCP Fig Multi-Agent Canary",
    props: { x: 720, y: 80, width: 280, height: 120 },
    idempotencyKey: `live-create-${process.pid}`,
  });
  if (!created) throw new Error("Live create returned no node.");

  const agentCount = 10;
  const isolatedResults = await Promise.all(
    Array.from({ length: agentCount }, (_, index) => {
      const name = `MCP Fig Agent ${index}`;
      return brokerRequest(
        `live-agent-${index}`,
        "node.update",
        {
          nodeIds: [created.id],
          patch: { name },
          idempotencyKey: `live-isolation-${process.pid}-${index}`,
        },
        fileKey,
      );
    }),
  );
  isolatedResults.forEach((result, index) => {
    if (result?.[0]?.name !== `MCP Fig Agent ${index}`) {
      throw new Error(`Agent ${index} received a crossed response.`);
    }
  });

  const revisionBeforeConflict = await stableRevision();
  if (!revisionBeforeConflict)
    throw new Error("No live revision was reported.");
  const conflicts = await Promise.allSettled([
    brokerRequest(
      "live-conflict-winner",
      "node.update",
      {
        nodeIds: [created.id],
        patch: { name: "MCP Fig Conflict Winner" },
        expectedRevision: revisionBeforeConflict,
        idempotencyKey: `live-conflict-winner-${process.pid}`,
      },
      fileKey,
    ),
    brokerRequest(
      "live-conflict-loser",
      "node.update",
      {
        nodeIds: [created.id],
        patch: { name: "MCP Fig Conflict Loser" },
        expectedRevision: revisionBeforeConflict,
        idempotencyKey: `live-conflict-loser-${process.pid}`,
      },
      fileKey,
    ),
  ]);
  const fulfilledConflicts = conflicts.filter(
    (result) => result.status === "fulfilled",
  );
  const rejectedConflicts = conflicts.filter(
    (result) => result.status === "rejected",
  );
  if (fulfilledConflicts.length !== 1 || rejectedConflicts.length !== 1) {
    throw new Error(
      `Same-revision conflict did not produce one winner and one loser: ${JSON.stringify(
        conflicts.map((result) =>
          result.status === "fulfilled"
            ? { status: "fulfilled" }
            : {
                status: "rejected",
                code: result.reason?.code,
                message: result.reason?.message,
                details: result.reason?.details,
              },
        ),
      )}`,
    );
  }
  if (rejectedConflicts[0].reason?.code !== "REVISION_CONFLICT") {
    throw rejectedConflicts[0].reason;
  }

  const duplicateParams = {
    nodeIds: [created.id],
    patch: { name: "MCP Fig Duplicate Nonce - PASS" },
    idempotencyKey: `live-duplicate-${process.pid}`,
  };
  const metricCountBefore = host
    .metrics()
    .filter((metric) => metric.method === "node.update").length;
  const duplicateResults = await Promise.all([
    brokerRequest("live-duplicate-a", "node.update", duplicateParams, fileKey),
    brokerRequest("live-duplicate-b", "node.update", duplicateParams, fileKey),
  ]);
  const metricCountAfter = host
    .metrics()
    .filter((metric) => metric.method === "node.update").length;
  if (
    JSON.stringify(duplicateResults[0]) !== JSON.stringify(duplicateResults[1])
  ) {
    throw new Error("Duplicate nonce callers did not receive the same result.");
  }
  if (metricCountAfter - metricCountBefore !== 1) {
    throw new Error("Duplicate nonce executed more than one Plugin mutation.");
  }

  const [verified] = await bridge.getNodes([created.id], fileKey);
  if (verified?.name !== "MCP Fig Duplicate Nonce - PASS") {
    throw new Error("Final live readback did not match.");
  }
  await bridge.deleteNodes({
    fileKey,
    nodeIds: [created.id],
    idempotencyKey: `live-cleanup-${process.pid}`,
  });
  created = undefined;

  console.log(
    JSON.stringify(
      {
        passed: true,
        fileKey,
        fileName: connected.fileName,
        agentCount,
        separateProcesses: true,
        isolatedResponses: true,
        conflictWinnerCount: fulfilledConflicts.length,
        revisionConflictCount: rejectedConflicts.length,
        duplicateMutationCount: metricCountAfter - metricCountBefore,
        finalReadback: true,
        cleanup: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (created && fileKey) {
    await bridge
      .deleteNodes({
        fileKey,
        nodeIds: [created.id],
        idempotencyKey: `live-cleanup-finally-${process.pid}`,
      })
      .catch(() => undefined);
  }
  await host.close();
}
