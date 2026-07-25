import { describe, expect, it, vi } from "vitest";

import { RestFigmaBridge } from "../src/bridge/rest.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RestFigmaBridge", () => {
  it("authenticates, verifies a target, and reads documents and nodes", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        expect(request.headers.get("X-Figma-Token")).toBe("secret-token");

        if (request.url.endsWith("/v1/files/file-1")) {
          return jsonResponse({
            name: "REST fixture",
            version: "42",
            document: {
              id: "0:0",
              type: "DOCUMENT",
              name: "REST fixture",
              children: [
                {
                  id: "2:1",
                  type: "FRAME",
                  name: "Remote frame",
                  layoutMode: "HORIZONTAL",
                  width: 80,
                  height: 40,
                  children: [],
                },
              ],
            },
          });
        }
        if (request.url.includes("/v1/files/file-1/nodes?ids=")) {
          return jsonResponse({
            nodes: {
              "2:1": {
                document: {
                  id: "2:1",
                  type: "FRAME",
                  name: "Remote frame",
                  layoutMode: "HORIZONTAL",
                  itemSpacing: 12,
                  paddingTop: 8,
                  paddingRight: 16,
                  paddingBottom: 8,
                  paddingLeft: 16,
                  primaryAxisAlignItems: "MIN",
                  counterAxisAlignItems: "CENTER",
                  layoutWrap: "NO_WRAP",
                  absoluteBoundingBox: {
                    x: 10,
                    y: 20,
                    width: 80,
                    height: 40,
                  },
                },
              },
            },
          });
        }
        return jsonResponse({ message: "not found" }, 404);
      },
    );
    const bridge = new RestFigmaBridge({
      accessToken: "secret-token",
      fileKey: "file-1",
      fetch: fetchMock,
    });

    expect((await bridge.status()).connected).toBe(false);
    expect(await bridge.reconnect()).toMatchObject({
      connected: true,
      mode: "rest",
      fileKey: "file-1",
      fileName: "REST fixture",
      revision: "42",
      readSource: "rest",
      writeSource: "none",
    });
    expect(await bridge.getDocument()).toMatchObject({
      id: "0:0",
      name: "REST fixture",
    });
    expect(await bridge.getNodes(["2:1"])).toEqual([
      expect.objectContaining({
        id: "2:1",
        name: "Remote frame",
        x: 10,
        y: 20,
        width: 80,
        height: 40,
      }),
    ]);
    expect(
      await bridge.layout({ action: "inspect", nodeIds: ["2:1"] }),
    ).toMatchObject({
      layouts: [
        {
          nodeId: "2:1",
          layout: {
            layoutMode: "HORIZONTAL",
            itemSpacing: 12,
            padding: { top: 8, right: 16, bottom: 8, left: 16 },
          },
        },
      ],
    });
    expect(
      await bridge.layout({ action: "validate", nodeIds: ["2:1"] }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects selection and writes instead of pretending REST supports them", async () => {
    const bridge = new RestFigmaBridge({
      accessToken: "secret-token",
      fileKey: "file-1",
      fetch: vi.fn(),
    });

    await expect(bridge.getSelection()).rejects.toMatchObject({
      code: "UNSUPPORTED_BY_BRIDGE",
    });
    await expect(
      bridge.deleteNodes({ nodeIds: ["2:1"] }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_BY_BRIDGE",
    });
    await expect(
      bridge.layout({
        action: "apply",
        nodeIds: ["2:1"],
        layout: { layoutMode: "HORIZONTAL" },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BY_BRIDGE" });
  });
});
