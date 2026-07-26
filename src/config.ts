export const PROFILE_NAMES = [
  "core",
  "tokens",
  "libraries",
  "collaboration",
  "history",
  "slides",
  "figjam",
  "debug",
  "advanced",
] as const;

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ServerConfig {
  version: string;
  profiles: ProfileName[];
  logLevel: LogLevel;
  figmaRest?: {
    accessToken: string;
    fileKey?: string | undefined;
    baseUrl: string;
  };
  service?: {
    socketPath?: string | undefined;
    clientId: string;
    fileKey?: string | undefined;
  };
  desktopPlugin?: {
    token: string;
    port: number;
    clientId: string;
    fileKey?: string | undefined;
  };
}

function parseDesktopMode(
  value: string | undefined,
): "service" | "manual" | undefined {
  if (value === undefined) return undefined;
  if (value !== "service" && value !== "manual") {
    throw new Error("MCP_FIG_DESKTOP_MODE must be service or manual.");
  }
  return value;
}

function parsePluginPort(value: string | undefined): number {
  const port = value === undefined ? 3847 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "MCP_FIG_PLUGIN_PORT must be an integer between 1 and 65535.",
    );
  }
  return port;
}

function parseProfiles(value: string | undefined): ProfileName[] {
  const requested = value
    ?.split(",")
    .map((profile) => profile.trim())
    .filter(Boolean);
  const profiles = requested?.length ? requested : ["core"];
  const enabled: ProfileName[] = ["core"];

  for (const profile of profiles) {
    if (!PROFILE_NAMES.includes(profile as ProfileName)) {
      throw new Error(`Unknown MCP Fig profile: ${profile}`);
    }
    if (profile !== "core" && !enabled.includes(profile as ProfileName)) {
      enabled.push(profile as ProfileName);
    }
  }

  return enabled;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = value ?? "info";
  if (!LOG_LEVELS.includes(level as LogLevel)) {
    throw new Error(`Unknown MCP Fig log level: ${level}`);
  }
  return level as LogLevel;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const requestedMode = parseDesktopMode(env.MCP_FIG_DESKTOP_MODE);
  const desktopMode =
    requestedMode ??
    (env.MCP_FIG_PLUGIN_TOKEN || env.MCP_FIG_SERVICE_SOCKET
      ? "service"
      : undefined);
  if (desktopMode === "manual" && !env.MCP_FIG_PLUGIN_TOKEN) {
    throw new Error("MCP_FIG_PLUGIN_TOKEN is required for manual mode.");
  }
  if (env.MCP_FIG_PLUGIN_TOKEN) parsePluginPort(env.MCP_FIG_PLUGIN_PORT);
  const clientId = env.MCP_FIG_PLUGIN_CLIENT_ID ?? `mcp-fig-${process.pid}`;

  return {
    version: env.MCP_FIG_VERSION ?? "0.0.0",
    profiles: parseProfiles(env.MCP_FIG_PROFILES),
    logLevel: parseLogLevel(env.MCP_FIG_LOG_LEVEL),
    ...(env.FIGMA_ACCESS_TOKEN
      ? {
          figmaRest: {
            accessToken: env.FIGMA_ACCESS_TOKEN,
            fileKey: env.FIGMA_FILE_KEY,
            baseUrl: env.FIGMA_API_BASE_URL ?? "https://api.figma.com",
          },
        }
      : {}),
    ...(desktopMode === "service"
      ? {
          service: {
            ...(env.MCP_FIG_SERVICE_SOCKET
              ? { socketPath: env.MCP_FIG_SERVICE_SOCKET }
              : {}),
            clientId,
            ...(env.MCP_FIG_PLUGIN_FILE_KEY
              ? { fileKey: env.MCP_FIG_PLUGIN_FILE_KEY }
              : {}),
          },
        }
      : {}),
    ...(desktopMode === "manual" && env.MCP_FIG_PLUGIN_TOKEN
      ? {
          desktopPlugin: {
            token: env.MCP_FIG_PLUGIN_TOKEN,
            port: parsePluginPort(env.MCP_FIG_PLUGIN_PORT),
            clientId,
            ...(env.MCP_FIG_PLUGIN_FILE_KEY
              ? { fileKey: env.MCP_FIG_PLUGIN_FILE_KEY }
              : {}),
          },
        }
      : {}),
  };
}
