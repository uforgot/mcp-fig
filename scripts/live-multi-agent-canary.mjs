import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DesktopPluginFigmaBridge } from "../dist/bridge/desktop-plugin.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");
const pluginSettleMs = Number(
  process.env.MCP_FIG_CANARY_PLUGIN_SETTLE_MS ?? "2000",
);
const socketPath =
  process.env.MCP_FIG_SERVICE_SOCKET ?? servicePaths().socketPath;
const clientId = `live-multi-agent-canary-${process.pid}`;
const client = new ServiceClient({ socketPath, clientId });
const bridge = new DesktopPluginFigmaBridge(client, { clientId });
let created;
let fileKey;
let cleanupStarted = false;
let runError;
let cleanupError;
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
  throw new Error(`Multi-agent canary node ${nodeId} remained after cleanup.`);
}

async function stableRevision() {
  let previous;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const revision = (await bridge.status()).revision;
    if (revision && revision === previous) return revision;
    previous = revision;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Live revision did not stabilize.");
}

function brokerRequest(
  clientIdForRequest,
  method,
  params,
  targetFileKey,
  options = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [brokerClientScript], {
      env: {
        ...process.env,
        MCP_FIG_SERVICE_SOCKET: socketPath,
        MCP_FIG_BROKER_REQUEST: JSON.stringify({
          clientId: clientIdForRequest,
          method,
          params,
          options: { fileKey: targetFileKey, ...options },
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
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

try {
  await client.health();
  const connected = await waitForPlugin();
  fileKey = connected.fileKey;
  if (!fileKey) throw new Error("Connected Plugin did not provide a file key.");
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
            ? { status: result.status, value: result.value }
            : {
                status: result.status,
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
  const duplicateRevisionBefore = Number(await stableRevision());
  const duplicateResults = await Promise.all([
    brokerRequest("live-duplicate-a", "node.update", duplicateParams, fileKey),
    brokerRequest("live-duplicate-b", "node.update", duplicateParams, fileKey),
  ]);
  const duplicateRevisionAfter = Number(await stableRevision());
  if (
    JSON.stringify(duplicateResults[0]) !== JSON.stringify(duplicateResults[1])
  ) {
    throw new Error("Duplicate nonce callers did not receive the same result.");
  }
  const duplicateMutationCount =
    duplicateRevisionAfter - duplicateRevisionBefore;
  if (duplicateMutationCount !== 1) {
    throw new Error(
      `Duplicate nonce changed Plugin revision ${duplicateMutationCount} times.`,
    );
  }

  // Let the duplicate write tail fully settle so the one-millisecond probe is
  // dispatched instead of expiring while waiting behind a completed write.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const unknownRevisionBefore = Number(await stableRevision());
  let unknownOutcomeCode;
  let unknownOutcomeDetails;
  try {
    await brokerRequest(
      "live-unknown-outcome",
      "node.update",
      {
        nodeIds: [created.id],
        patch: { name: "MCP Fig Unknown Outcome Probe" },
        idempotencyKey: `live-unknown-outcome-${process.pid}`,
      },
      fileKey,
      { timeoutMs: 1 },
    );
  } catch (error) {
    unknownOutcomeCode = error?.code;
    unknownOutcomeDetails = error?.details;
  }
  if (unknownOutcomeCode !== "UNKNOWN_OUTCOME") {
    throw new Error(
      `Expected UNKNOWN_OUTCOME from the one-shot timeout probe, got ${unknownOutcomeCode ?? "success"}: ${JSON.stringify(unknownOutcomeDetails)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const unknownRevisionAfter = Number(await stableRevision());
  const unknownOutcomeMutationCount =
    unknownRevisionAfter - unknownRevisionBefore;
  if (unknownOutcomeMutationCount < 0 || unknownOutcomeMutationCount > 1) {
    throw new Error(
      `Unknown-outcome probe changed Plugin revision ${unknownRevisionBefore} -> ${unknownRevisionAfter} (${unknownOutcomeMutationCount}).`,
    );
  }

  const [verified] = await bridge.getNodes([created.id], fileKey);
  if (!verified)
    throw new Error("Final live readback returned no canary node.");
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
        fileKey,
        fileName: connected.fileName,
        agentCount,
        separateProcesses: true,
        isolatedResponses: true,
        conflictWinnerCount: fulfilledConflicts.length,
        revisionConflictCount: rejectedConflicts.length,
        duplicateMutationCount,
        unknownOutcomeAttempts: 1,
        unknownOutcomeRetryCount: 0,
        unknownOutcomeMutationCount,
        finalReadback: true,
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
      "Live multi-agent canary failed and cleanup did not complete.",
    );
  }
  throw cleanupError;
}
if (runError) throw runError;
