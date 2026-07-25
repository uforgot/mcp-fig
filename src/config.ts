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
  };
}
