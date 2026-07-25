import { z } from "zod";

type ObjectOption = z.ZodObject<z.ZodRawShape>;
type ObjectUnion = z.ZodType & { options: readonly ObjectOption[] };

/**
 * MCP requires an object schema at the root, while facade inputs use strict
 * unions keyed by `action`. The SDK validates unions but currently serializes
 * a root union as an empty object. This adapter exposes the merged object
 * fields to MCP clients and delegates exact action-specific validation back to
 * the original union.
 */
export function exposeMcpInputSchema<Schema extends ObjectUnion>(
  validator: Schema,
): Schema {
  const shapes = validator.options.map((option) => option.shape);
  const keys = [...new Set(shapes.flatMap((shape) => Object.keys(shape)))];
  const mergedShape: Record<string, z.ZodType> = {};

  for (const key of keys) {
    const schemas = [
      ...new Set(
        shapes
          .map((shape) => shape[key])
          .filter((schema): schema is z.ZodType => schema !== undefined)
          .map((schema) =>
            schema instanceof z.ZodDefault
              ? (schema.removeDefault() as z.ZodType)
              : schema,
          ),
      ),
    ];
    if (schemas.length === 0) continue;
    const schema =
      schemas.length === 1
        ? schemas[0]
        : z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    if (!schema) continue;
    mergedShape[key] = key === "action" ? schema : z.optional(schema);
  }

  const exposed = z
    .object(mergedShape)
    .passthrough()
    .superRefine((value, context) => {
      const result = validator.safeParse(value);
      if (result.success) return;
      for (const issue of result.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    });

  return exposed as unknown as Schema;
}
