// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createStylesDomain({
  figma,
  fail,
  revisionCached,
  countSceneTraversal,
  recordChange,
  cloneData,
}) {
  function kindOf(style) {
    if (["PAINT", "TEXT", "EFFECT", "GRID"].includes(style.type))
      return style.type;
    fail("INVALID_ARGUMENT", `Unsupported Figma style type ${style.type}.`);
  }

  function normalizeStyleValue(value) {
    if (typeof value === "number")
      return Math.round(value * 1_000_000) / 1_000_000;
    if (Array.isArray(value)) return value.map(normalizeStyleValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeStyleValue(item),
        ]),
      );
    return value;
  }

  function serializePaint(paint) {
    const output = normalizeStyleValue(cloneData(paint));
    if (output.visible === true) delete output.visible;
    if (output.blendMode === "NORMAL") delete output.blendMode;
    if (output.opacity === 1) delete output.opacity;
    delete output.boundVariables;
    return output;
  }

  function serializeStyle(style) {
    const common = {
      source: style.remote ? "library" : "local",
      kind: kindOf(style),
      id: style.id,
      key: style.key,
      name: style.name,
      description: style.description || "",
    };
    if (style.type === "PAINT")
      return { ...common, paints: style.paints.map(serializePaint) };
    if (style.type === "EFFECT")
      return { ...common, effects: normalizeStyleValue(style.effects) };
    if (style.type === "GRID")
      return { ...common, grids: normalizeStyleValue(style.layoutGrids) };
    return {
      ...common,
      text: normalizeStyleValue({
        fontName: style.fontName,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        paragraphIndent: style.paragraphIndent,
        paragraphSpacing: style.paragraphSpacing,
        textCase: style.textCase,
        textDecoration: style.textDecoration,
      }),
    };
  }

  async function localStyles() {
    const groups = await Promise.all([
      figma.getLocalPaintStylesAsync(),
      figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(),
      figma.getLocalGridStylesAsync(),
    ]);
    const styles = groups.flat();
    countSceneTraversal(styles.length);
    return styles;
  }

  async function requireLocalStyle(styleId) {
    const style = (await localStyles()).find(
      (candidate) => candidate.id === styleId,
    );
    if (!style) fail("NODE_NOT_FOUND", `Style ${styleId} was not found.`);
    if (style.remote)
      fail("INVALID_ARGUMENT", "Published library styles are read-only.");
    return style;
  }

  function snapshot(style) {
    return serializeStyle(style);
  }

  async function applyWrite(style, write) {
    style.name = write.name;
    style.description = write.description || "";
    if (write.kind === "PAINT") {
      style.paints = cloneData(write.paints);
    } else if (write.kind === "EFFECT") {
      style.effects = cloneData(write.effects);
    } else if (write.kind === "GRID") {
      style.layoutGrids = cloneData(write.grids);
    } else {
      await figma.loadFontAsync(write.text.fontName);
      style.fontName = cloneData(write.text.fontName);
      style.fontSize = write.text.fontSize;
      style.lineHeight = cloneData(write.text.lineHeight);
      style.letterSpacing = cloneData(write.text.letterSpacing);
      style.paragraphIndent = write.text.paragraphIndent || 0;
      style.paragraphSpacing = write.text.paragraphSpacing || 0;
      style.textCase = write.text.textCase || "ORIGINAL";
      style.textDecoration = write.text.textDecoration || "NONE";
    }
  }

  async function restore(style, saved) {
    await applyWrite(style, saved);
  }

  function createStyle(kind) {
    if (kind === "PAINT") return figma.createPaintStyle();
    if (kind === "TEXT") return figma.createTextStyle();
    if (kind === "EFFECT") return figma.createEffectStyle();
    return figma.createGridStyle();
  }

  async function importPublishedStyle(styleKey) {
    let timeout;
    try {
      return await Promise.race([
        figma.importStyleByKeyAsync(styleKey),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Figma style import timed out.")),
            4000,
          );
        }),
      ]);
    } catch (error) {
      const timedOut = error?.message === "Figma style import timed out.";
      fail(
        timedOut ? "UNKNOWN_OUTCOME" : "LIBRARY_IMPORT_FAILED",
        timedOut
          ? "Figma style import timed out, but the uncancellable import may still complete."
          : "Figma could not import the published style key.",
        false,
        {
          reason: timedOut ? "TIMEOUT_PENDING" : "PLAN_ACCESS_OR_KEY",
          styleKey,
        },
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async function stylesCommand(input) {
    if (input.action === "inspect") {
      return revisionCached("styles.inventory", async () => {
        const selectedIds = input.styleIds
          ? new Set(input.styleIds)
          : undefined;
        const styles = (await localStyles())
          .filter(
            (style) =>
              (!input.kind || style.type === input.kind) &&
              (!selectedIds || selectedIds.has(style.id)),
          )
          .map(serializeStyle);
        return { styles };
      });
    }

    if (input.action === "library_import") {
      if (input.dryRun)
        return { dryRun: true, action: input.action, styleKey: input.styleKey };
      const style = await importPublishedStyle(input.styleKey);
      recordChange("styles.library_import", [style.id]);
      return { style: serializeStyle(style) };
    }

    if (input.action === "delete") {
      const style = await requireLocalStyle(input.styleId);
      if (input.dryRun)
        return { dryRun: true, wouldDelete: serializeStyle(style) };
      style.remove();
      recordChange("styles.delete", [input.styleId]);
      return { deletedStyleId: input.styleId };
    }

    if (input.action === "create") {
      if (input.dryRun)
        return { dryRun: true, predictedStyle: cloneData(input.style) };
      const style = createStyle(input.style.kind);
      try {
        await applyWrite(style, input.style);
      } catch (error) {
        style.remove();
        throw error;
      }
      recordChange("styles.create", [style.id]);
      return { style: serializeStyle(style) };
    }

    const style = await requireLocalStyle(input.styleId);
    if (style.type !== input.style.kind)
      fail("INVALID_ARGUMENT", "A local style kind cannot be changed.");
    if (input.dryRun)
      return {
        dryRun: true,
        before: serializeStyle(style),
        predictedStyle: cloneData(input.style),
      };
    const saved = snapshot(style);
    try {
      await applyWrite(style, input.style);
    } catch (error) {
      try {
        await restore(style, saved);
      } catch (rollbackError) {
        fail(
          "UNKNOWN_OUTCOME",
          "Style update failed and its rollback also failed.",
          false,
          {
            styleId: style.id,
            cause: error?.message || String(error),
            rollbackCause: rollbackError?.message || String(rollbackError),
          },
        );
      }
      throw error;
    }
    recordChange("styles.update", [style.id]);
    return { style: serializeStyle(style) };
  }

  return { command: stylesCommand };
}
