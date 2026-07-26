import type { ServerConfig } from "../config.js";
import { ServiceClient } from "../service/client.js";
import { readCredential } from "../service/credential.js";
import { servicePaths } from "../service/paths.js";
import {
  DesktopPluginBridgeHost,
  DesktopPluginFigmaBridge,
} from "./desktop-plugin.js";
import { DisconnectedFigmaBridge } from "./disconnected.js";
import { HybridFigmaBridge } from "./hybrid.js";
import { RestFigmaBridge } from "./rest.js";
import type { FigmaBridge } from "./types.js";

function createRestBridge(config: ServerConfig): RestFigmaBridge {
  const rest = config.figmaRest;
  return new RestFigmaBridge({
    ...(rest?.accessToken ? { accessToken: rest.accessToken } : {}),
    ...(!rest?.accessToken
      ? {
          loadAccessToken: async () => {
            try {
              return (await readCredential(servicePaths())).figmaAccessToken;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
              }
              throw error;
            }
          },
        }
      : {}),
    ...(rest?.fileKey ? { fileKey: rest.fileKey } : {}),
    baseUrl: rest?.baseUrl ?? "https://api.figma.com",
    timeoutMs: rest?.timeoutMs ?? 5_000,
  });
}

export function createDefaultBridge(config: ServerConfig): FigmaBridge {
  if (config.service) {
    const service = new ServiceClient({
      ...(config.service.socketPath
        ? { socketPath: config.service.socketPath }
        : {}),
      clientId: config.service.clientId,
    });
    const plugin = new DesktopPluginFigmaBridge(service, {
      clientId: config.service.clientId,
      ...(config.service.fileKey ? { fileKey: config.service.fileKey } : {}),
      waitForSessionOnRead: false,
    });
    return new HybridFigmaBridge(plugin, createRestBridge(config));
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
    const desktop = new DesktopPluginFigmaBridge(host, {
      clientId: plugin.clientId,
      ...(plugin.fileKey ? { fileKey: plugin.fileKey } : {}),
      ...(config.figmaRest ? { waitForSessionOnRead: false } : {}),
    });
    return config.figmaRest
      ? new HybridFigmaBridge(desktop, createRestBridge(config))
      : desktop;
  }
  if (config.figmaRest) {
    return createRestBridge(config);
  }
  return new DisconnectedFigmaBridge();
}
