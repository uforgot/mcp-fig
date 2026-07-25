import { z } from "zod";

export const writeControlSchema = {
  expectedRevision: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
} as const;
