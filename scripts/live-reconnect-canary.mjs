import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DesktopPluginFigmaBridge } from "../dist/bridge/desktop-plugin.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");
const pluginSettleMs = Number(
  process.env.MCP_FIG_CANARY_PLUGIN_SETTLE_MS ?? "2000",
);
const paths = servicePaths();
const socketPath = process.env.MCP_FIG_SERVICE_SOCKET ?? paths.socketPath;
const clientId = `live-reconnect-canary-${process.pid}`;
const client = new ServiceClient({ socketPath, clientId });
const bridge = new DesktopPluginFigmaBridge(client, { clientId });
const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const brokerClientScript = fileURLToPath(
  new URL("./broker-client-once.mjs", import.meta.url),
);

function runNode(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `Child exited ${code}.`));
    });
  });
}

async function waitForReady({ newerThan } = {}) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await client.status();
      const bridgeStatus = status.bridge;
      if (
        bridgeStatus.connected &&
        bridgeStatus.connectionState === "ready" &&
        (newerThan || Date.now() - startedAt >= pluginSettleMs) &&
        (!newerThan ||
          (status.daemon.lastHandshakeAt &&
            status.daemon.lastHandshakeAt !== newerThan))
      ) {
        return status;
      }
    } catch {
      // A daemon or Plugin restart creates an expected unavailable window.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Service and Plugin did not recover within ${timeoutMs}ms.`);
}

async function childDocumentRead(fileKey) {
  const result = await runNode([brokerClientScript], {
    ...process.env,
    MCP_FIG_SERVICE_SOCKET: socketPath,
    MCP_FIG_BROKER_REQUEST: JSON.stringify({
      clientId: `live-mcp-restart-child-${process.pid}`,
      method: "document.get",
      params: {},
      options: { fileKey },
    }),
  });
  const payload = JSON.parse(result.stdout.trim());
  if (!payload.ok || !payload.data) {
    throw new Error(
      "Fresh MCP child process could not read the live document.",
    );
  }
}

try {
  const initial = await waitForReady();
  const fileKey = initial.bridge.fileKey;
  if (!fileKey) throw new Error("Connected Plugin did not provide a file key.");
  const initialPort = initial.daemon.plugin.port;
  const initialHandshakeAt = initial.daemon.lastHandshakeAt;
  const initialDocument = await bridge.getDocument(fileKey);

  await runNode([cliPath, "service", "restart"]);
  const afterServiceRestart = await waitForReady({
    newerThan: initialHandshakeAt,
  });
  if (afterServiceRestart.daemon.plugin.port !== initialPort) {
    throw new Error("Service restart changed the saved Plugin port.");
  }
  const afterServiceDocument = await bridge.getDocument(fileKey);
  if (afterServiceDocument.id !== initialDocument.id) {
    throw new Error("Service restart recovered a different Figma document.");
  }

  await childDocumentRead(fileKey);

  const beforePluginRestart = await client.status();
  console.log(
    JSON.stringify({
      phase: "awaiting_plugin_restart",
      action: "Restart MCP Fig Live Bridge in the same Figma file.",
      fileKey,
    }),
  );
  const afterPluginRestart = await waitForReady({
    newerThan: beforePluginRestart.daemon.lastHandshakeAt,
  });
  const afterPluginDocument = await bridge.getDocument(fileKey);
  if (afterPluginDocument.id !== initialDocument.id) {
    throw new Error("Plugin restart recovered a different Figma document.");
  }

  console.log(
    JSON.stringify(
      {
        passed: true,
        transport: "persistent-service-ipc",
        fileKey,
        fileName: afterPluginRestart.bridge.fileName,
        portReentryCount: 0,
        tokenReentryCount: 0,
        serviceRestartRecovered: true,
        mcpProcessRestartRecovered: true,
        pluginRestartRecovered: true,
        savedReconnect: true,
      },
      null,
      2,
    ),
  );
} finally {
  await bridge.close();
}
