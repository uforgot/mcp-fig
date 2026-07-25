import { randomUUID } from "node:crypto";

import { McpFigError } from "./errors.js";

interface Confirmation {
  action: string;
  fileKey: string;
  nodeIds: string[];
  expiresAt: number;
}

export class ConfirmationStore {
  readonly #entries = new Map<string, Confirmation>();
  readonly #ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.#ttlMs = ttlMs;
  }

  issue(action: string, fileKey: string, nodeIds: string[]): string {
    const token = randomUUID();
    this.#entries.set(token, {
      action,
      fileKey,
      nodeIds: [...nodeIds].sort(),
      expiresAt: Date.now() + this.#ttlMs,
    });
    return token;
  }

  consume(
    token: string | undefined,
    action: string,
    fileKey: string,
    nodeIds: string[],
  ): void {
    const entry = token ? this.#entries.get(token) : undefined;
    const targets = [...nodeIds].sort();
    const valid =
      token !== undefined &&
      entry !== undefined &&
      entry.expiresAt >= Date.now() &&
      entry.action === action &&
      entry.fileKey === fileKey &&
      entry.nodeIds.length === targets.length &&
      entry.nodeIds.every((nodeId, index) => nodeId === targets[index]);

    if (!valid || !token) {
      throw new McpFigError(
        "CONFIRMATION_REQUIRED",
        "A valid confirmation token for the exact target set is required.",
        { details: { action, fileKey, nodeIds: targets } },
      );
    }
    this.#entries.delete(token);
  }
}
