import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const PROTOCOL = "mcp-fig-plugin/v1";
const CREDENTIAL = "c".repeat(43);

interface BridgeConfig {
  version: 1;
  protocol: string;
  port: number;
  credential: string;
}

interface MockElement {
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  hidden: boolean;
  value: string;
  onsubmit?: (event: { preventDefault(): void }) => void;
  onclick?: () => void;
}

interface FetchCall {
  url: string;
  options: Record<string, unknown>;
}

class MockElements extends Map<string, MockElement> {
  override get(selector: string): MockElement {
    const element = super.get(selector);
    if (!element) throw new Error(`Unknown selector ${selector}`);
    return element;
  }
}

function pluginUiScript() {
  const html = readFileSync(
    new URL("../plugin/ui.html", import.meta.url),
    "utf8",
  );
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Plugin UI script not found.");
  return match[1];
}

function jsonResponse(
  status: number,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(payload);
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function savedConfig(credential = CREDENTIAL): BridgeConfig {
  return { version: 1, protocol: PROTOCOL, port: 3847, credential };
}

function createUiHarness(
  options: {
    initialConfig?: BridgeConfig;
    fetch?: (
      url: string,
      options: Record<string, unknown>,
      callIndex: number,
    ) => Promise<Record<string, unknown>>;
  } = {},
) {
  let config = options.initialConfig
    ? structuredClone(options.initialConfig)
    : undefined;
  const calls: FetchCall[] = [];
  const pluginMessages: Record<string, unknown>[] = [];
  const timers: Array<{
    id: number;
    callback: () => void;
    delay: number;
    cleared: boolean;
  }> = [];
  let nextTimerId = 1;
  const elements = new MockElements();
  for (const selector of [
    "#status",
    "#pairing-panel",
    "#connected-panel",
    "#pair-form",
    "#manual-form",
    "#port",
    "#pair-code",
    "#manual-port",
    "#token",
    "#forget",
    "#repair",
  ]) {
    elements.set(selector, {
      textContent: "",
      className: "",
      dataset: {},
      hidden: selector === "#connected-panel",
      value: selector === "#port" || selector === "#manual-port" ? "3847" : "",
    });
  }
  const window: { onmessage?: (event: unknown) => void } = {};
  const file = { key: "test-file", name: "Test", revision: "1" };

  function deliver(message: Record<string, unknown>) {
    queueMicrotask(() =>
      window.onmessage?.({ data: { pluginMessage: message } }),
    );
  }

  const parent = {
    postMessage(envelope: { pluginMessage?: Record<string, unknown> }) {
      const message = envelope.pluginMessage;
      if (!message) return;
      pluginMessages.push(structuredClone(message));
      const requestId = String(message.requestId ?? "");
      if (message.type === "bridge-bootstrap") {
        deliver({ type: "bridge-bootstrap", file: structuredClone(file) });
      } else if (message.type === "bridge-config-get") {
        deliver({
          type: "bridge-config-result",
          requestId,
          operation: "get",
          ok: true,
          config: config ? structuredClone(config) : null,
        });
      } else if (message.type === "bridge-config-set") {
        config = structuredClone(message.config as BridgeConfig);
        deliver({
          type: "bridge-config-result",
          requestId,
          operation: "set",
          ok: true,
        });
      } else if (message.type === "bridge-config-clear") {
        config = undefined;
        deliver({
          type: "bridge-config-result",
          requestId,
          operation: "clear",
          ok: true,
        });
      }
    },
  };

  const defaultFetch = async (
    url: string,
  ): Promise<Record<string, unknown>> => {
    if (url.endsWith("/v1/pair/exchange")) {
      return jsonResponse(200, {
        protocol: PROTOCOL,
        credential: CREDENTIAL,
      });
    }
    if (url.endsWith("/v1/session/handshake")) {
      return jsonResponse(200, { protocol: PROTOCOL, accepted: true });
    }
    return new Promise(() => undefined);
  };

  runInNewContext(pluginUiScript(), {
    AbortController,
    console,
    crypto: {},
    document: {
      querySelector(selector: string) {
        const element = elements.get(selector);
        if (!element) throw new Error(`Unknown selector ${selector}`);
        return element;
      },
    },
    fetch: async (url: string, fetchOptions: Record<string, unknown> = {}) => {
      calls.push({ url, options: structuredClone(fetchOptions) });
      return (options.fetch ?? defaultFetch)(
        url,
        fetchOptions,
        calls.length - 1,
      );
    },
    parent,
    window,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout(callback: () => void, delay: number) {
      const timer = {
        id: nextTimerId++,
        callback,
        delay,
        cleared: false,
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id: number) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
  });

  async function flush(turns = 8) {
    for (let index = 0; index < turns; index += 1) {
      await Promise.resolve();
    }
  }

  async function runNextTimer() {
    const timer = timers.find((entry) => !entry.cleared);
    if (!timer) throw new Error("No pending timer.");
    timer.cleared = true;
    timer.callback();
    await flush();
    return timer.delay;
  }

  return {
    calls,
    elements,
    file,
    flush,
    get config() {
      return config;
    },
    pluginMessages,
    runNextTimer,
    timers,
    window,
  };
}

function submit(element: MockElement) {
  element.onsubmit?.({ preventDefault() {} });
}

describe("Figma Plugin UI pairing", () => {
  it("exchanges a one-time code, persists the credential, and hides manual controls", async () => {
    const harness = createUiHarness();
    await harness.flush();
    harness.elements.get("#pair-code").value = "PAIR-CODE";

    submit(harness.elements.get("#pair-form"));
    await harness.flush(32);

    expect(harness.calls.map((call) => call.url)).toEqual([
      "http://localhost:3847/v1/pair/exchange",
      "http://localhost:3847/v1/session/handshake",
      expect.stringMatching(/\/v1\/session\/.*\/next$/),
    ]);
    expect(harness.config).toEqual(savedConfig());
    expect(harness.elements.get("#pairing-panel").hidden).toBe(true);
    expect(harness.elements.get("#connected-panel").hidden).toBe(false);
    expect(harness.elements.get("#status").dataset.state).toBe("ready");
    expect(JSON.stringify([...harness.elements.values()])).not.toContain(
      CREDENTIAL,
    );
  });

  it("automatically reconnects from a persisted config without exchanging a code", async () => {
    const harness = createUiHarness({ initialConfig: savedConfig() });
    await harness.flush(16);

    expect(harness.calls.some((call) => call.url.includes("/v1/pair/"))).toBe(
      false,
    );
    expect(harness.calls[0]?.url).toBe(
      "http://localhost:3847/v1/session/handshake",
    );
    expect(harness.calls[0]?.options).toMatchObject({
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    });
    expect(harness.elements.get("#pairing-panel").hidden).toBe(true);
    expect(harness.elements.get("#status").textContent).toContain("Connected");
  });

  it.each([
    ["PAIRING_INVALID", 400, "Invalid pairing code"],
    ["PAIRING_EXPIRED", 410, "Pairing code expired"],
    ["PAIRING_USED", 409, "Pairing code was already used"],
  ])("shows a recovery action for %s", async (code, status, copy) => {
    const harness = createUiHarness({
      fetch: async (url) => {
        if (url.endsWith("/v1/pair/exchange")) {
          return jsonResponse(status, { error: { code, message: copy } });
        }
        return new Promise(() => undefined);
      },
    });
    await harness.flush();
    harness.elements.get("#pair-code").value = "BAD-CODE";
    submit(harness.elements.get("#pair-form"));
    await harness.flush(12);

    expect(harness.config).toBeUndefined();
    expect(harness.elements.get("#status").textContent).toContain(copy);
    expect(harness.elements.get("#status").textContent).toContain(
      "mcp-fig service pair",
    );
    expect(harness.elements.get("#pairing-panel").hidden).toBe(false);
  });

  it("forgets the saved credential without exposing it", async () => {
    const harness = createUiHarness({ initialConfig: savedConfig() });
    await harness.flush(16);

    harness.elements.get("#forget").onclick?.();
    await harness.flush();

    expect(harness.config).toBeUndefined();
    expect(harness.elements.get("#pairing-panel").hidden).toBe(false);
    expect(harness.elements.get("#connected-panel").hidden).toBe(true);
    expect(harness.elements.get("#status").textContent).toContain("Forgotten");
    expect(harness.elements.get("#status").textContent).not.toContain(
      CREDENTIAL,
    );
  });

  it("clears a rotated credential and requires explicit re-pair", async () => {
    const harness = createUiHarness({
      initialConfig: savedConfig(),
      fetch: async (url) => {
        if (url.endsWith("/v1/session/handshake")) {
          return jsonResponse(401, {
            error: { code: "UNAUTHORIZED", message: "Invalid credential." },
          });
        }
        return new Promise(() => undefined);
      },
    });
    await harness.flush(16);

    expect(harness.config).toBeUndefined();
    expect(harness.elements.get("#status").dataset.state).toBe(
      "credential-expired",
    );
    expect(harness.elements.get("#status").textContent).toContain(
      "Credential expired",
    );
    expect(harness.elements.get("#status").textContent).toContain("Re-pair");
    expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });

  it("backs off while the service is stopped and reconnects after restart", async () => {
    let available = false;
    const harness = createUiHarness({
      initialConfig: savedConfig(),
      fetch: async (url) => {
        if (!available) throw new TypeError("fetch failed");
        if (url.endsWith("/v1/session/handshake")) {
          return jsonResponse(200, { protocol: PROTOCOL, accepted: true });
        }
        return new Promise(() => undefined);
      },
    });
    await harness.flush(12);

    expect(harness.elements.get("#status").dataset.state).toBe(
      "service-not-running",
    );
    expect(harness.elements.get("#status").textContent).toContain(
      "mcp-fig service start",
    );
    available = true;
    expect(await harness.runNextTimer()).toBe(250);

    expect(harness.elements.get("#status").dataset.state).toBe("ready");
    expect(harness.config).toEqual(savedConfig());
  });

  it("stops reconnecting on a protocol mismatch and explains the recovery", async () => {
    const harness = createUiHarness({
      initialConfig: savedConfig(),
      fetch: async (url) => {
        if (url.endsWith("/v1/session/handshake")) {
          return jsonResponse(200, {
            protocol: "mcp-fig-plugin/v0",
            accepted: true,
          });
        }
        return new Promise(() => undefined);
      },
    });
    await harness.flush(16);

    expect(harness.elements.get("#status").dataset.state).toBe(
      "protocol-mismatch",
    );
    expect(harness.elements.get("#status").textContent).toContain(
      "Protocol mismatch",
    );
    expect(harness.elements.get("#status").textContent).toContain("Update");
    expect(harness.timers.filter((timer) => !timer.cleared)).toHaveLength(0);
  });

  it("refreshes the host handshake when the Plugin revision changes", async () => {
    const handshakes: Array<Record<string, unknown>> = [];
    const harness = createUiHarness({
      initialConfig: savedConfig(),
      fetch: async (url, options) => {
        if (url.endsWith("/v1/session/handshake")) {
          handshakes.push(JSON.parse(String(options.body ?? "{}")));
          return jsonResponse(200, { protocol: PROTOCOL, accepted: true });
        }
        return new Promise(() => undefined);
      },
    });
    await harness.flush(16);

    harness.file.revision = "2";
    harness.window.onmessage?.({
      data: {
        pluginMessage: {
          type: "bridge-bootstrap",
          file: structuredClone(harness.file),
        },
      },
    });
    await harness.flush();

    expect(handshakes.map((entry) => entry.file)).toEqual([
      { key: "test-file", name: "Test", revision: "1" },
      { key: "test-file", name: "Test", revision: "2" },
    ]);
  });

  it("keeps the explicit manual token canary fallback", async () => {
    const manualCredential = "manual-canary-token";
    const harness = createUiHarness();
    await harness.flush();
    harness.elements.get("#token").value = manualCredential;

    submit(harness.elements.get("#manual-form"));
    await harness.flush(16);

    expect(harness.calls.some((call) => call.url.includes("/v1/pair/"))).toBe(
      false,
    );
    expect(harness.calls[0]?.options).toMatchObject({
      headers: { authorization: `Bearer ${manualCredential}` },
    });
    expect(harness.config).toBeUndefined();
    expect(harness.elements.get("#status").dataset.state).toBe("ready");
    expect(JSON.stringify([...harness.elements.values()])).not.toContain(
      manualCredential,
    );
  });

  it("boots when crypto.randomUUID is unavailable", () => {
    expect(() => createUiHarness()).not.toThrow();
  });
});
