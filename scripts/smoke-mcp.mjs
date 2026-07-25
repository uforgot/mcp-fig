import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const client = new Client({ name: "mcp-fig-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_FIG_LOG_LEVEL: "error",
    MCP_FIG_PROFILES: "core",
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const result = CallToolResultSchema.parse(
    await client.callTool({
      name: "figma_connection",
      arguments: { action: "status" },
    }),
  );
  const text = result.content.find((item) => item.type === "text");
  const status = JSON.parse(text?.type === "text" ? text.text : "{}");

  if (tools.tools.map((tool) => tool.name).join(",") !== "figma_connection") {
    throw new Error("Unexpected foundation tool list");
  }
  if (status.ok !== true || status.data?.connected !== false) {
    throw new Error("Unexpected foundation health response");
  }

  console.log(
    JSON.stringify(
      {
        initialized: true,
        tools: tools.tools.map((tool) => tool.name),
        health: status.data,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
