import { resolve } from "node:path";
import { ServiceClient } from "./client.js";
import {
  issuePairingCode,
  readCredential,
  readOrCreateCredential,
  rotateCredential,
} from "./credential.js";
import { runForegroundDaemon } from "./daemon.js";
import {
  bootoutLaunchd,
  bootstrapLaunchd,
  defaultLaunchctlRunner,
  getLaunchdStatus,
  type LaunchctlRunner,
  restartLaunchd,
  startLaunchd,
  writeLaunchdPlist,
} from "./launchd.js";
import {
  ensureServiceDirectories,
  readOwnerOnlyFile,
  readServiceConfig,
  removeServiceFiles,
  rotateServiceLogs,
  type ServicePaths,
  servicePaths,
  writeServiceConfig,
} from "./paths.js";

export interface ServiceCliOptions {
  home?: string;
  label?: string;
  launchctl?: LaunchctlRunner;
  executablePath?: string;
  scriptPath?: string;
  version?: string;
  port?: number;
  now?: () => number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const COMMANDS = [
  "install",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "uninstall",
  "rotate",
  "pair",
] as const;

function outputLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  return lines.length > 200 ? lines.slice(-200) : lines;
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readOwnerOnlyFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.replaceAll(secret, "[REDACTED]") : text;
}

function parsePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Service port must be an integer between 1 and 65535.");
  }
  return value;
}

function context(options: ServiceCliOptions): {
  paths: ServicePaths;
  launchctl: LaunchctlRunner;
  executablePath: string;
  scriptPath: string;
  version: string;
  port: number;
  now: () => number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
} {
  return {
    paths: servicePaths({
      ...(options.home !== undefined ? { home: options.home } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
    }),
    launchctl: options.launchctl ?? defaultLaunchctlRunner,
    executablePath: resolve(options.executablePath ?? process.execPath),
    scriptPath: resolve(
      options.scriptPath ?? process.argv[1] ?? "dist/index.js",
    ),
    version: options.version ?? "0.0.0",
    port: parsePort(options.port ?? 3847),
    now: options.now ?? Date.now,
    stdout: options.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
    stderr: options.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
}

export async function runServiceCli(
  args: string[],
  options: ServiceCliOptions = {},
): Promise<number> {
  const command = args[0];
  const state = context(options);
  const { paths, launchctl, stdout } = state;
  if (!command || !COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    state.stderr(
      `Usage: mcp-fig service ${COMMANDS.join("|")} (pairing: service pair)`,
    );
    return 2;
  }

  switch (command) {
    case "install": {
      await ensureServiceDirectories(paths);
      await readOrCreateCredential(paths, { now: state.now() });
      await writeServiceConfig(paths, {
        version: 1,
        serviceVersion: state.version,
        port: state.port,
        socketPath: paths.socketPath,
      });
      await rotateServiceLogs(paths);
      await writeLaunchdPlist({
        paths,
        executablePath: state.executablePath,
        scriptPath: state.scriptPath,
      });
      if ((await getLaunchdStatus(paths, launchctl)).loaded) {
        await restartLaunchd(paths, launchctl);
      } else {
        await bootstrapLaunchd(paths, launchctl);
      }
      stdout("MCP Fig service installed and started.");
      return 0;
    }
    case "start": {
      await readServiceConfig(paths);
      await readCredential(paths);
      await rotateServiceLogs(paths);
      await startLaunchd(paths, launchctl);
      stdout("MCP Fig service started.");
      return 0;
    }
    case "stop": {
      await bootoutLaunchd(paths, launchctl);
      stdout("MCP Fig service stopped.");
      return 0;
    }
    case "restart": {
      await readServiceConfig(paths);
      await readCredential(paths);
      await rotateServiceLogs(paths);
      await restartLaunchd(paths, launchctl);
      stdout("MCP Fig service restarted.");
      return 0;
    }
    case "status": {
      const launchd = await getLaunchdStatus(paths, launchctl);
      let daemon: unknown = null;
      if (launchd.running) {
        try {
          const config = await readServiceConfig(paths);
          daemon = await new ServiceClient({
            socketPath: config.socketPath,
          }).health();
        } catch (error) {
          daemon = {
            error:
              error instanceof Error ? error.message : "Service unavailable.",
          };
        }
      }
      stdout(JSON.stringify({ launchd, daemon }, null, 2));
      return 0;
    }
    case "logs": {
      let secret: string | undefined;
      try {
        secret = (await readCredential(paths)).pluginToken;
      } catch {
        secret = undefined;
      }
      const stdoutLog = redact(await safeRead(paths.stdoutLogPath), secret);
      const stderrLog = redact(await safeRead(paths.stderrLogPath), secret);
      stdout("== stdout ==");
      for (const line of outputLines(stdoutLog)) stdout(line);
      stdout("== stderr ==");
      for (const line of outputLines(stderrLog)) stdout(line);
      return 0;
    }
    case "uninstall": {
      await bootoutLaunchd(paths, launchctl);
      await removeServiceFiles(paths);
      stdout("MCP Fig service uninstalled. Figma data was not modified.");
      return 0;
    }
    case "rotate": {
      await rotateCredential(paths, { now: state.now() });
      if ((await getLaunchdStatus(paths, launchctl)).loaded) {
        await restartLaunchd(paths, launchctl);
      }
      stdout("MCP Fig service credential rotated; pair the Plugin again.");
      return 0;
    }
    case "pair": {
      const issued = await issuePairingCode(paths, { now: state.now() });
      stdout(`Pairing code: ${issued.code}`);
      stdout(`Expires at: ${new Date(issued.expiresAt).toISOString()}`);
      return 0;
    }
  }
  return 2;
}

export async function runInstalledService(
  options: ServiceCliOptions = {},
): Promise<void> {
  const state = context(options);
  const config = await readServiceConfig(state.paths);
  const credential = await readCredential(state.paths);
  await runForegroundDaemon({
    token: credential.pluginToken,
    port: config.port,
    socketPath: config.socketPath,
    version: config.serviceVersion,
  });
}
