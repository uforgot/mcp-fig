import { describe, expect, it, vi } from "vitest";
import { createDefaultBridge } from "../src/bridge/factory.js";
import {
  HYBRID_REST_CAPABILITY_TABLE,
  HybridFigmaBridge,
} from "../src/bridge/hybrid.js";
import { RestFigmaBridge } from "../src/bridge/rest.js";
import type {
  BridgeStatus,
  FigmaBridge,
  FigmaNode,
} from "../src/bridge/types.js";
import { McpFigError } from "../src/errors.js";

const pluginStatus: BridgeStatus = {
  connected: true,
  mode: "desktop-plugin",
  fileKey: "file-1",
  fileName: "Plugin file",
  revision: "plugin-7",
  readSource: "desktop-plugin",
  writeSource: "desktop-plugin",
};

const restStatus: BridgeStatus = {
  connected: true,
  mode: "rest",
  fileKey: "file-1",
  fileName: "REST file",
  revision: "rest-42",
  readSource: "rest",
  writeSource: "none",
};

const pluginNode: FigmaNode = {
  id: "0:0",
  type: "DOCUMENT",
  name: "Plugin document",
};

const restNode: FigmaNode = {
  id: "0:0",
  type: "DOCUMENT",
  name: "REST document",
  source: "rest",
  revision: "rest-42",
  freshnessWarning:
    "REST data can lag unsaved local Figma state; do not compare its revision with Plugin revisions.",
};

function makeBridge(overrides: Partial<FigmaBridge> = {}): FigmaBridge {
  return {
    status: vi.fn(async () => pluginStatus),
    listFiles: vi.fn(async () => []),
    targetFile: vi.fn(async () => pluginStatus),
    reconnect: vi.fn(async () => pluginStatus),
    getDocument: vi.fn(async () => pluginNode),
    getSelection: vi.fn(async () => []),
    getChanges: vi.fn(async () => []),
    getNodes: vi.fn(async () => []),
    queryNodes: vi.fn(async (input) => ({
      matches: [],
      limit: input.limit,
      truncated: false,
    })),
    createNode: vi.fn(async () => []),
    updateNodes: vi.fn(async () => []),
    moveNodes: vi.fn(async () => []),
    resizeNodes: vi.fn(async () => []),
    cloneNodes: vi.fn(async () => []),
    deleteNodes: vi.fn(async () => []),
    exportNodes: vi.fn(async () => []),
    layout: vi.fn(async () => ({})),
    component: vi.fn(async () => ({})),
    instance: vi.fn(async () => ({})),
    tokens: vi.fn(async () => ({})),
    styles: vi.fn(async () => ({})),
    ...overrides,
  };
}

function preDispatchNotConnected(): McpFigError {
  return new McpFigError("NOT_CONNECTED", "No active Plugin session.", {
    retryable: true,
    details: { dispatched: false },
  });
}

describe("HybridFigmaBridge", () => {
  it("publishes the exact REST fallback capability allowlist", () => {
    expect(HYBRID_REST_CAPABILITY_TABLE).toEqual({
      bridgeMethods: [
        "getDocument",
        "getChanges",
        "getNodes",
        "queryNodes",
        "layout",
        "component",
      ],
      layoutActions: ["inspect", "validate"],
      componentActions: ["search", "inspect"],
    });
  });

  it("assembles service mode as hybrid without exposing the REST token", async () => {
    const bridge = createDefaultBridge({
      version: "test",
      profiles: ["core"],
      logLevel: "info",
      service: {
        socketPath: "/tmp/mcp-fig-missing-hybrid-test.sock",
        clientId: "hybrid-test",
        fileKey: "file-1",
      },
      figmaRest: {
        accessToken: "factory-rest-secret",
        fileKey: "file-1",
        baseUrl: "https://figma.test",
        timeoutMs: 5_000,
      },
    });

    const status = await bridge.status();
    expect(status).toMatchObject({
      connected: true,
      mode: "hybrid",
      pluginConnected: false,
      restAvailable: true,
      readSource: "rest",
      writeSource: "none",
    });
    expect(JSON.stringify(status)).not.toContain("factory-rest-secret");
    await bridge.close?.();
  });

  it("keeps Plugin as the primary source when a read succeeds", async () => {
    const plugin = makeBridge();
    const rest = makeBridge({
      status: vi.fn(async () => restStatus),
      getDocument: vi.fn(async () => restNode),
    });
    const bridge = new HybridFigmaBridge(plugin, rest);

    await expect(bridge.getDocument("file-1")).resolves.toEqual(pluginNode);
    expect(plugin.getDocument).toHaveBeenCalledWith("file-1");
    expect(rest.getDocument).not.toHaveBeenCalled();
  });

  it("falls back to REST for an allowed read that failed before dispatch", async () => {
    const plugin = makeBridge({
      status: vi.fn(async () => ({ ...pluginStatus, connected: false })),
      getDocument: vi.fn(async () => {
        throw preDispatchNotConnected();
      }),
    });
    const rest = makeBridge({
      status: vi.fn(async () => restStatus),
      reconnect: vi.fn(async () => restStatus),
      getDocument: vi.fn(async () => restNode),
    });
    const bridge = new HybridFigmaBridge(plugin, rest);

    await expect(bridge.getDocument("file-1")).resolves.toEqual(restNode);
    expect(rest.getDocument).toHaveBeenCalledWith("file-1");
    await expect(bridge.status()).resolves.toMatchObject({
      mode: "hybrid",
      pluginConnected: false,
      restAvailable: true,
      readSource: "rest",
      writeSource: "none",
      degradedReason: "PLUGIN_NOT_CONNECTED_REST_READ_ONLY",
      revision: "rest-42",
    });
  });

  it("never falls back for selection or writes", async () => {
    const selectionError = preDispatchNotConnected();
    const writeError = preDispatchNotConnected();
    const plugin = makeBridge({
      getSelection: vi.fn(async () => {
        throw selectionError;
      }),
      updateNodes: vi.fn(async () => {
        throw writeError;
      }),
    });
    const rest = makeBridge({
      getSelection: vi.fn(async () => []),
      updateNodes: vi.fn(async () => []),
    });
    const bridge = new HybridFigmaBridge(plugin, rest);

    await expect(bridge.getSelection("file-1")).rejects.toBe(selectionError);
    await expect(
      bridge.updateNodes({
        fileKey: "file-1",
        nodeIds: ["2:1"],
        patch: { name: "Never via REST" },
      }),
    ).rejects.toBe(writeError);
    expect(rest.getSelection).not.toHaveBeenCalled();
    expect(rest.updateNodes).not.toHaveBeenCalled();
  });

  it("does not fall back after dispatch, UNKNOWN_OUTCOME, or a domain error", async () => {
    const rest = makeBridge({ getDocument: vi.fn(async () => restNode) });
    const errors = [
      new McpFigError("NOT_CONNECTED", "Timed out after dispatch.", {
        details: { dispatched: true },
      }),
      new McpFigError("UNKNOWN_OUTCOME", "Outcome is unknown.", {
        details: { dispatched: true },
      }),
      new McpFigError("NODE_NOT_FOUND", "Plugin domain error."),
    ];

    for (const error of errors) {
      const bridge = new HybridFigmaBridge(
        makeBridge({
          getDocument: vi.fn(async () => {
            throw error;
          }),
        }),
        rest,
      );
      await expect(bridge.getDocument("file-1")).rejects.toBe(error);
    }
    expect(rest.getDocument).not.toHaveBeenCalled();
  });

  it("allows only the explicit layout and component read actions", async () => {
    const plugin = makeBridge({
      layout: vi.fn(async () => {
        throw preDispatchNotConnected();
      }),
      component: vi.fn(async () => {
        throw preDispatchNotConnected();
      }),
    });
    const rest = makeBridge({
      status: vi.fn(async () => restStatus),
      reconnect: vi.fn(async () => restStatus),
      layout: vi.fn(async (input) => ({
        action: input.action,
        source: "rest",
      })),
      component: vi.fn(async (input) => ({
        action: input.action,
        source: "rest",
      })),
    });
    const bridge = new HybridFigmaBridge(plugin, rest);

    await expect(
      bridge.layout({ action: "inspect", nodeIds: ["2:1"], fileKey: "file-1" }),
    ).resolves.toMatchObject({ action: "inspect", source: "rest" });
    await expect(
      bridge.layout({
        action: "validate",
        nodeIds: ["2:1"],
        fileKey: "file-1",
      }),
    ).resolves.toMatchObject({ action: "validate", source: "rest" });
    await expect(
      bridge.component({ action: "search", query: "card", fileKey: "file-1" }),
    ).resolves.toMatchObject({ action: "search", source: "rest" });
    await expect(
      bridge.component({
        action: "inspect",
        componentId: "2:1",
        fileKey: "file-1",
      }),
    ).resolves.toMatchObject({ action: "inspect", source: "rest" });

    await expect(
      bridge.layout({
        action: "repair",
        nodeIds: ["2:1"],
        issueCodes: [],
        fileKey: "file-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await expect(
      bridge.component({
        action: "set_description",
        componentId: "2:1",
        description: "write",
        fileKey: "file-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    expect(rest.layout).toHaveBeenCalledTimes(2);
    expect(rest.component).toHaveBeenCalledTimes(2);
  });

  it("reports missing REST credentials and file keys structurally", async () => {
    const plugin = makeBridge({
      getDocument: vi.fn().mockRejectedValue(preDispatchNotConnected()),
    });
    const noToken = new HybridFigmaBridge(
      plugin,
      new RestFigmaBridge({ fileKey: "file-1" }),
    );
    await expect(noToken.getDocument("file-1")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      details: expect.objectContaining({ reason: "REST_CREDENTIAL_MISSING" }),
    });

    const noFileKey = new HybridFigmaBridge(
      plugin,
      new RestFigmaBridge({ accessToken: "rest-token" }),
    );
    await expect(noFileKey.getDocument()).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      details: expect.objectContaining({ reason: "REST_FILE_KEY_MISSING" }),
    });

    const unreadableToken = new HybridFigmaBridge(
      plugin,
      new RestFigmaBridge({
        fileKey: "file-1",
        loadAccessToken: vi.fn(async () => {
          throw new Error("credential permission rejected");
        }),
      }),
    );
    await expect(unreadableToken.getDocument("file-1")).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      details: expect.objectContaining({
        reason: "REST_CREDENTIAL_UNAVAILABLE",
      }),
    });
  });

  it.each([
    [401, "NOT_CONNECTED", false],
    [429, "BUSY", true],
  ])(
    "preserves structured REST HTTP %i failures",
    async (status, code, retryable) => {
      const rest = new RestFigmaBridge({
        accessToken: "rest-secret",
        fileKey: "file-1",
        fetch: vi.fn(async () => new Response("failure", { status })),
      });
      const bridge = new HybridFigmaBridge(
        makeBridge({
          getDocument: vi.fn(async () => {
            throw preDispatchNotConnected();
          }),
        }),
        rest,
      );

      await expect(bridge.getDocument("file-1")).rejects.toMatchObject({
        code,
        retryable,
        details: expect.objectContaining({ status }),
      });
    },
  );

  it("bounds REST requests and reports timeout without retrying Plugin writes", async () => {
    vi.useFakeTimers();
    const rest = new RestFigmaBridge({
      accessToken: "rest-secret",
      fileKey: "file-1",
      timeoutMs: 50,
      fetch: vi.fn(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    });
    const bridge = new HybridFigmaBridge(
      makeBridge({
        getDocument: vi.fn(async () => {
          throw preDispatchNotConnected();
        }),
      }),
      rest,
    );

    const result = bridge.getDocument("file-1");
    const expectation = expect(result).rejects.toMatchObject({
      code: "NOT_CONNECTED",
      retryable: true,
      details: expect.objectContaining({ timeoutMs: 50 }),
    });
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
    vi.useRealTimers();
  });
});
