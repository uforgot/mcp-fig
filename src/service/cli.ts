import { resolve } from "node:path";
import { buildAgentServiceStatus } from "./agent-status.js";
import { ServiceClient } from "./client.js";
import {
  consumePairingCode,
  issuePairingCode,
  PairingCredentialError,
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
import {
  beginStartup,
  markStartupProgress,
  markStartupVerified,
  observeServiceStarted,
  readStartupState,
  recordStartupAction,
  STARTUP_STAGES,
  type StartupEscalationSignal,
  type StartupResetSignal,
  type StartupStage,
  setStartupStage,
  writeStartupState,
} from "./startup-state.js";

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
  "startup",
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

function startupStage(value: string | undefined): StartupStage {
  if (!value || !STARTUP_STAGES.includes(value as StartupStage)) {
    throw new Error(
      `Startup stage must be one of: ${STARTUP_STAGES.join(", ")}.`,
    );
  }
  return value as StartupStage;
}

function resetSignal(args: string[]): StartupResetSignal | undefined {
  if (args.includes("--explicit-retry") || args.includes("--retry")) {
    return "explicit-user-retry";
  }
  if (
    args.includes("--figma-state-change") ||
    args.includes("--process-changed")
  ) {
    return "process-state-change";
  }
  if (args.includes("--window-changed")) return "window-state-change";
  if (args.includes("--session-changed")) return "session-state-change";
  if (
    args.includes("--service-restart") ||
    args.includes("--service-restarted")
  ) {
    return "service-restart";
  }
  return undefined;
}

function escalationSignal(
  value: string | undefined,
): StartupEscalationSignal | undefined {
  if (
    value === "suspected_noop" ||
    value === "background_unavailable" ||
    value === "foreground_recommended"
  ) {
    return value;
  }
  return undefined;
}

async function runStartupCommand(
  args: string[],
  state: ReturnType<typeof context>,
): Promise<number> {
  const positional = args.filter((arg) => arg !== "--json");
  const verb = positional[1] ?? "status";
  const now = state.now();
  let startup = await readStartupState(state.paths, now);
  switch (verb) {
    case "status":
      break;
    case "begin": {
      const reset = resetSignal(args);
      startup = beginStartup(startup, now, {
        ...(reset ? { resetSignal: reset } : {}),
      });
      break;
    }
    case "stage":
      startup = setStartupStage(startup, startupStage(positional[2]), now);
      break;
    case "progress":
      startup = markStartupProgress(startup, startupStage(positional[2]), now);
      break;
    case "verify": {
      const launchd = await getLaunchdStatus(state.paths, state.launchctl);
      if (!launchd.running) {
        throw new Error(
          "Cannot verify startup while the service is not running.",
        );
      }
      const config = await readServiceConfig(state.paths);
      const serviceStatus = await new ServiceClient({
        socketPath: config.socketPath,
      }).status();
      if (serviceStatus.daemon.sessions.length === 0) {
        throw new Error(
          "Cannot verify startup without an active Plugin session.",
        );
      }
      startup = markStartupVerified(
        startup,
        now,
        serviceStatus.daemon.startedAt,
      );
      break;
    }
    case "action": {
      const stage = startupStage(positional[2]);
      const action = positional[3];
      const mode = positional[4];
      const outcome = positional[5];
      if (!action || action.length > 80) {
        throw new Error("Startup action must be a short non-empty identifier.");
      }
      if (mode !== "background" && mode !== "foreground") {
        throw new Error(
          "Startup action mode must be background or foreground.",
        );
      }
      if (
        outcome !== "pending" &&
        outcome !== "succeeded" &&
        outcome !== "failed" &&
        outcome !== "blocked"
      ) {
        throw new Error(
          "Startup action outcome must be pending, succeeded, failed, or blocked.",
        );
      }
      const signal = escalationSignal(positional[7]);
      startup = recordStartupAction(startup, now, {
        stage,
        action,
        mode,
        outcome,
        ...(positional[6] ? { errorCode: positional[6] } : {}),
        ...(signal ? { escalationSignal: signal } : {}),
      });
      break;
    }
    default:
      state.stderr(
        "Usage: mcp-fig service startup status|begin|stage|progress|action|verify",
      );
      return 2;
  }
  await writeStartupState(state.paths, startup);
  state.stdout(JSON.stringify(startup));
  return 0;
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
  if (command === "startup") return runStartupCommand(args, state);

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
      let daemonStatus:
        | Awaited<ReturnType<ServiceClient["status"]>>
        | undefined;
      let daemonError: unknown;
      let startup = await readStartupState(paths, state.now());
      if (launchd.running) {
        try {
          const config = await readServiceConfig(paths);
          daemonStatus = await new ServiceClient({
            socketPath: config.socketPath,
          }).status();
          startup = observeServiceStarted(
            startup,
            daemonStatus.daemon.startedAt,
            state.now(),
          );
          if (daemonStatus.daemon.sessions.length > 0) {
            startup = markStartupVerified(
              startup,
              state.now(),
              daemonStatus.daemon.startedAt,
            );
          }
        } catch (error) {
          daemonError = error;
        }
      }
      if (startup.startupRunId || daemonStatus) {
        await writeStartupState(paths, startup);
      }
      const agent = buildAgentServiceStatus({
        launchd,
        ...(daemonStatus ? { daemonStatus } : {}),
        ...(daemonError ? { daemonError } : {}),
        startup,
      });
      stdout(
        JSON.stringify(
          {
            ...agent,
            launchd,
            daemon: daemonStatus?.daemon ?? null,
          },
          null,
          args.includes("--json") ? undefined : 2,
        ),
      );
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
    exchangePairingCode: async (code) => {
      try {
        const exchanged = await consumePairingCode(state.paths, code, {
          now: state.now(),
        });
        return { ok: true, credential: exchanged.pluginToken };
      } catch (error) {
        if (error instanceof PairingCredentialError) {
          return { ok: false, code: error.code, message: error.message };
        }
        throw error;
      }
    },
  });
}
