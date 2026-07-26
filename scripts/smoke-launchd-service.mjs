import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { ServiceClient } from "../dist/service/client.js";
import { readOrCreateCredential } from "../dist/service/credential.js";
import {
  bootoutLaunchd,
  getLaunchdStatus,
  launchdDomain,
  startLaunchd,
  writeLaunchdPlist,
} from "../dist/service/launchd.js";
import {
  ensureServiceDirectories,
  servicePaths,
  writeServiceConfig,
} from "../dist/service/paths.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const home = await mkdtemp(join("/tmp", "mcp-fig-launchd-"));
const label = `com.uforgot.mcp-fig.smoke.${process.pid}`;
const paths = servicePaths({ home, label });
let bootstrapped = false;

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolveRun({ code: code ?? 1, stdout, stderr }),
    );
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a test port."));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(check, timeoutMs, description) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `${description} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}.`,
  );
}

async function assertPortOwned(port) {
  await new Promise((resolveOwned, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolveOwned();
      else reject(error);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close();
      reject(new Error("Plugin port did not have a single daemon owner."));
    });
  });
}

async function waitForPortRelease(port) {
  await waitFor(
    () =>
      new Promise((resolveReleased) => {
        const probe = createServer();
        probe.once("error", () => resolveReleased(false));
        probe.listen(port, "127.0.0.1", () =>
          probe.close(() => resolveReleased(true)),
        );
      }),
    10_000,
    "Plugin port release",
  );
}

async function diagnostic(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

try {
  const port = await freePort();
  await ensureServiceDirectories(paths);
  const credential = await readOrCreateCredential(paths);
  await writeServiceConfig(paths, {
    version: 1,
    serviceVersion: "launchd-smoke",
    port,
    socketPath: paths.socketPath,
  });
  await writeLaunchdPlist({
    paths,
    executablePath: process.execPath,
    scriptPath: join(repo, "dist", "index.js"),
    homeOverride: home,
  });

  const lint = await run("/usr/bin/plutil", ["-lint", paths.launchAgentPath]);
  if (lint.code !== 0) throw new Error(`plutil failed: ${lint.stderr}`);
  if (launchdDomain() !== `gui/${process.getuid()}`) {
    throw new Error("LaunchAgent did not target the login user GUI domain.");
  }

  await startLaunchd(paths);
  bootstrapped = true;
  const first = await waitFor(
    async () => {
      const status = await getLaunchdStatus(paths);
      if (!status.running || !status.pid) return undefined;
      const health = await new ServiceClient({
        socketPath: paths.socketPath,
      }).health();
      return { status, health };
    },
    20_000,
    "initial launchd daemon",
  );

  if (first.health.pid !== first.status.pid) {
    throw new Error("launchd PID and daemon health PID differ.");
  }
  if (first.health.plugin.port !== port) {
    throw new Error("Daemon did not own the configured Plugin port.");
  }
  await assertPortOwned(port);
  if (((await stat(paths.socketPath)).mode & 0o777) !== 0o600) {
    throw new Error("Service socket is not 0600.");
  }

  const commandLine = await run("/bin/ps", [
    "-o",
    "command=",
    "-p",
    String(first.status.pid),
  ]);
  if (commandLine.code !== 0) throw new Error(commandLine.stderr);
  const plist = await readFile(paths.launchAgentPath, "utf8");
  const logsBefore = `${await readFile(paths.stdoutLogPath, "utf8")}${await readFile(paths.stderrLogPath, "utf8")}`;
  const exposedBefore = `${commandLine.stdout}\n${plist}\n${logsBefore}`;
  if (exposedBefore.includes(credential.pluginToken)) {
    throw new Error("Long-lived credential leaked before crash restart.");
  }
  if (plist.includes("MCP_FIG_PLUGIN_TOKEN")) {
    throw new Error("Plugin token environment name leaked into plist.");
  }

  process.kill(first.status.pid, "SIGKILL");
  const restarted = await waitFor(
    async () => {
      const status = await getLaunchdStatus(paths);
      if (!status.running || !status.pid || status.pid === first.status.pid) {
        return undefined;
      }
      const health = await new ServiceClient({
        socketPath: paths.socketPath,
      }).health();
      return { status, health };
    },
    30_000,
    "KeepAlive crash restart",
  );
  if (restarted.health.pid !== restarted.status.pid) {
    throw new Error("Restarted launchd PID and health PID differ.");
  }
  await assertPortOwned(port);

  const logsAfter = `${await readFile(paths.stdoutLogPath, "utf8")}${await readFile(paths.stderrLogPath, "utf8")}`;
  if (logsAfter.includes(credential.pluginToken)) {
    throw new Error("Long-lived credential leaked into launchd logs.");
  }

  await bootoutLaunchd(paths);
  bootstrapped = false;
  await bootoutLaunchd(paths);
  await waitForPortRelease(port);
  const unloaded = await getLaunchdStatus(paths);
  if (unloaded.loaded)
    throw new Error("LaunchAgent remained loaded after bootout.");

  process.stdout.write(
    `${JSON.stringify(
      {
        domain: launchdDomain(),
        initialPid: first.status.pid,
        restartedPid: restarted.status.pid,
        crashRestarted: restarted.status.pid !== first.status.pid,
        portOwner: 1,
        socketMode: "0600",
        plistValid: true,
        secretFree: true,
        bootoutIdempotent: true,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const status = await getLaunchdStatus(paths).catch(() => ({
    loaded: false,
    running: false,
  }));
  process.stderr.write(
    `${JSON.stringify(
      {
        failure: error instanceof Error ? error.message : String(error),
        status,
        stdout: await diagnostic(paths.stdoutLogPath),
        stderr: await diagnostic(paths.stderrLogPath),
      },
      null,
      2,
    )}\n`,
  );
  throw error;
} finally {
  if (bootstrapped) await bootoutLaunchd(paths).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}
