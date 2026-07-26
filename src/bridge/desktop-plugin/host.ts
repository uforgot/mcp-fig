import { createServer, type Server } from "node:http";

import { McpFigError } from "../../errors.js";
import {
  PLUGIN_PROTOCOL_V1,
  type PluginHandshake,
} from "../plugin-protocol.js";
import type { BridgeStatus } from "../types.js";
import {
  type HostAddress,
  PluginHttpRouter,
  requestBrokerJson,
  writeJson,
} from "./http.js";
import { PluginSessionRegistry } from "./sessions.js";
import { PluginWriteCoordinator } from "./write-coordinator.js";

export interface HostOptions {
  token: string;
  port?: number;
  requestTimeoutMs?: number;
  sessionTtlMs?: number;
  maxWriteQueue?: number;
  allowProxy?: boolean;
}

export type { HostAddress } from "./http.js";

export class DesktopPluginBridgeHost {
  readonly #options: Required<HostOptions>;
  readonly #sessions: PluginSessionRegistry;
  readonly #coordinator: PluginWriteCoordinator;
  readonly #router: PluginHttpRouter;
  #server: Server | undefined;
  #address: HostAddress | undefined;
  #proxyAddress: HostAddress | undefined;
  #listenPromise: Promise<HostAddress> | undefined;
  #closing = false;

  constructor(options: HostOptions) {
    if (!options.token) {
      throw new Error("Desktop Plugin session token must not be empty.");
    }
    this.#options = {
      token: options.token,
      port: options.port ?? 3847,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      sessionTtlMs: options.sessionTtlMs ?? 30_000,
      maxWriteQueue: options.maxWriteQueue ?? 100,
      allowProxy: options.allowProxy ?? true,
    };
    this.#sessions = new PluginSessionRegistry(this.#options.sessionTtlMs);
    this.#coordinator = new PluginWriteCoordinator({
      sessions: this.#sessions,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      maxWriteQueue: this.#options.maxWriteQueue,
      sendJson: writeJson,
    });
    this.#router = new PluginHttpRouter({
      token: this.#options.token,
      sessions: this.#sessions,
      coordinator: this.#coordinator,
      status: (fileKey) => this.status(fileKey),
      request: (clientId, method, params, requestOptions) =>
        this.#coordinator.request(clientId, method, params, requestOptions),
      metrics: () => this.metrics(),
    });
  }

  listen(): Promise<HostAddress> {
    if (this.#address) return Promise.resolve(this.#address);
    if (this.#closing) {
      return Promise.reject(new Error("Desktop Plugin host is closing."));
    }
    this.#listenPromise ??= this.#startListening();
    return this.#listenPromise;
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#listenPromise?.catch(() => undefined);
    this.#coordinator.close();
    this.#sessions.clear();
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    this.#proxyAddress = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  metrics() {
    return this.#coordinator.metrics();
  }

  sessions(): PluginHandshake[] {
    return this.#sessions.list();
  }

  async sessionsAsync(): Promise<PluginHandshake[]> {
    await this.listen();
    if (!this.#proxyAddress) return this.sessions();
    const payload = await requestBrokerJson<{ sessions: PluginHandshake[] }>(
      this.#proxyAddress,
      this.#options.token,
      "/v1/broker/sessions",
    );
    return payload.sessions;
  }

  async waitForSession(
    fileKey: string,
    timeoutMs = 5_000,
  ): Promise<PluginHandshake> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const session = this.#sessions.forFile(fileKey);
      if (session) return structuredClone(session.handshake);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new McpFigError(
      "NOT_CONNECTED",
      `Desktop Plugin did not pair file ${fileKey}.`,
      { retryable: true },
    );
  }

  status(fileKey?: string): BridgeStatus {
    const session = fileKey
      ? this.#sessions.forFile(fileKey)
      : this.#sessions.latest();
    if (!session) {
      return {
        connected: false,
        connectionState: "disconnected",
        mode: "desktop-plugin",
        readSource: "none",
        writeSource: "none",
      };
    }
    return {
      connected: true,
      connectionState: session.state,
      lastHeartbeatAt: session.lastSeenAt,
      mode: "desktop-plugin",
      fileKey: session.handshake.file.key,
      fileName: session.handshake.file.name,
      revision: session.handshake.file.revision,
      readSource: "desktop-plugin",
      writeSource: "desktop-plugin",
    };
  }

  async statusAsync(fileKey?: string): Promise<BridgeStatus> {
    await this.listen();
    if (!this.#proxyAddress) return this.status(fileKey);
    const query = fileKey ? `?fileKey=${encodeURIComponent(fileKey)}` : "";
    const payload = await requestBrokerJson<{ status: BridgeStatus }>(
      this.#proxyAddress,
      this.#options.token,
      `/v1/broker/status${query}`,
    );
    return payload.status;
  }

  async request(
    clientId: string,
    method: string,
    params: unknown,
    options: { fileKey?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    await this.listen();
    if (this.#proxyAddress) {
      const payload = await requestBrokerJson<{ data: unknown }>(
        this.#proxyAddress,
        this.#options.token,
        "/v1/broker/request",
        {
          method: "POST",
          body: JSON.stringify({ clientId, method, params, options }),
        },
      );
      return payload.data;
    }
    return this.#coordinator.request(clientId, method, params, options);
  }

  async #startListening(): Promise<HostAddress> {
    if (this.#address) return this.#address;
    const server = createServer((request, response) => {
      void this.#router.route(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#options.port, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      server.removeAllListeners();
      if (
        this.#options.allowProxy &&
        this.#options.port > 0 &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EADDRINUSE"
      ) {
        const proxyAddress: HostAddress = {
          host: "127.0.0.1",
          port: this.#options.port,
          url: `http://127.0.0.1:${this.#options.port}`,
        };
        try {
          const health = await requestBrokerJson<{ protocol: string }>(
            proxyAddress,
            this.#options.token,
            "/v1/broker/health",
          );
          if (health.protocol !== PLUGIN_PROTOCOL_V1) throw error;
        } catch {
          throw error;
        }
        this.#proxyAddress = proxyAddress;
        this.#address = proxyAddress;
        return proxyAddress;
      }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Desktop Plugin host did not bind a TCP port.");
    }
    if (this.#closing) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Desktop Plugin host closed while binding.");
    }
    this.#server = server;
    this.#address = {
      host: "127.0.0.1",
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
    };
    return this.#address;
  }
}
