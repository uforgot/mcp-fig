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
  it("refreshes the host handshake when the Plugin revision changes", async () => {
    const handshakes: Array<Record<string, unknown>> = [];
    const elements = new Map<string, Record<string, unknown>>([
      ["#status", { textContent: "", className: "", dataset: {} }],
      ["#pair-form", {}],
      ["#port", { value: "3847" }],
      ["#token", { value: "pair-secret" }],
    ]);
    const window: { onmessage?: (event: unknown) => void } = {};
    runInNewContext(pluginUiScript(), {
      AbortController,
      console,
      crypto: {},
      document: {
        querySelector(selector: string) {
          return elements.get(selector);
        },
      },
      fetch: async (url: string, options: { body?: string } = {}) => {
        if (url.endsWith("/v1/session/handshake")) {
          handshakes.push(JSON.parse(options.body ?? "{}"));
          return { ok: true, status: 200, text: async () => "" };
        }
        return new Promise(() => undefined);
      },
      parent: { postMessage() {} },
      window,
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout,
      clearTimeout,
    });

    window.onmessage?.({
      data: {
        pluginMessage: {
          type: "bridge-bootstrap",
          file: { key: "test-file", name: "Test", revision: "1" },
        },
      },
    });
    const form = elements.get("#pair-form") as {
      onsubmit?: (event: { preventDefault(): void }) => void;
    };
    form.onsubmit?.({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    window.onmessage?.({
      data: {
        pluginMessage: {
          type: "bridge-bootstrap",
          file: { key: "test-file", name: "Test", revision: "2" },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handshakes.map((entry) => entry.file)).toEqual([
      { key: "test-file", name: "Test", revision: "1" },
      { key: "test-file", name: "Test", revision: "2" },
    ]);
  });

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
