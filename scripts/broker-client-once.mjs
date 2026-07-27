import { runWithTrace } from "../dist/observability/trace-context.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const request = JSON.parse(process.env.MCP_FIG_BROKER_REQUEST ?? "{}");
const client = new ServiceClient({
  socketPath: process.env.MCP_FIG_SERVICE_SOCKET ?? servicePaths().socketPath,
  clientId: request.clientId,
});

try {
  const invoke = () =>
    client.request(
      request.clientId,
      request.method,
      request.params,
      request.options,
    );
  const data = request.traceId
    ? await runWithTrace(request.traceId, invoke)
    : await invoke();
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: error?.code,
        message: error?.message,
        details: error?.details,
      },
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
