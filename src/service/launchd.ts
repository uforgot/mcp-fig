import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  ensureServiceDirectories,
  type ServicePaths,
  writeOwnerOnlyFile,
} from "./paths.js";

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

export interface LaunchdPlistOptions {
  paths: ServicePaths;
  executablePath: string;
  scriptPath: string;
  homeOverride?: string;
}

export interface LaunchdStatus {
  loaded: boolean;
  running: boolean;
  pid?: number;
  state?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertAbsolute(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
}

export function createLaunchdPlist(options: LaunchdPlistOptions): string {
  assertAbsolute(options.executablePath, "launchd executable");
  assertAbsolute(options.scriptPath, "launchd script");
  assertAbsolute(options.paths.stdoutLogPath, "launchd stdout log");
  assertAbsolute(options.paths.stderrLogPath, "launchd stderr log");
  if (options.homeOverride !== undefined) {
    assertAbsolute(options.homeOverride, "launchd HOME override");
  }
  const environmentXml =
    options.homeOverride === undefined
      ? ""
      : `
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${xml(options.homeOverride)}</string>
    </dict>`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(options.paths.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(options.executablePath)}</string>
      <string>${xml(options.scriptPath)}</string>
      <string>service</string>
      <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>15</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(options.paths.stdoutLogPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(options.paths.stderrLogPath)}</string>${environmentXml}
  </dict>
</plist>
`;
  validateLaunchdPlist(plist);
  return plist;
}

export function validateLaunchdPlist(plist: string): void {
  if (/<key>[^<]*(token|secret|password|credential)[^<]*<\/key>/i.test(plist)) {
    throw new Error("launchd plist must not contain a secret or token.");
  }
  const required = [
    "<key>Label</key>",
    "<key>ProgramArguments</key>",
    "<key>RunAtLoad</key>",
    "<key>KeepAlive</key>",
    "<key>SuccessfulExit</key>",
    "<key>ThrottleInterval</key>",
    "<key>StandardOutPath</key>",
    "<key>StandardErrorPath</key>",
  ];
  const missing = required.filter((value) => !plist.includes(value));
  if (missing.length > 0) {
    throw new Error(`Malformed launchd plist: missing ${missing.join(", ")}.`);
  }
  if (
    !plist.includes("<string>service</string>") ||
    !plist.includes("<string>run</string>")
  ) {
    throw new Error("Malformed launchd plist: missing service run arguments.");
  }
}

export async function writeLaunchdPlist(
  options: LaunchdPlistOptions,
): Promise<void> {
  await ensureServiceDirectories(options.paths);
  await writeOwnerOnlyFile(
    options.paths.launchAgentPath,
    createLaunchdPlist(options),
  );
}

export const defaultLaunchctlRunner: LaunchctlRunner = async (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/launchctl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
};

export function launchdDomain(uid = process.getuid?.()): string {
  if (uid === undefined) throw new Error("launchd requires a Unix user ID.");
  return `gui/${uid}`;
}

export function launchdTarget(
  paths: ServicePaths,
  uid = process.getuid?.(),
): string {
  return `${launchdDomain(uid)}/${paths.label}`;
}

function parseStatus(result: LaunchctlResult): LaunchdStatus {
  if (result.code !== 0) return { loaded: false, running: false };
  const state = /\bstate\s*=\s*([^\s]+)/.exec(result.stdout)?.[1];
  const pidText = /\bpid\s*=\s*(\d+)/.exec(result.stdout)?.[1];
  const pid = pidText ? Number(pidText) : undefined;
  return {
    loaded: true,
    running: state === "running" && pid !== undefined,
    ...(pid !== undefined ? { pid } : {}),
    ...(state ? { state } : {}),
  };
}

async function checked(
  runner: LaunchctlRunner,
  args: string[],
): Promise<LaunchctlResult> {
  const result = await runner(args);
  if (result.code !== 0) {
    throw new Error(
      `launchctl ${args[0] ?? "command"} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
  return result;
}

export async function getLaunchdStatus(
  paths: ServicePaths,
  runner: LaunchctlRunner = defaultLaunchctlRunner,
  uid = process.getuid?.(),
): Promise<LaunchdStatus> {
  return parseStatus(await runner(["print", launchdTarget(paths, uid)]));
}

export async function bootstrapLaunchd(
  paths: ServicePaths,
  runner: LaunchctlRunner = defaultLaunchctlRunner,
  uid = process.getuid?.(),
): Promise<void> {
  if ((await getLaunchdStatus(paths, runner, uid)).loaded) return;
  await checked(runner, [
    "bootstrap",
    launchdDomain(uid),
    paths.launchAgentPath,
  ]);
}

export async function bootoutLaunchd(
  paths: ServicePaths,
  runner: LaunchctlRunner = defaultLaunchctlRunner,
  uid = process.getuid?.(),
): Promise<void> {
  if (!(await getLaunchdStatus(paths, runner, uid)).loaded) return;
  const args = ["bootout", launchdTarget(paths, uid)];
  const result = await runner(args);
  if (result.code === 0) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(await getLaunchdStatus(paths, runner, uid)).loaded) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      "launchctl bootout did not unload the service within 5 seconds.",
    );
  }
  // launchd can finish unloading between `print` and `bootout` yet still
  // return ESRCH. Re-check before treating the idempotent stop as failed.
  if (!(await getLaunchdStatus(paths, runner, uid)).loaded) return;
  throw new Error(
    `launchctl bootout failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
  );
}

export async function startLaunchd(
  paths: ServicePaths,
  runner: LaunchctlRunner = defaultLaunchctlRunner,
  uid = process.getuid?.(),
): Promise<void> {
  const status = await getLaunchdStatus(paths, runner, uid);
  if (!status.loaded) {
    await bootstrapLaunchd(paths, runner, uid);
  } else if (!status.running) {
    await checked(runner, ["kickstart", launchdTarget(paths, uid)]);
  }
}

export async function restartLaunchd(
  paths: ServicePaths,
  runner: LaunchctlRunner = defaultLaunchctlRunner,
  uid = process.getuid?.(),
): Promise<void> {
  await bootoutLaunchd(paths, runner, uid);
  await bootstrapLaunchd(paths, runner, uid);
}
