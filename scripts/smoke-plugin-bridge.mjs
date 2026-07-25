import { createServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const token = "mcp-fig-smoke-token";
const sessionId = "stdio-smoke-session";
const fileKey = "stdio-smoke-file";
const controller = new AbortController();

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to reserve a smoke port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForPortRelease(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = createServer();
    const released = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (released) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Desktop plugin host did not release port ${port}.`);
}

async function fetchOk(url, init) {
  const response = await fetch(url, init);
  if (!response.ok && response.status !== 204) {
    throw new Error(
      `${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }
  return response;
}

async function fakePlugin(baseUrl) {
  const auth = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  let paired = false;
  while (!controller.signal.aborted) {
    try {
      if (!paired) {
        await fetchOk(`${baseUrl}/v1/session/handshake`, {
          method: "POST",
          headers: auth,
          signal: controller.signal,
          body: JSON.stringify({
            protocol: "mcp-fig-plugin/v1",
            sessionId,
            clientId: "fake-plugin-ui",
            file: { key: fileKey, name: "stdio smoke", revision: "1" },
            capabilities: [
              "document.read",
              "selection.read",
              "node.read",
              "node.write",
              "layout.write",
              "component.write",
              "instance.write",
              "tokens.write",
            ],
            sentAt: new Date().toISOString(),
          }),
        });
        paired = true;
      }
      const response = await fetchOk(
        `${baseUrl}/v1/session/${sessionId}/next`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );
      if (response.status === 204) continue;
      const command = await response.json();
      let data;
      if (command.method === "selection.get") data = ["2:1"];
      else if (command.method === "node.get") {
        data = [
          {
            id: "2:1",
            type: "RECTANGLE",
            name: "stdio live node",
            parentId: "1:0",
          },
        ];
      } else if (command.method === "node.update") {
        data = [
          {
            id: "2:1",
            type: "RECTANGLE",
            name: "stdio updated node",
            parentId: "1:0",
          },
        ];
      } else if (command.method === "layout")
        data = { repaired: true, issues: [] };
      else data = {};
      await fetchOk(`${baseUrl}/v1/session/${sessionId}/result`, {
        method: "POST",
        headers: auth,
        signal: controller.signal,
        body: JSON.stringify({
          protocol: "mcp-fig-plugin/v1",
          requestId: command.requestId,
          clientId: command.clientId,
          sessionId: command.sessionId,
          fileKey: command.fileKey,
          ok: true,
          data,
          receivedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      });
    } catch {
      if (controller.signal.aborted) return;
      paired = false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function payload(result) {
  const parsed = CallToolResultSchema.parse(result);
  const text = parsed.content.find((item) => item.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "{}");
}

const port = await freePort();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: {
    ...process.env,
    MCP_FIG_PLUGIN_TOKEN: token,
    MCP_FIG_PLUGIN_PORT: String(port),
    MCP_FIG_PLUGIN_CLIENT_ID: "stdio-smoke-client",
    MCP_FIG_PLUGIN_FILE_KEY: fileKey,
    MCP_FIG_LOG_LEVEL: "error",
  },
  stderr: "pipe",
});
const client = new Client({ name: "mcp-fig-plugin-smoke", version: "1" });
const plugin = fakePlugin(`http://127.0.0.1:${port}`);

try {
  await client.connect(transport);
  let connected = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = payload(
      await client.callTool({
        name: "figma_connection",
        arguments: { action: "status" },
      }),
    );
    if (status.data?.connected) {
      connected = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!connected)
    throw new Error(
      "Fake Desktop Plugin did not pair with the built stdio server.",
    );

  const selection = payload(
    await client.callTool({
      name: "figma_selection",
      arguments: { action: "inspect", fileKey },
    }),
  );
  const updated = payload(
    await client.callTool({
      name: "figma_node",
      arguments: {
        action: "update",
        nodeIds: ["2:1"],
        patch: { name: "stdio updated node" },
        fileKey,
      },
    }),
  );
  const repaired = payload(
    await client.callTool({
      name: "figma_layout",
      arguments: {
        action: "repair",
        nodeIds: ["2:1"],
        issueCodes: ["FILL_WITHOUT_AUTO_LAYOUT_PARENT"],
        fileKey,
      },
    }),
  );

  if (selection.data?.nodes?.[0]?.name !== "stdio live node")
    throw new Error("Selection round-trip failed.");
  if (updated.data?.nodes?.[0]?.name !== "stdio updated node")
    throw new Error("Node write round-trip failed.");
  if (repaired.data?.repaired !== true)
    throw new Error("Layout repair round-trip failed.");

  console.log(
    JSON.stringify(
      {
        initialized: true,
        transport: "stdio -> 127.0.0.1 -> fake-plugin",
        fileKey,
        selection: selection.data.nodeIds,
        nodeWrite: updated.data.nodes[0].name,
        layoutRepair: repaired.data.repaired,
      },
      null,
      2,
    ),
  );
} finally {
  controller.abort();
  await client.close();
  await plugin;
  await waitForPortRelease(port);
}
