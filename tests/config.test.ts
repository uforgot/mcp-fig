import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("enables core and deduplicates optional profiles", () => {
    const config = loadConfig({
      MCP_FIG_PROFILES: "advanced,tokens,advanced",
      MCP_FIG_LOG_LEVEL: "debug",
    });

    expect(config.profiles).toEqual(["core", "advanced", "tokens"]);
    expect(config.logLevel).toBe("debug");
  });

  it("rejects unknown profiles", () => {
    expect(() => loadConfig({ MCP_FIG_PROFILES: "core,unknown" })).toThrow(
      "Unknown MCP Fig profile: unknown",
    );
  });
});
