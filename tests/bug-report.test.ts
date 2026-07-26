import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateBugReport } from "../scripts/bug-report.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-fig-report-"));
  directories.push(directory);
  const log = join(directory, "events.jsonl");
  const outputDir = join(directory, "bugs");
  await writeFile(
    log,
    [
      JSON.stringify({
        timestamp: "2026-07-27T01:00:00.000Z",
        level: "info",
        traceId: "trace-fixture-fault",
        requestId: "request-fixture",
        clientId: "agent-fixture",
        daemonPid: 123,
        sessionId: "session-fixture",
        fileKey: "file-fixture",
        method: "node.get",
        action: "dispatch",
        targetNodeIds: ["2:1"],
        token: "TOKEN-MUST-NOT-LEAK",
        document: { children: ["DOCUMENT-MUST-NOT-LEAK"] },
      }),
      "not-json TOKEN-MUST-NOT-LEAK",
      JSON.stringify({
        timestamp: "2026-07-27T01:00:00.010Z",
        level: "error",
        traceId: "trace-fixture-fault",
        requestId: "request-fixture",
        clientId: "agent-fixture",
        daemonPid: 123,
        sessionId: "session-fixture",
        fileKey: "file-fixture",
        method: "node.get",
        action: "figma.api.result",
        targetNodeIds: ["2:1"],
        revision: "9",
        errorCode: "NODE_NOT_FOUND",
        latencyMs: 10,
        retryable: false,
        authorization: "Bearer AUTH-MUST-NOT-LEAK",
      }),
      JSON.stringify({
        timestamp: "2026-07-27T01:01:00.000Z",
        level: "error",
        traceId: "trace-restart-fault",
        action: "unknown_outcome",
        errorCode: "UNKNOWN_OUTCOME",
        retryable: false,
        socketPayload: "SOCKET-MUST-NOT-LEAK",
      }),
    ].join("\n"),
    { mode: 0o600 },
  );
  return { directory, log, outputDir };
}

describe("bug report generator", () => {
  it("creates a redacted trace report with the focused fix loop", async () => {
    const { log, outputDir } = await fixture();
    const output = await generateBugReport({
      trace: "trace-fixture-fault",
      log,
      outputDir,
      date: "2026-07-27",
    });
    const report = await readFile(output, "utf8");

    expect(output).toBe(join(outputDir, "2026-07-27-trace-fixture-fault.md"));
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(report).toContain("Matched events: 2");
    expect(report).toContain("Malformed/skipped lines: 1");
    expect(report).toContain("NODE_NOT_FOUND");
    for (const heading of [
      "Capture",
      "Reproduce",
      "Failing test",
      "Minimal fix",
      "Focused test",
      "Relevant live canary",
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).not.toMatch(
      /TOKEN-MUST-NOT-LEAK|DOCUMENT-MUST-NOT-LEAK|AUTH-MUST-NOT-LEAK|SOCKET-MUST-NOT-LEAK/,
    );
  });

  it("can collect restart faults by errorCode without marking them retryable", async () => {
    const { log, outputDir } = await fixture();
    const output = await generateBugReport({
      errorCode: "UNKNOWN_OUTCOME",
      log,
      outputDir,
      date: "2026-07-27",
    });
    const report = await readFile(output, "utf8");
    expect(report).toContain("trace-restart-fault");
    expect(report).toContain("unknown_outcome");
    expect(report).toContain("false");
    expect(report).not.toContain("SOCKET-MUST-NOT-LEAK");
  });
});
