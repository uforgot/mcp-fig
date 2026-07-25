import { DesktopPluginBridgeHost } from "../dist/bridge/desktop-plugin.js";

const token = process.env.MCP_FIG_PLUGIN_TOKEN;
const port = Number(process.env.MCP_FIG_PLUGIN_PORT ?? "3847");
const encodedRequest = process.env.MCP_FIG_BROKER_REQUEST;

if (!token) throw new Error("MCP_FIG_PLUGIN_TOKEN is required.");
if (!encodedRequest) throw new Error("MCP_FIG_BROKER_REQUEST is required.");
const request = JSON.parse(encodedRequest);
const host = new DesktopPluginBridgeHost({ token, port });

try {
  await host.listen();
  const data = await host.request(
    request.clientId,
    request.method,
    request.params,
    request.options,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: error?.code ?? "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        retryable: error?.retryable ?? false,
        details: error?.details,
      },
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await host.close();
}
