import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runServiceCli } from "../src/service/cli.js";
import {
  consumePairingCode,
  issuePairingCode,
  readCredential,
  readOrCreateCredential,
} from "../src/service/credential.js";
import {
  bootoutLaunchd,
  createLaunchdPlist,
  type LaunchctlRunner,
  validateLaunchdPlist,
} from "../src/service/launchd.js";
import {
  ensureServiceDirectories,
  readServiceConfig,
  rotateServiceLogs,
  servicePaths,
} from "../src/service/paths.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mcp-fig-lifecycle-"));
  homes.push(home);
  return home;
}

function modeOf(value: number): number {
  return value & 0o777;
}

function mockLaunchctl(): {
  runner: LaunchctlRunner;
  calls: string[][];
  loaded: () => boolean;
} {
  let loaded = false;
  let running = false;
  let pid = 4_200;
  const calls: string[][] = [];
  return {
    calls,
    loaded: () => loaded,
    runner: async (args) => {
      calls.push(args);
      const command = args[0];
      if (command === "print") {
        return loaded
          ? {
              code: 0,
              stdout: `state = ${running ? "running" : "stopped"}\npid = ${pid}\n`,
              stderr: "",
            }
          : { code: 113, stdout: "", stderr: "Could not find service" };
      }
      if (command === "bootstrap") {
        loaded = true;
        running = true;
        pid += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "bootout") {
        loaded = false;
        running = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "kickstart") {
        if (!loaded) return { code: 113, stdout: "", stderr: "not loaded" };
        running = true;
        pid += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected launchctl command: ${args.join(" ")}`);
    },
  };
}

describe("service lifecycle and secure credentials", () => {
  it("keeps one credential during concurrent first install", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    const credentials = await Promise.all(
      Array.from({ length: 10 }, () => readOrCreateCredential(paths)),
    );
    expect(new Set(credentials.map((value) => value.pluginToken)).size).toBe(1);
    expect((await readCredential(paths)).pluginToken).toBe(
      credentials[0]?.pluginToken,
    );
  });

  it("treats an already completed launchd bootout race as success", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    let printCount = 0;
    const runner: LaunchctlRunner = async (args) => {
      if (args[0] === "print") {
        printCount += 1;
        return printCount === 1
          ? { code: 0, stdout: "state = running\npid = 99\n", stderr: "" }
          : { code: 113, stdout: "", stderr: "Could not find service" };
      }
      if (args[0] === "bootout") {
        return { code: 3, stdout: "", stderr: "No such process" };
      }
      throw new Error(`Unexpected launchctl command: ${args.join(" ")}`);
    };

    await expect(bootoutLaunchd(paths, runner)).resolves.toBeUndefined();
  });

  it("installs idempotently with owner-only files and a secret-free plist", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    const launchctl = mockLaunchctl();
    const stdout: string[] = [];
    const figmaAccessToken = "figma-owner-only-access-token";
    const options = {
      home,
      launchctl: launchctl.runner,
      executablePath: "/absolute/node",
      scriptPath: "/absolute/dist/index.js",
      version: "1.2.3",
      stdout: (line: string) => stdout.push(line),
      stderr: (_line: string) => undefined,
      figmaAccessToken,
    };

    expect(await runServiceCli(["install"], options)).toBe(0);
    const firstCredential = await readCredential(paths);
    expect(await runServiceCli(["install"], options)).toBe(0);
    const secondCredential = await readCredential(paths);
    expect(await runServiceCli(["start"], options)).toBe(0);
    expect(await runServiceCli(["status"], options)).toBe(0);
    expect(await runServiceCli(["pair"], options)).toBe(0);

    expect(secondCredential.pluginToken).toBe(firstCredential.pluginToken);
    expect(secondCredential.figmaAccessToken).toBe(figmaAccessToken);
    expect(await runServiceCli(["rotate"], options)).toBe(0);
    expect((await readCredential(paths)).figmaAccessToken).toBe(
      figmaAccessToken,
    );
    expect(launchctl.loaded()).toBe(true);
    expect(
      launchctl.calls.filter((args) => args[0] === "bootstrap"),
    ).toHaveLength(3);
    expect(modeOf((await stat(paths.appSupportDirectory)).mode)).toBe(0o700);
    expect(modeOf((await stat(paths.credentialPath)).mode)).toBe(0o600);
    expect(modeOf((await stat(paths.configPath)).mode)).toBe(0o600);
    expect(modeOf((await stat(paths.stdoutLogPath)).mode)).toBe(0o600);
    expect(modeOf((await stat(paths.stderrLogPath)).mode)).toBe(0o600);

    const plist = await readFile(paths.launchAgentPath, "utf8");
    const config = await readServiceConfig(paths);
    expect(config).toMatchObject({ version: 1, serviceVersion: "1.2.3" });
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("/absolute/node");
    expect(plist).toContain("/absolute/dist/index.js");
    expect(plist).not.toContain(firstCredential.pluginToken);
    expect(plist).not.toContain(figmaAccessToken);
    expect(plist).not.toContain("MCP_FIG_PLUGIN_TOKEN");
    await writeFile(paths.stdoutLogPath, `leak=${figmaAccessToken}\n`, {
      flag: "a",
    });
    expect(await runServiceCli(["logs"], options)).toBe(0);
    expect(stdout.join("\n")).not.toContain(firstCredential.pluginToken);
    expect(stdout.join("\n")).not.toContain(figmaAccessToken);
    expect(stdout.join("\n")).toContain("leak=[REDACTED]");
  });

  it("rejects malformed plist inputs and insecure credential permissions", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    const launchctl = mockLaunchctl();
    await runServiceCli(["install"], {
      home,
      launchctl: launchctl.runner,
      executablePath: "/absolute/node",
      scriptPath: "/absolute/dist/index.js",
      version: "test",
      stdout: () => undefined,
      stderr: () => undefined,
    });

    await chmod(paths.credentialPath, 0o644);
    await expect(readCredential(paths)).rejects.toThrow(/0600|owner-only/i);
    expect(() => validateLaunchdPlist("<plist><dict></dict></plist>")).toThrow(
      /Label|ProgramArguments/,
    );
    expect(() =>
      createLaunchdPlist({
        paths,
        executablePath: "relative-node",
        scriptPath: "/absolute/dist/index.js",
      }),
    ).toThrow(/absolute/);
    expect(() =>
      validateLaunchdPlist(
        "<plist><dict><key>MCP_FIG_PLUGIN_TOKEN</key><string>secret</string></dict></plist>",
      ),
    ).toThrow(/secret|token/i);

    const outsideLog = join(home, "outside.log");
    await writeFile(outsideLog, "do not read", { mode: 0o600 });
    await rm(paths.stderrLogPath);
    await symlink(outsideLog, paths.stderrLogPath);
    await expect(
      runServiceCli(["logs"], {
        home,
        launchctl: launchctl.runner,
        executablePath: "/absolute/node",
        scriptPath: "/absolute/dist/index.js",
        version: "test",
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).rejects.toThrow(/regular file/i);
  });

  it("rotates bounded owner-only service logs", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    await ensureServiceDirectories(paths);
    await writeFile(paths.stdoutLogPath, "x".repeat(32), { mode: 0o600 });

    await rotateServiceLogs(paths, { maxBytes: 16, backups: 2 });

    expect(await readFile(`${paths.stdoutLogPath}.1`, "utf8")).toBe(
      "x".repeat(32),
    );
    expect(await readFile(paths.stdoutLogPath, "utf8")).toBe("");
    expect(modeOf((await stat(paths.stdoutLogPath)).mode)).toBe(0o600);
  });

  it("issues a two-minute one-time pairing code without storing it in plaintext", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    const launchctl = mockLaunchctl();
    await runServiceCli(["install"], {
      home,
      launchctl: launchctl.runner,
      executablePath: "/absolute/node",
      scriptPath: "/absolute/dist/index.js",
      version: "test",
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const issued = await issuePairingCode(paths, { now: 1_000 });
    const pairingFile = await readFile(paths.pairingPath, "utf8");

    expect(issued.expiresAt).toBe(121_000);
    expect(pairingFile).not.toContain(issued.code);
    await expect(
      consumePairingCode(paths, "wrong-code", { now: 2_000 }),
    ).rejects.toMatchObject({ code: "PAIRING_INVALID" });
    const exchanged = await consumePairingCode(paths, issued.code, {
      now: 2_000,
    });
    expect(exchanged.pluginToken).toBe(
      (await readCredential(paths)).pluginToken,
    );
    const usedRecord = await readFile(paths.pairingUsedPath, "utf8");
    expect(usedRecord).not.toContain(issued.code);
    expect(modeOf((await stat(paths.pairingUsedPath)).mode)).toBe(0o600);
    await expect(
      consumePairingCode(paths, issued.code, { now: 2_000 }),
    ).rejects.toMatchObject({ code: "PAIRING_USED" });

    const concurrent = await issuePairingCode(paths, { now: 5_000 });
    const claims = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        consumePairingCode(paths, concurrent.code, { now: 6_000 }),
      ),
    );
    expect(
      claims.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      claims
        .filter((result) => result.status === "rejected")
        .every((result) => result.reason?.code === "PAIRING_USED"),
    ).toBe(true);

    const expired = await issuePairingCode(paths, { now: 10_000 });
    await expect(
      consumePairingCode(paths, expired.code, { now: 130_000 }),
    ).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });
  });

  it("rotates credentials and redacts logs without touching Figma storage", async () => {
    const home = await temporaryHome();
    const paths = servicePaths({ home });
    const launchctl = mockLaunchctl();
    const stdout: string[] = [];
    const options = {
      home,
      launchctl: launchctl.runner,
      executablePath: "/absolute/node",
      scriptPath: "/absolute/dist/index.js",
      version: "test",
      stdout: (line: string) => stdout.push(line),
      stderr: (_line: string) => undefined,
    };
    await runServiceCli(["install"], options);
    const before = await readCredential(paths);
    await writeFile(paths.stderrLogPath, `failure ${before.pluginToken}\n`, {
      mode: 0o600,
    });

    await runServiceCli(["logs"], options);
    expect(stdout.join("\n")).toContain("[REDACTED]");
    expect(stdout.join("\n")).not.toContain(before.pluginToken);
    await runServiceCli(["rotate"], options);
    const after = await readCredential(paths);
    expect(after.pluginToken).not.toBe(before.pluginToken);
    expect(stdout.join("\n")).not.toContain(after.pluginToken);

    const figmaMarker = join(
      home,
      "Library",
      "Application Support",
      "Figma",
      "clientStorage.test",
    );
    await mkdir(dirname(figmaMarker), { recursive: true });
    await writeFile(figmaMarker, "preserve", { mode: 0o600 });
    expect(await runServiceCli(["stop"], options)).toBe(0);
    expect(await runServiceCli(["stop"], options)).toBe(0);
    expect(await runServiceCli(["uninstall"], options)).toBe(0);
    expect(await runServiceCli(["uninstall"], options)).toBe(0);
    expect(await readFile(figmaMarker, "utf8")).toBe("preserve");
  });
});
