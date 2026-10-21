import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../plugin/manifest.json", import.meta.url), "utf8"),
) as {
  editorType: string[];
  capabilities: string[];
  networkAccess: { devAllowedDomains: string[] };
};
const pluginUi = readFileSync(
  new URL("../plugin/ui.html", import.meta.url),
  "utf8",
);

describe("Figma Plugin manifest", () => {
  it("supports both Design and Dev Mode inspection", () => {
    expect(manifest.editorType).toEqual(["figma", "dev"]);
    expect(manifest.capabilities).toContain("inspect");
  });
  it("uses Figma's accepted localhost development origin", () => {
    expect(manifest.networkAccess.devAllowedDomains).toEqual([
      "http://localhost:3847",
    ]);
    expect(pluginUi).toMatch(/http:\/\/localhost:\$\{port\}/);
    expect(pluginUi).not.toMatch(/http:\/\/127\.0\.0\.1:\$\{port\}/);
  });
});
