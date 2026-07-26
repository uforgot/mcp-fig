import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = "mcp-fig-lifecycle-smoke-token";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to reserve a lifecycle smoke port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForHost(port, child) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `MCP process exited before binding (code ${child.exitCode}).`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // The host is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Desktop Plugin host did not bind port ${port}.`);
}

async function waitForExit(child) {
  return Promise.race([
    new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    ),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("MCP process did not exit after stdin closed.")),
        1_000,
      ),
    ),
  ]);
}

async function assertPortReleased(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
}

const port = await freePort();
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: repo,
  env: {
    ...process.env,
    MCP_FIG_DESKTOP_MODE: "manual",
    MCP_FIG_PLUGIN_TOKEN: token,
    MCP_FIG_PLUGIN_PORT: String(port),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await waitForHost(port, child);
  child.stdin.end();
  const { code, signal } = await waitForExit(child);
  if (code !== 0 || signal !== null) {
    throw new Error(
      `MCP process did not exit gracefully (code=${code}, signal=${signal}): ${stderr}`,
    );
  }
  await assertPortReleased(port);
  console.log(
    JSON.stringify(
      { gracefulExit: true, exitCode: code, signal, portReleased: true },
      null,
      2,
    ),
  );
} catch (error) {
  child.kill("SIGKILL");
  throw error;
}
