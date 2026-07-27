import { readdir, readFile, rm } from "node:fs/promises";
import { saveNodeExports } from "../dist/artifacts/node-export.js";
import {
  captureFigmaDesktop,
  defaultScreenshotDirectory,
} from "../dist/artifacts/screenshot.js";
import { DesktopPluginFigmaBridge } from "../dist/bridge/desktop-plugin.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");
const inspectionPauseMs = Number(
  process.env.MCP_FIG_CANARY_INSPECTION_PAUSE_MS ?? "0",
);
const previousSessionIds = new Set(
  (process.env.MCP_FIG_AFTER_SESSION_IDS ?? "").split(",").filter(Boolean),
);
const clientId = `live-visual-${process.pid}`;
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const prefix = `MCP Fig Visual ${suffix}`;
const client = new ServiceClient({
  socketPath: process.env.MCP_FIG_SERVICE_SOCKET ?? servicePaths().socketPath,
  clientId,
});
const bridge = new DesktopPluginFigmaBridge(client, { clientId });
const createdNodeIds = [];
const artifactPaths = [];
let fileKey;
let activeLeaseId;
let runError;
let cleanupError;
let liveEvidence;

function assert(condition, message, details) {
  if (!condition)
    throw new Error(
      details === undefined
        ? message
        : `${message}: ${JSON.stringify(details)}`,
    );
}

async function pngDimensions(path) {
  const bytes = await readFile(path);
  assert(
    bytes.length >= 24 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "PNG artifact has an invalid signature or IHDR.",
    { path, byteLength: bytes.length },
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function waitForPlugin() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const session of await client.sessionsAsync()) {
      if (previousSessionIds.has(session.sessionId)) continue;
      try {
        await bridge.targetFile(session.file.key);
        await bridge.getSelection(session.file.key);
        const preparation = await bridge.visual({
          action: "prepare_capture",
          scope: "viewport",
          focus: false,
          fileKey: session.file.key,
        });
        await bridge.visual({
          action: "release_capture",
          leaseId: preparation.leaseId,
          fileKey: session.file.key,
        });
        return session;
      } catch (error) {
        if (
          error?.code !== "NOT_CONNECTED" &&
          error?.code !== "UNSUPPORTED_BY_BRIDGE"
        )
          throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Plugin with the visual domain did not complete a live read within ${timeoutMs}ms. Reload the current MCP Fig development Plugin.`,
  );
}

async function names(directory) {
  return new Set(await readdir(directory).catch(() => []));
}

async function readNodeResidue(nodeId, targetFileKey) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await bridge.getNodes([nodeId], targetFileKey);
    } catch (error) {
      if (error?.code === "NODE_NOT_FOUND") return [];
      if (error?.code !== "NOT_CONNECTED" || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return [];
}

try {
  const health = await client.health();
  const connected = await waitForPlugin();
  fileKey = connected.file.key;
  const pages = await bridge.queryNodes({
    fileKey,
    nodeType: "PAGE",
    maxDepth: 1,
    limit: 100,
  });
  const page = pages.matches[0]?.node;
  assert(page, "Live document returned no PAGE node.");

  const [frame] = await bridge.createNode({
    fileKey,
    parentId: page.id,
    nodeType: "FRAME",
    name: `${prefix} Clip Frame`,
    props: { x: 160, y: 160, width: 100, height: 100 },
    idempotencyKey: `visual-frame-${suffix}`,
  });
  assert(frame, "Visual frame creation returned no node.");
  createdNodeIds.push(frame.id);

  const [left] = await bridge.createNode({
    fileKey,
    parentId: frame.id,
    nodeType: "RECTANGLE",
    name: `${prefix} Left`,
    props: {
      x: 80,
      y: 10,
      width: 40,
      height: 40,
      fills: [
        {
          type: "SOLID",
          color: { r: 0.95, g: 0.2, b: 0.2 },
          opacity: 1,
          visible: true,
          blendMode: "NORMAL",
        },
      ],
    },
    idempotencyKey: `visual-left-${suffix}`,
  });
  assert(left, "Left clipping fixture creation returned no node.");
  createdNodeIds.push(left.id);

  const [right] = await bridge.createNode({
    fileKey,
    parentId: frame.id,
    nodeType: "RECTANGLE",
    name: `${prefix} Right`,
    props: {
      x: 85,
      y: 15,
      width: 40,
      height: 40,
      fills: [
        {
          type: "SOLID",
          color: { r: 0.2, g: 0.3, b: 0.95 },
          opacity: 1,
          visible: true,
          blendMode: "NORMAL",
        },
      ],
    },
    idempotencyKey: `visual-right-${suffix}`,
  });
  assert(right, "Right overlap fixture creation returned no node.");
  createdNodeIds.push(right.id);

  const audit = await bridge.visual({
    action: "audit",
    rootNodeIds: [frame.id],
    categories: ["layout"],
    maxDepth: 2,
    maxNodes: 20,
    maxIssues: 20,
    fileKey,
  });
  const clipping = audit.issues?.filter(
    (issue) =>
      issue.code === "CLIPPED_CONTENT" &&
      issue.nodeIds?.[0] === frame.id &&
      [left.id, right.id].includes(issue.nodeIds?.[1]),
  );
  const overlap = audit.issues?.find(
    (issue) =>
      issue.code === "OVERLAP" &&
      issue.nodeIds?.includes(left.id) &&
      issue.nodeIds?.includes(right.id),
  );
  assert(
    clipping?.length === 2,
    "Audit did not find both clipped children.",
    audit,
  );
  assert(overlap, "Audit did not find the expected sibling overlap.", audit);
  assert(
    audit.truncated === false,
    "Live audit unexpectedly truncated.",
    audit,
  );

  const exported = await bridge.exportNodes({
    fileKey,
    nodeIds: [left.id],
    format: "PNG",
    scale: 1,
  });
  const [nodeArtifact] = await saveNodeExports(exported);
  assert(nodeArtifact, "Node export artifact was not saved.");
  artifactPaths.push(nodeArtifact.path);
  const nodeDimensions = await pngDimensions(nodeArtifact.path);
  assert(
    nodeDimensions.width > 0 &&
      nodeDimensions.height > 0 &&
      nodeDimensions.width <= left.width &&
      nodeDimensions.height <= left.height,
    "Node export dimensions exceed or do not intersect the fixture node bounds.",
    { nodeDimensions, fixture: { width: left.width, height: left.height } },
  );
  const rendererClipped =
    nodeDimensions.width < left.width || nodeDimensions.height < left.height;

  const preparation = await bridge.visual({
    action: "prepare_capture",
    scope: "viewport",
    focus: false,
    fileKey,
  });
  activeLeaseId = preparation.leaseId;
  let screenshotArtifact;
  try {
    screenshotArtifact = await captureFigmaDesktop(preparation, {
      scale: 1,
      maxBytes: 8_000_000,
      delayMs: 250,
    });
    artifactPaths.push(screenshotArtifact.path);
  } finally {
    await bridge.visual({
      action: "release_capture",
      leaseId: activeLeaseId,
      fileKey,
    });
    activeLeaseId = undefined;
  }
  assert(
    nodeArtifact.path !== screenshotArtifact.path,
    "Node export and Desktop screenshot reused one artifact path.",
  );
  assert(
    nodeArtifact.mimeType === "image/png" &&
      screenshotArtifact.mimeType === "image/png",
    "Visual artifacts did not return PNG MIME types.",
  );
  assert(
    screenshotArtifact.width > left.width ||
      screenshotArtifact.height > left.height,
    "Desktop screenshot does not exceed the node export fixture bounds.",
    { node: { width: left.width, height: left.height }, screenshotArtifact },
  );

  const screenshotDirectory = defaultScreenshotDirectory();
  const beforeCap = await names(screenshotDirectory);
  const capPreparation = await bridge.visual({
    action: "prepare_capture",
    scope: "viewport",
    focus: false,
    fileKey,
  });
  activeLeaseId = capPreparation.leaseId;
  let capError;
  try {
    await captureFigmaDesktop(capPreparation, {
      scale: 1,
      maxBytes: 64_000,
      delayMs: 0,
    });
  } catch (error) {
    capError = error;
  } finally {
    await bridge.visual({
      action: "release_capture",
      leaseId: activeLeaseId,
      fileKey,
    });
    activeLeaseId = undefined;
  }
  assert(
    capError?.code === "INVALID_ARGUMENT",
    "Payload-cap capture returned the wrong outcome.",
    { code: capError?.code, message: capError?.message },
  );
  const afterCap = await names(screenshotDirectory);
  assert(
    beforeCap.size === afterCap.size &&
      [...beforeCap].every((name) => afterCap.has(name)),
    "Payload-cap rejection left a final screenshot artifact.",
    { before: [...beforeCap], after: [...afterCap] },
  );

  liveEvidence = {
    ok: true,
    health: health.status,
    sessionId: connected.sessionId,
    fileKey,
    fixture: { frameId: frame.id, childIds: [left.id, right.id] },
    audit: {
      clippingCount: clipping.length,
      overlapNodeIds: overlap.nodeIds,
      inspectedNodes: audit.inspectedNodes,
    },
    nodeExport: {
      path: nodeArtifact.path,
      byteLength: nodeArtifact.byteLength,
      ...nodeDimensions,
      fixtureBounds: { width: left.width, height: left.height },
      rendererClipped,
    },
    desktopScreenshot: {
      path: screenshotArtifact.path,
      byteLength: screenshotArtifact.byteLength,
      width: screenshotArtifact.width,
      height: screenshotArtifact.height,
    },
    payloadCap: { code: capError.code, residue: 0 },
  };
  if (Number.isFinite(inspectionPauseMs) && inspectionPauseMs > 0)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(inspectionPauseMs, 300_000)),
    );
} catch (error) {
  runError = error;
} finally {
  if (fileKey && activeLeaseId) {
    try {
      await bridge.visual({
        action: "release_capture",
        leaseId: activeLeaseId,
        fileKey,
      });
      activeLeaseId = undefined;
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (fileKey && createdNodeIds[0]) {
    let cleanupConfirmedNotFound = false;
    let deleteError;
    try {
      await bridge.deleteNodes({
        fileKey,
        nodeIds: [createdNodeIds[0]],
        idempotencyKey: `visual-cleanup-${suffix}`,
      });
    } catch (error) {
      if (error?.code === "NODE_NOT_FOUND") cleanupConfirmedNotFound = true;
      else deleteError = error;
    }
    if (!cleanupConfirmedNotFound) {
      try {
        const residual = await readNodeResidue(createdNodeIds[0], fileKey);
        if (residual.length > 0)
          cleanupError ??= new Error(
            `Visual fixture cleanup left ${residual.length} root node(s).`,
          );
      } catch (error) {
        if (error?.code !== "NODE_NOT_FOUND")
          cleanupError ??= deleteError ?? error;
      }
    }
  }
  for (const path of artifactPaths) {
    try {
      await rm(path, { force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  await bridge.close().catch((error) => {
    cleanupError ??= error;
  });
}

if (runError) throw runError;
if (cleanupError) throw cleanupError;
console.log(
  JSON.stringify({
    ...liveEvidence,
    cleanup: true,
    residualNodes: 0,
    removedArtifacts: artifactPaths.length,
  }),
);
