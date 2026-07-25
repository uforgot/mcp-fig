import type { ServerConfig } from "../config.js";
import { DisconnectedFigmaBridge } from "./disconnected.js";
import { RestFigmaBridge } from "./rest.js";
import type { FigmaBridge } from "./types.js";

export function createDefaultBridge(config: ServerConfig): FigmaBridge {
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
