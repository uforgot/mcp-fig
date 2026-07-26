import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ServiceClient } from "../dist/service/client.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const directory = await mkdtemp(join(tmpdir(), "mcp-fig-service-smoke-"));
const socketPath = join(directory, "service.sock");
const token = "smoke-plugin-token";
const fileKey = "service-smoke-file";
const sessionId = "service-smoke-session";
const controller = new AbortController();

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to reserve a service smoke port.");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForHealth(client, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Service exited before readiness (${child.exitCode}).`);
    try {
      return await client.health();
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error("Service did not become healthy.");
}

async function fetchOk(url, init) {
  const response = await fetch(url, init);
  if (!response.ok && response.status !== 204) {
    throw new Error(`${response.status}: ${await response.text()}`);
  }
  return response;
}

async function fakePlugin(baseUrl) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  await fetchOk(`${baseUrl}/v1/session/handshake`, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      protocol: "mcp-fig-plugin/v1",
      sessionId,
      clientId: "service-smoke-plugin-ui",
      file: { key: fileKey, name: "Service smoke", revision: "1" },
      capabilities: ["selection.read"],
      sentAt: new Date().toISOString(),
    }),
  });
  for (let handled = 0; handled < 10; handled += 1) {
    const response = await fetchOk(`${baseUrl}/v1/session/${sessionId}/next`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 204) {
      handled -= 1;
      continue;
    }
    const command = await response.json();
    await fetchOk(`${baseUrl}/v1/session/${sessionId}/result`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        protocol: "mcp-fig-plugin/v1",
        requestId: command.requestId,
        clientId: command.clientId,
        sessionId: command.sessionId,
        fileKey: command.fileKey,
        ok: true,
        data: [command.clientId],
        receivedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    });
  }
}

function runClient(index) {
  const clientId = `service-smoke-agent-${index}`;
  const source = `
    import { createDefaultBridge } from './dist/bridge/factory.js';
    import { loadConfig } from './dist/config.js';
    import { ServiceClient } from './dist/service/client.js';
    const lowLevel = new ServiceClient({ socketPath: process.env.MCP_FIG_SERVICE_SOCKET, clientId: process.env.CLIENT_ID });
    const health = await lowLevel.health();
    const bridge = createDefaultBridge(loadConfig({
      MCP_FIG_DESKTOP_MODE: 'service',
      MCP_FIG_SERVICE_SOCKET: process.env.MCP_FIG_SERVICE_SOCKET,
      MCP_FIG_PLUGIN_CLIENT_ID: process.env.CLIENT_ID,
      MCP_FIG_PLUGIN_FILE_KEY: process.env.FILE_KEY,
    }));
    const data = await bridge.getSelection(process.env.FILE_KEY);
    await bridge.close();
    process.stdout.write(JSON.stringify({ healthPid: health.pid, data }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: repo,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      MCP_FIG_SERVICE_SOCKET: socketPath,
      CLIENT_ID: clientId,
      FILE_KEY: fileKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveClient, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `Client ${index} failed (code=${code}, signal=${signal}): ${stderr}`,
          ),
        );
        return;
      }
      resolveClient({ clientId, ...JSON.parse(stdout) });
    });
  });
}

async function assertPortOwned(port) {
  const probe = createServer();
  await new Promise((resolveProbe, reject) => {
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolveProbe();
      else reject(error);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close();
      reject(new Error("Plugin port had no owner."));
    });
  });
}

async function assertPortReleased(port) {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose) => probe.close(resolveClose));
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

const port = await freePort();
const daemon = spawn(process.execPath, ["dist/service/daemon.js"], {
  cwd: repo,
  env: {
    ...process.env,
    MCP_FIG_PLUGIN_TOKEN: token,
    MCP_FIG_PLUGIN_PORT: String(port),
    MCP_FIG_SERVICE_SOCKET: socketPath,
    MCP_FIG_VERSION: "service-smoke",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let daemonStdout = "";
let daemonStderr = "";
daemon.stdout.setEncoding("utf8");
daemon.stderr.setEncoding("utf8");
daemon.stdout.on("data", (chunk) => (daemonStdout += chunk));
daemon.stderr.on("data", (chunk) => (daemonStderr += chunk));

try {
  const client = new ServiceClient({ socketPath });
  const health = await waitForHealth(client, daemon);
  if (health.pid !== daemon.pid)
    throw new Error("Health PID is not the daemon PID.");
  if (JSON.stringify(health).includes(token))
    throw new Error("Health response exposed the Plugin token.");
  if (((await stat(socketPath)).mode & 0o777) !== 0o600)
    throw new Error("Service socket is not 0600.");
  await assertPortOwned(port);

  const plugin = fakePlugin(`http://127.0.0.1:${port}`);
  const clients = await Promise.all(
    Array.from({ length: 10 }, (_, index) => runClient(index)),
  );
  await plugin;
  const status = await client.status(fileKey);
  if (status.daemon.pid !== daemon.pid || status.daemon.sessions.length !== 1)
    throw new Error(
      "Service status did not report the daemon and Plugin identity.",
    );
  if (JSON.stringify(status).includes(token))
    throw new Error("Service status exposed the Plugin token.");
  if (clients.some((item) => item.healthPid !== daemon.pid))
    throw new Error("Clients did not share one daemon owner.");
  if (clients.some((item) => item.data[0] !== item.clientId))
    throw new Error("Concurrent client responses crossed request boundaries.");

  const commandLine = await new Promise((resolveCommand, reject) => {
    const ps = spawn("/bin/ps", ["-o", "command=", "-p", String(daemon.pid)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    ps.stdout.setEncoding("utf8");
    ps.stdout.on("data", (chunk) => (output += chunk));
    ps.once("exit", (code) =>
      code === 0 ? resolveCommand(output) : reject(new Error("ps failed")),
    );
  });
  if (commandLine.includes(token))
    throw new Error("Plugin token was exposed in process arguments.");
  if (daemonStdout !== "")
    throw new Error(`Daemon polluted stdout: ${daemonStdout}`);

  daemon.kill("SIGTERM");
  const exitCode = await waitForExit(daemon);
  if (exitCode !== 0)
    throw new Error(`Daemon shutdown failed (${exitCode}): ${daemonStderr}`);
  await assertPortReleased(port);
  await stat(socketPath).then(
    () => {
      throw new Error("Service socket remained after shutdown.");
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );

  console.log(
    JSON.stringify(
      {
        daemonPid: health.pid,
        clients: clients.length,
        portOwner: 1,
        responseIsolation: true,
        socketMode: "0600",
        stdoutClean: true,
        processArgsSecretFree: true,
        statusSecretFree: true,
        gracefulShutdown: true,
      },
      null,
      2,
    ),
  );
} finally {
  controller.abort();
  if (daemon.exitCode === null) {
    daemon.kill("SIGKILL");
    await waitForExit(daemon);
  }
  await rm(directory, { recursive: true, force: true });
}
