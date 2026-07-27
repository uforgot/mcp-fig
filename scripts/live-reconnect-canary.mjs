import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DesktopPluginFigmaBridge } from "../dist/bridge/desktop-plugin.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");
const requireSleepWake = process.env.MCP_FIG_CANARY_REQUIRE_SLEEP_WAKE === "1";
const expectedFileKeys = new Set(
  (process.env.MCP_FIG_CANARY_FILE_KEYS ?? "").split(",").filter(Boolean),
);
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
const execFile = promisify(execFileCallback);

function assert(condition, message, details) {
  if (!condition)
    throw new Error(
      details === undefined
        ? message
        : `${message}: ${JSON.stringify(details)}`,
    );
}

async function credentialMetadata() {
  const [info, content] = await Promise.all([
    stat(paths.credentialPath),
    readFile(paths.credentialPath),
  ]);
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    mode: info.mode & 0o777,
    uid: info.uid,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

async function latestWakeFingerprint() {
  const { stdout } = await execFile("/usr/bin/pmset", ["-g", "log"], {
    maxBuffer: 10_000_000,
  });
  const latestWake = stdout
    .split("\n")
    .filter((line) => /\sWake from\s/.test(line))
    .at(-1);
  return latestWake
    ? createHash("sha256").update(latestWake).digest("hex")
    : null;
}

async function assertSingleListener(expectedPid) {
  const { stdout } = await execFile("/usr/sbin/lsof", [
    "-nP",
    `-iTCP:${String((await client.health()).plugin.port)}`,
    "-sTCP:LISTEN",
  ]);
  const rows = stdout.trim().split("\n").slice(1).filter(Boolean);
  assert(rows.length === 1, "Production Plugin port must have one listener.", {
    listenerCount: rows.length,
  });
  const columns = rows[0].trim().split(/\s+/);
  assert(
    Number(columns[1]) === expectedPid,
    "Listener PID differs from daemon PID.",
  );
  assert(
    rows[0].includes("127.0.0.1:") && rows[0].includes("(LISTEN)"),
    "Plugin listener must stay loopback-only.",
  );
}

async function assertSessionRouting() {
  const sessions = await client.sessionsAsync();
  const fileKeys = sessions.map((session) => session.file.key);
  assert(
    new Set(fileKeys).size === fileKeys.length,
    "Ready sessions contain duplicate file keys.",
    { fileKeys },
  );
  for (const fileKey of expectedFileKeys) {
    assert(fileKeys.includes(fileKey), "Expected Figma file is not ready.", {
      fileKey,
      readyFileKeys: fileKeys,
    });
    await bridge.targetFile(fileKey);
    await bridge.getDocument(fileKey);
  }
  return sessions;
}

async function assertOperationalState(status, credentialBefore) {
  assert(status.daemon.sessions.length > 0, "No ready Plugin session.");
  await assertSingleListener(status.daemon.pid);
  const sessions = await assertSessionRouting();
  assert(
    JSON.stringify(await credentialMetadata()) ===
      JSON.stringify(credentialBefore),
    "Credential metadata changed during recovery.",
  );
  return sessions;
}

async function waitForSleepWakeGap() {
  const wakeBefore = await latestWakeFingerprint();
  console.log(
    JSON.stringify({
      phase: "awaiting_sleep_wake",
      action: "Put this Mac to sleep, then wake and unlock it.",
    }),
  );
  const deadline = Date.now() + timeoutMs;
  let previousTick = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const currentTick = Date.now();
    const gapMs = currentTick - previousTick;
    if (gapMs >= 5_000 && (await latestWakeFingerprint()) !== wakeBefore) {
      return gapMs;
    }
    previousTick = currentTick;
  }
  throw new Error(
    `No macOS sleep-wake gap with a new system Wake event observed within ${timeoutMs}ms.`,
  );
}

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
  const deadline = Date.now() + timeoutMs;
  let candidateHandshake;
  let candidateSince;
  while (Date.now() < deadline) {
    try {
      const status = await client.status();
      const bridgeStatus = status.bridge;
      const handshake = status.daemon.lastHandshakeAt;
      const qualifies =
        bridgeStatus.connected &&
        bridgeStatus.connectionState === "ready" &&
        handshake &&
        (!newerThan || handshake !== newerThan);
      if (qualifies) {
        if (candidateHandshake !== handshake) {
          candidateHandshake = handshake;
          candidateSince = Date.now();
        }
        if (Date.now() - candidateSince >= pluginSettleMs) return status;
      } else {
        candidateHandshake = undefined;
        candidateSince = undefined;
      }
    } catch {
      candidateHandshake = undefined;
      candidateSince = undefined;
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
  const credentialBefore = await credentialMetadata();
  const initial = await waitForReady();
  const initialSessions = await assertOperationalState(
    initial,
    credentialBefore,
  );
  const fileKey = initial.bridge.fileKey;
  if (!fileKey) throw new Error("Connected Plugin did not provide a file key.");
  const initialPort = initial.daemon.plugin.port;
  const initialPid = initial.daemon.pid;
  const initialHandshakeAt = initial.daemon.lastHandshakeAt;
  const initialDocument = await bridge.getDocument(fileKey);

  await runNode([cliPath, "service", "restart"]);
  const afterServiceRestart = await waitForReady({
    newerThan: initialHandshakeAt,
  });
  assert(
    afterServiceRestart.daemon.pid !== initialPid,
    "Service restart did not replace the daemon PID.",
  );
  await assertOperationalState(afterServiceRestart, credentialBefore);
  if (afterServiceRestart.daemon.plugin.port !== initialPort) {
    throw new Error("Service restart changed the saved Plugin port.");
  }
  const afterServiceDocument = await bridge.getDocument(fileKey);
  if (afterServiceDocument.id !== initialDocument.id) {
    throw new Error("Service restart recovered a different Figma document.");
  }

  await childDocumentRead(fileKey);
  const afterMcpRestart = await client.status(fileKey);
  await assertOperationalState(afterMcpRestart, credentialBefore);

  const beforePluginRestart = await client.status(fileKey);
  const beforePluginSessions = await client.sessionsAsync();
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
  const afterPluginSessions = await assertOperationalState(
    afterPluginRestart,
    credentialBefore,
  );
  assert(
    afterPluginSessions.some(
      (session) =>
        session.file.key === fileKey &&
        !beforePluginSessions.some(
          (before) => before.sessionId === session.sessionId,
        ),
    ),
    "Plugin restart did not replace the targeted file session.",
  );
  const afterPluginDocument = await bridge.getDocument(fileKey);
  if (afterPluginDocument.id !== initialDocument.id) {
    throw new Error("Plugin restart recovered a different Figma document.");
  }

  let sleepWakeGapMs = 0;
  if (requireSleepWake) {
    const beforeSleep = await client.status(fileKey);
    const beforeSleepSessions = await client.sessionsAsync();
    const beforeSleepTarget = beforeSleepSessions.find(
      (session) => session.file.key === fileKey,
    );
    assert(beforeSleepTarget, "Target file session missing before sleep.");
    sleepWakeGapMs = await waitForSleepWakeGap();
    const afterWake = await waitForReady({
      newerThan: beforeSleep.daemon.lastHandshakeAt,
    });
    const afterWakeSessions = await assertOperationalState(
      afterWake,
      credentialBefore,
    );
    const afterWakeTarget = afterWakeSessions.find(
      (session) => session.file.key === fileKey,
    );
    assert(
      afterWakeTarget && afterWakeTarget.sentAt !== beforeSleepTarget.sentAt,
      "Sleep-wake did not refresh the targeted file handshake.",
    );
    const afterWakeDocument = await bridge.getDocument(fileKey);
    assert(
      afterWakeDocument.id === initialDocument.id,
      "Sleep-wake recovered a different Figma document.",
    );
  }

  console.log(
    JSON.stringify(
      {
        passed: true,
        transport: "persistent-service-ipc",
        fileKey,
        fileName: afterPluginRestart.bridge.fileName,
        initialReadySessionCount: initialSessions.length,
        expectedFileKeys: [...expectedFileKeys],
        listenerCount: 1,
        credentialMetadataUnchanged: true,
        portReentryCount: 0,
        tokenReentryCount: 0,
        serviceRestartRecovered: true,
        mcpProcessRestartRecovered: true,
        pluginRestartRecovered: true,
        sleepWakeRecovered: requireSleepWake,
        sleepWakeGapMs,
        savedReconnect: true,
      },
      null,
      2,
    ),
  );
} finally {
  await bridge.close();
}
