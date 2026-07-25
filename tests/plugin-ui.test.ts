import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

function pluginUiScript() {
  const html = readFileSync(
    new URL("../plugin/ui.html", import.meta.url),
    "utf8",
  );
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Plugin UI script not found.");
  return match[1];
}

describe("Figma Plugin UI", () => {
  it("boots when crypto.randomUUID is unavailable", () => {
    const messages: unknown[] = [];
    const elements = new Map<string, Record<string, unknown>>([
      ["#status", { textContent: "", className: "" }],
      ["#pair-form", {}],
      ["#port", { value: "3847" }],
      ["#token", { value: "" }],
    ]);
    const window: { onmessage?: (event: unknown) => void } = {};

    expect(() =>
      runInNewContext(pluginUiScript(), {
        console,
        crypto: {},
        document: {
          querySelector(selector: string) {
            return elements.get(selector);
          },
        },
        parent: {
          postMessage(message: unknown) {
            messages.push(message);
          },
        },
        window,
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout,
        clearTimeout,
      }),
    ).not.toThrow();

    expect(messages).toContainEqual({
      pluginMessage: { type: "bridge-bootstrap" },
    });
    expect(window.onmessage).toBeTypeOf("function");
  });
});
