import type { ServerResponse } from "node:http";

import type { PluginCommand, PluginHandshake } from "../plugin-protocol.js";

export type PluginSessionConnectionState =
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "superseded";

export interface PluginSessionState {
  handshake: PluginHandshake;
  connectedAt: string;
  lastSeenAt: string;
  lastSeenMs: number;
  state: PluginSessionConnectionState;
  queue: PluginCommand[];
  waiters: ServerResponse[];
}

export function latestRevision(current: string, incoming: string): string {
  if (/^\d+$/.test(current) && /^\d+$/.test(incoming)) {
    return BigInt(incoming) >= BigInt(current) ? incoming : current;
  }
  return incoming;
}

export class PluginSessionRegistry {
  readonly #sessions = new Map<string, PluginSessionState>();
  readonly #sessionTtlMs: number;
  #lastHandshakeAt: string | null = null;

  constructor(sessionTtlMs: number) {
    this.#sessionTtlMs = sessionTtlMs;
  }

  get(sessionId: string): PluginSessionState | undefined {
    return this.#sessions.get(sessionId);
  }

  acceptHandshake(handshake: PluginHandshake): {
    conflict: boolean;
    superseded?: boolean;
    now: string;
    session?: PluginSessionState;
  } {
    this.expire();
    const existing = this.#sessions.get(handshake.sessionId);
    if (
      existing &&
      (existing.handshake.clientId !== handshake.clientId ||
        existing.handshake.file.key !== handshake.file.key)
    ) {
      return { conflict: true, now: new Date().toISOString() };
    }
    if (
      existing?.state === "superseded" &&
      [...this.#sessions.values()].some(
        (session) =>
          session.handshake.sessionId !== handshake.sessionId &&
          session.state === "ready" &&
          session.handshake.file.key === handshake.file.key,
      )
    ) {
      return {
        conflict: false,
        superseded: true,
        now: new Date().toISOString(),
      };
    }
    if (existing) {
      handshake.file.revision = latestRevision(
        existing.handshake.file.revision,
        handshake.file.revision,
      );
    }
    const now = new Date().toISOString();
    const session: PluginSessionState = {
      handshake,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      lastSeenMs: Date.now(),
      state: "ready",
      queue: existing?.queue ?? [],
      waiters: existing?.waiters ?? [],
    };
    for (const candidate of this.#sessions.values()) {
      if (
        candidate.handshake.sessionId !== handshake.sessionId &&
        candidate.handshake.file.key === handshake.file.key
      ) {
        candidate.state = "superseded";
        this.#closeWaiters(candidate);
      }
    }
    this.#sessions.set(handshake.sessionId, session);
    this.#lastHandshakeAt = now;
    return { conflict: false, now, session };
  }

  touch(session: PluginSessionState): boolean {
    if (session.state === "superseded") return false;
    session.lastSeenAt = new Date().toISOString();
    session.lastSeenMs = Date.now();
    session.state = "ready";
    return true;
  }

  updateRevision(session: PluginSessionState, revision: string): void {
    session.handshake.file.revision = latestRevision(
      session.handshake.file.revision,
      revision,
    );
  }

  list(): PluginHandshake[] {
    this.expire();
    return [...this.#sessions.values()]
      .filter((session) => session.state === "ready")
      .map((session) => structuredClone(session.handshake));
  }

  lastHandshakeAt(): string | null {
    return this.#lastHandshakeAt;
  }

  forFile(fileKey: string): PluginSessionState | undefined {
    this.expire();
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          session.state === "ready" && session.handshake.file.key === fileKey,
      )
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs)[0];
  }

  latest(): PluginSessionState | undefined {
    this.expire();
    return [...this.#sessions.values()]
      .filter((session) => session.state === "ready")
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs)[0];
  }

  expire(): void {
    const now = Date.now();
    const readyFileKeys = new Set(
      [...this.#sessions.values()]
        .filter(
          (session) =>
            session.state === "ready" &&
            now - session.lastSeenMs <= this.#sessionTtlMs,
        )
        .map((session) => session.handshake.file.key),
    );
    for (const [sessionId, session] of this.#sessions) {
      if (now - session.lastSeenMs <= this.#sessionTtlMs) continue;
      if (
        session.state === "superseded" &&
        readyFileKeys.has(session.handshake.file.key)
      ) {
        continue;
      }
      session.state = "disconnected";
      this.#closeWaiters(session);
      this.#sessions.delete(sessionId);
    }
  }

  clear(): void {
    for (const session of this.#sessions.values()) {
      this.#closeWaiters(session);
    }
    this.#sessions.clear();
  }

  #closeWaiters(session: PluginSessionState): void {
    for (const waiter of session.waiters) {
      if (!waiter.writableEnded) waiter.end();
    }
    session.waiters.length = 0;
  }
}
