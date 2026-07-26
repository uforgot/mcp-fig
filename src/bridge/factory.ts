import type { ServerConfig } from "../config.js";
import { ServiceClient } from "../service/client.js";
import {
  DesktopPluginBridgeHost,
  DesktopPluginFigmaBridge,
} from "./desktop-plugin.js";
import { DisconnectedFigmaBridge } from "./disconnected.js";
import { RestFigmaBridge } from "./rest.js";
import type { FigmaBridge } from "./types.js";

export function createDefaultBridge(config: ServerConfig): FigmaBridge {
  if (config.service) {
    const service = new ServiceClient({
      ...(config.service.socketPath
        ? { socketPath: config.service.socketPath }
        : {}),
      clientId: config.service.clientId,
    });
    return new DesktopPluginFigmaBridge(service, {
      clientId: config.service.clientId,
      ...(config.service.fileKey ? { fileKey: config.service.fileKey } : {}),
    });
  }
  if (config.desktopPlugin) {
    const plugin = config.desktopPlugin;
    const host = new DesktopPluginBridgeHost({
      token: plugin.token,
      port: plugin.port,
    });
    void host.listen().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[mcp-fig] Desktop Plugin bridge failed to bind 127.0.0.1:${plugin.port}: ${message}`,
      );
    });
    return new DesktopPluginFigmaBridge(host, {
      clientId: plugin.clientId,
      ...(plugin.fileKey ? { fileKey: plugin.fileKey } : {}),
    });
  }
  if (config.figmaRest) {
    return new RestFigmaBridge({
      accessToken: config.figmaRest.accessToken,
      ...(config.figmaRest.fileKey
        ? { fileKey: config.figmaRest.fileKey }
        : {}),
      baseUrl: config.figmaRest.baseUrl,
    });
  }
  return new DisconnectedFigmaBridge();
}
