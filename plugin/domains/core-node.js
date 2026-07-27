// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createCoreNodeDomain({
  figma,
  fail,
  assertNodeIds,
  cloneData,
  revisionCached,
  recordChange,
  getChanges,
  countSceneTraversal,
  nodeById,
  hasChildren,
  serializeNode,
  serializePaints,
  applyProps,
  validateProps,
  createByType,
}) {
  const exportFormats = ["PNG", "JPG", "SVG", "PDF"];
  const exportMimeTypes = {
    PNG: "image/png",
    JPG: "image/jpeg",
    SVG: "image/svg+xml",
    PDF: "application/pdf",
  };
  const maxExportBytes = 650_000;
  const maxTextRangeCharacters = 10_000;

  async function queryNodes(input) {
    const maxDepth = input.maxDepth ?? 8;
    const limit = input.limit ?? 50;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20)
      fail(
        "INVALID_ARGUMENT",
        "node.query maxDepth must be an integer from 0 to 20.",
      );
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail(
        "INVALID_ARGUMENT",
        "node.query limit must be an integer from 1 to 100.",
      );
    if (
      input.name === undefined &&
      input.nodeType === undefined &&
      input.path === undefined
    )
      fail("INVALID_ARGUMENT", "node.query requires name, nodeType, or path.");
    if (
      input.path !== undefined &&
      (!Array.isArray(input.path) ||
        input.path.length < 1 ||
        input.path.length > 20 ||
        input.path.some((segment) => typeof segment !== "string" || !segment))
    )
      fail(
        "INVALID_ARGUMENT",
        "node.query path must contain 1 to 20 non-empty segments.",
      );

    const root = input.rootId ? await nodeById(input.rootId) : figma.root;
    if (root.type === "DOCUMENT") await figma.loadAllPagesAsync();
    const caseSensitive = input.caseSensitive ?? true;
    const nameMatch = input.nameMatch ?? "exact";
    const normalize = (value) =>
      caseSensitive ? value : value.toLocaleLowerCase("en-US");
    const expectedName =
      input.name === undefined ? undefined : normalize(input.name);
    const samePath = (actual) =>
      input.path === undefined ||
      (actual.length === input.path.length &&
        actual.every(
          (segment, index) =>
            normalize(segment) === normalize(input.path[index]),
        ));
    const matches = [];
    let truncated = false;

    const visit = async (node, path, depth) => {
      if (depth > maxDepth) return false;
      countSceneTraversal();
      const actualName = normalize(node.name);
      const matchesName =
        expectedName === undefined ||
        (nameMatch === "contains"
          ? actualName.includes(expectedName)
          : actualName === expectedName);
      if (
        matchesName &&
        (input.nodeType === undefined || node.type === input.nodeType) &&
        samePath(path)
      ) {
        if (matches.length === limit) {
          truncated = true;
          return true;
        }
        matches.push({
          node: await serializeNode(node, false, false),
          path: [...path],
        });
      }
      if (depth === maxDepth || !hasChildren(node)) return false;
      for (const child of node.children) {
        if (await visit(child, [...path, child.name], depth + 1)) return true;
      }
      return false;
    };

    if (hasChildren(root)) {
      for (const child of root.children) {
        if (await visit(child, [child.name], 1)) break;
      }
    }
    return { matches, limit, truncated };
  }

  function capturePatchState(node, patch) {
    const state = { unrestorableMixed: [] };
    for (const key of Object.keys(patch)) {
      if (key === "width" || key === "height") continue;
      const property = key === "text" ? "characters" : key;
      if (!(property in node)) continue;
      if (typeof node[property] === "symbol") {
        state.unrestorableMixed.push(property);
        continue;
      }
      state[property] = cloneData(node[property]);
    }
    if (
      (patch.width !== undefined || patch.height !== undefined) &&
      "resize" in node
    )
      state.size = { width: node.width, height: node.height };
    return state;
  }

  async function restorePatchState(node, state) {
    if (
      node.type === "TEXT" &&
      state.fontName &&
      typeof state.fontName !== "symbol"
    )
      await figma.loadFontAsync(state.fontName);
    if (state.size && "resize" in node)
      node.resize(state.size.width, state.size.height);
    for (const [key, value] of Object.entries(state)) {
      if (key !== "size" && key !== "unrestorableMixed")
        node[key] = cloneData(value);
    }
  }

  function assertTextRange(node, start, end) {
    if (node.type !== "TEXT")
      fail("INVALID_ARGUMENT", `Node ${node.id} is not a text node.`);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > node.characters.length ||
      end - start > maxTextRangeCharacters
    )
      fail(
        "INVALID_ARGUMENT",
        `Text range must satisfy 0 <= start < end <= ${node.characters.length} and span at most ${maxTextRangeCharacters} UTF-16 code units.`,
      );
  }

  function serializeTextSegments(node, start, end) {
    return node
      .getStyledTextSegments(
        ["fontName", "fontSize", "lineHeight", "letterSpacing", "fills"],
        start,
        end,
      )
      .map((segment) => ({
        start: segment.start,
        end: segment.end,
        characters: segment.characters,
        fontName: cloneData(segment.fontName),
        fontSize: segment.fontSize,
        lineHeight: cloneData(segment.lineHeight),
        letterSpacing: cloneData(segment.letterSpacing),
        fills: serializePaints(segment.fills),
      }));
  }

  async function textRangeCommand(input) {
    const node = await nodeById(input.nodeId);
    if (input.action === "read") {
      assertTextRange(node, input.start, input.end);
      return {
        nodeId: node.id,
        start: input.start,
        end: input.end,
        characters: node.characters.slice(input.start, input.end),
        segments: serializeTextSegments(node, input.start, input.end),
      };
    }
    const ranges = input.ranges;
    if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 100)
      fail("INVALID_ARGUMENT", "text range update requires 1 to 100 ranges.");
    let previousEnd = -1;
    let touchedCharacters = 0;
    for (const range of ranges) {
      assertTextRange(node, range.start, range.end);
      touchedCharacters += range.end - range.start;
      if (touchedCharacters > maxTextRangeCharacters)
        fail(
          "INVALID_ARGUMENT",
          `Text range update may touch at most ${maxTextRangeCharacters} UTF-16 code units.`,
        );
      if (range.start < previousEnd)
        fail(
          "INVALID_ARGUMENT",
          "Text ranges must be sorted and non-overlapping.",
        );
      if (!range.style || Object.keys(range.style).length === 0)
        fail("INVALID_ARGUMENT", "Text range style cannot be empty.");
      previousEnd = range.end;
    }
    const snapshots = ranges.flatMap((range) =>
      serializeTextSegments(node, range.start, range.end),
    );
    const fonts = new Map();
    for (const range of ranges) {
      const values = range.style.fontName
        ? [range.style.fontName]
        : node.getRangeAllFontNames(range.start, range.end);
      for (const font of values)
        fonts.set(`${font.family}\u0000${font.style}`, font);
    }
    for (const segment of snapshots)
      fonts.set(
        `${segment.fontName.family}\u0000${segment.fontName.style}`,
        segment.fontName,
      );
    await Promise.all(
      [...fonts.values()].map((font) => figma.loadFontAsync(font)),
    );
    const apply = (start, end, style) => {
      if (style.fontName !== undefined)
        node.setRangeFontName(start, end, style.fontName);
      if (style.fontSize !== undefined)
        node.setRangeFontSize(start, end, style.fontSize);
      if (style.lineHeight !== undefined)
        node.setRangeLineHeight(start, end, style.lineHeight);
      if (style.letterSpacing !== undefined)
        node.setRangeLetterSpacing(start, end, style.letterSpacing);
      if (style.fills !== undefined)
        node.setRangeFills(start, end, style.fills);
    };
    try {
      for (const range of ranges) apply(range.start, range.end, range.style);
    } catch (error) {
      try {
        for (const segment of snapshots)
          apply(segment.start, segment.end, segment);
      } catch {
        fail(
          "UNKNOWN_OUTCOME",
          "Text range update failed and rollback was incomplete.",
        );
      }
      throw error;
    }
    recordChange("text-range-update", [node.id]);
    return {
      nodeId: node.id,
      ranges: ranges.map((range) => ({
        start: range.start,
        end: range.end,
        segments: serializeTextSegments(node, range.start, range.end),
      })),
    };
  }

  function imageMime(bytes) {
    if (
      bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => bytes[index] === value,
      )
    )
      return "image/png";
    if (
      bytes.length >= 3 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    )
      return "image/jpeg";
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
    fail(
      "INVALID_ARGUMENT",
      "Image bytes are not a supported PNG, JPEG, or GIF.",
    );
  }

  async function imageMetadata(image, expectedMime) {
    const bytes = await image.getBytesAsync();
    const mimeType = imageMime(bytes);
    if (expectedMime && mimeType !== expectedMime)
      fail(
        "INVALID_ARGUMENT",
        `Image MIME ${expectedMime} does not match its signature ${mimeType}.`,
      );
    const size = await image.getSizeAsync();
    return {
      hash: image.hash,
      mimeType,
      byteLength: bytes.byteLength,
      width: size.width,
      height: size.height,
    };
  }

  async function imageCommand(input) {
    if (input.action === "import") {
      let bytes;
      try {
        bytes = figma.base64Decode(input.dataBase64);
      } catch {
        fail("INVALID_ARGUMENT", "Image payload is not valid base64.");
      }
      if (bytes.byteLength < 6 || bytes.byteLength > 650_000)
        fail(
          "INVALID_ARGUMENT",
          "Image payload must be from 6 through 650000 bytes.",
        );
      const detected = imageMime(bytes);
      if (detected !== input.mimeType)
        fail(
          "INVALID_ARGUMENT",
          `Image MIME ${input.mimeType} does not match its signature ${detected}.`,
        );
      let image;
      try {
        image = figma.createImage(bytes);
      } catch (error) {
        fail("INVALID_ARGUMENT", `Figma rejected the image: ${String(error)}`);
      }
      return imageMetadata(image, detected);
    }
    const image = figma.getImageByHash(input.hash);
    if (!image)
      fail("INVALID_ARGUMENT", `Image hash ${input.hash} was not found.`);
    if (input.action === "inspect") return imageMetadata(image);
    assertNodeIds(input.nodeIds);
    const nodes = await Promise.all(input.nodeIds.map(nodeById));
    for (const node of nodes) {
      if (!("fills" in node))
        fail("INVALID_ARGUMENT", `Node ${node.id} does not support fills.`);
      if (node.fills === figma.mixed)
        fail("INVALID_ARGUMENT", `Node ${node.id} has mixed fills.`);
      if (
        input.operation === "replace" &&
        (!Number.isInteger(input.index) ||
          input.index < 0 ||
          input.index >= node.fills.length)
      )
        fail(
          "INVALID_ARGUMENT",
          `Node ${node.id} has no fill at index ${input.index}.`,
        );
    }
    const snapshots = nodes.map((node) => cloneData(node.fills));
    try {
      nodes.forEach((node) => {
        const fills = [...node.fills];
        const paint = {
          type: "IMAGE",
          imageHash: image.hash,
          scaleMode: input.scaleMode,
        };
        if (input.operation === "append") fills.push(paint);
        else fills[input.index] = paint;
        node.fills = fills;
      });
    } catch (error) {
      try {
        nodes.forEach((node, index) => {
          node.fills = cloneData(snapshots[index]);
        });
      } catch {
        fail(
          "UNKNOWN_OUTCOME",
          "Image fill update failed and rollback was incomplete.",
        );
      }
      throw error;
    }
    recordChange("image-fill", input.nodeIds);
    return {
      image: await imageMetadata(image),
      nodes: await Promise.all(nodes.map((node) => serializeNode(node))),
    };
  }

  async function coreCommand(method, input) {
    if (method === "document.summary") {
      return revisionCached("document.summary", async () => {
        await figma.loadAllPagesAsync();
        const byType = {};
        let nodeCount = 0;
        const visit = (node) => {
          nodeCount += 1;
          countSceneTraversal();
          byType[node.type] = (byType[node.type] || 0) + 1;
          if (hasChildren(node)) node.children.forEach(visit);
        };
        visit(figma.root);
        return {
          document: {
            id: figma.root.id,
            name: figma.root.name,
            type: figma.root.type,
          },
          nodeCount,
          byType,
        };
      });
    }
    if (method === "document.get") {
      await figma.loadAllPagesAsync();
      return serializeNode(figma.root, true);
    }
    if (method === "selection.get")
      return figma.currentPage.selection.map((node) => node.id);
    if (method === "changes.get") return getChanges();
    if (method === "node.text_range") return textRangeCommand(input);
    if (method === "node.image") return imageCommand(input);
    if (method === "node.query") return queryNodes(input);
    if (method === "node.get") {
      assertNodeIds(input.nodeIds);
      return Promise.all(
        input.nodeIds.map(async (id) => serializeNode(await nodeById(id))),
      );
    }
    if (method === "node.export") {
      assertNodeIds(input.nodeIds);
      const format = input.format;
      if (!exportFormats.includes(format))
        fail("INVALID_ARGUMENT", `Unsupported export format ${format}.`);
      const raster = format === "PNG" || format === "JPG";
      if (
        raster &&
        (typeof input.scale !== "number" ||
          !Number.isFinite(input.scale) ||
          input.scale <= 0 ||
          input.scale > 4)
      )
        fail(
          "INVALID_ARGUMENT",
          "Raster export scale must be greater than 0 and at most 4.",
        );
      if (!raster && input.scale !== undefined)
        fail("INVALID_ARGUMENT", `${format} export does not accept scale.`);

      const nodes = await Promise.all(input.nodeIds.map(nodeById));
      const settings = raster
        ? {
            format,
            constraint: { type: "SCALE", value: input.scale },
          }
        : { format };
      const results = [];
      for (const node of nodes) {
        if (typeof node.exportAsync !== "function")
          fail("UNSUPPORTED_BY_BRIDGE", `Node ${node.id} cannot be exported.`);
        const bytes = await node.exportAsync(settings);
        if (bytes.byteLength > maxExportBytes) {
          const recovery = raster
            ? "lower the scale"
            : `reduce the source complexity or export ${format} content as PNG/JPG`;
          fail(
            "INVALID_ARGUMENT",
            `Export for node ${node.id} is ${bytes.byteLength} bytes; ${recovery} to stay at or below ${maxExportBytes} bytes.`,
          );
        }
        results.push({
          nodeId: node.id,
          nodeName: node.name,
          format,
          mimeType: exportMimeTypes[format],
          byteLength: bytes.byteLength,
          dataBase64: figma.base64Encode(bytes),
        });
      }
      return results;
    }
    if (method === "node.create") {
      const parent = await nodeById(input.parentId);
      if (!hasChildren(parent) || typeof parent.appendChild !== "function") {
        fail(
          "INVALID_ARGUMENT",
          `Parent ${input.parentId} cannot contain children.`,
        );
      }
      if (input.dryRun) {
        return [
          {
            id: "preview:new",
            type: input.nodeType,
            name: input.name || input.nodeType,
            parentId: parent.id,
            ...input.props,
          },
        ];
      }
      const node = createByType(input.nodeType);
      try {
        await validateProps(node, input.props);
        parent.appendChild(node);
        if (input.name) node.name = input.name;
        await applyProps(node, input.props);
      } catch (error) {
        node.remove();
        throw error;
      }
      recordChange("create", [node.id]);
      return [await serializeNode(node)];
    }
    assertNodeIds(input.nodeIds);
    const nodes = await Promise.all(input.nodeIds.map(nodeById));
    if (input.dryRun) {
      if (method === "node.update") {
        await Promise.all(
          nodes.map((node) => validateProps(node, input.patch)),
        );
        return Promise.all(
          nodes.map(async (node) => ({
            ...(await serializeNode(node)),
            ...cloneData(input.patch),
          })),
        );
      }
      if (method === "node.move") {
        let parent;
        if (input.parentId) {
          parent = await nodeById(input.parentId);
          if (!hasChildren(parent) || typeof parent.insertChild !== "function")
            fail("INVALID_ARGUMENT", "Target parent cannot contain children.");
        }
        return Promise.all(
          nodes.map(async (node) => ({
            ...(await serializeNode(node)),
            ...(parent ? { parentId: parent.id } : {}),
            ...(input.x !== undefined ? { x: input.x } : {}),
            ...(input.y !== undefined ? { y: input.y } : {}),
          })),
        );
      }
      if (method === "node.resize") {
        for (const node of nodes)
          if (!("resize" in node))
            fail("INVALID_ARGUMENT", `Node ${node.id} cannot be resized.`);
        return Promise.all(
          nodes.map(async (node) => ({
            ...(await serializeNode(node)),
            width: input.size.width,
            height: input.size.height,
          })),
        );
      }
      if (method === "node.clone") {
        let parent;
        if (input.parentId) {
          parent = await nodeById(input.parentId);
          if (!hasChildren(parent) || typeof parent.appendChild !== "function")
            fail("INVALID_ARGUMENT", "Clone parent cannot contain children.");
        }
        return Promise.all(
          nodes.map(async (node) => {
            const snapshot = await serializeNode(node);
            return {
              ...snapshot,
              id: `preview:${node.id}`,
              ...(parent ? { parentId: parent.id } : {}),
              ...(input.offset && "x" in node
                ? { x: node.x + input.offset.x }
                : {}),
              ...(input.offset && "y" in node
                ? { y: node.y + input.offset.y }
                : {}),
            };
          }),
        );
      }
      if (method === "node.delete") return [...input.nodeIds];
    }
    if (method === "node.update") {
      await Promise.all(nodes.map((node) => validateProps(node, input.patch)));
      const snapshots = new Map(
        nodes.map((node) => [node.id, capturePatchState(node, input.patch)]),
      );
      try {
        for (const node of nodes) await applyProps(node, input.patch);
      } catch (error) {
        const rollback = await Promise.allSettled(
          nodes.map((node) => restorePatchState(node, snapshots.get(node.id))),
        );
        const hasUnrestorableMixed = [...snapshots.values()].some(
          (state) => state.unrestorableMixed.length > 0,
        );
        if (
          hasUnrestorableMixed ||
          rollback.some((result) => result.status === "rejected")
        )
          fail(
            "UNKNOWN_OUTCOME",
            "Node update failed and rollback could not restore every node.",
          );
        throw error;
      }
      recordChange("update", input.nodeIds);
      return Promise.all(nodes.map((node) => serializeNode(node)));
    }
    if (method === "node.move") {
      let parent;
      if (input.parentId) {
        parent = await nodeById(input.parentId);
        if (!hasChildren(parent) || typeof parent.insertChild !== "function")
          fail("INVALID_ARGUMENT", "Target parent cannot contain children.");
      }
      for (const node of nodes) {
        if (input.x !== undefined && !("x" in node))
          fail("INVALID_ARGUMENT", `Node ${node.id} cannot be positioned.`);
        if (input.y !== undefined && !("y" in node))
          fail("INVALID_ARGUMENT", `Node ${node.id} cannot be positioned.`);
      }
      nodes.forEach((node, offset) => {
        if (parent)
          parent.insertChild(
            (input.index ?? parent.children.length) + offset,
            node,
          );
        if (input.x !== undefined && "x" in node) node.x = input.x;
        if (input.y !== undefined && "y" in node) node.y = input.y;
      });
      recordChange("move", input.nodeIds);
      return Promise.all(nodes.map((node) => serializeNode(node)));
    }
    if (method === "node.resize") {
      for (const node of nodes)
        if (!("resize" in node))
          fail("INVALID_ARGUMENT", `Node ${node.id} cannot be resized.`);
      for (const node of nodes) {
        node.resize(input.size.width, input.size.height);
      }
      recordChange("resize", input.nodeIds);
      return Promise.all(nodes.map((node) => serializeNode(node)));
    }
    if (method === "node.clone") {
      for (const node of nodes)
        if (!("clone" in node))
          fail("UNSUPPORTED_BY_BRIDGE", `Node ${node.id} cannot be cloned.`);
      let cloneParent;
      if (input.parentId) {
        cloneParent = await nodeById(input.parentId);
        if (
          !hasChildren(cloneParent) ||
          typeof cloneParent.appendChild !== "function"
        )
          fail("INVALID_ARGUMENT", "Clone parent cannot contain children.");
      }
      const clones = nodes.map((node) => ({ clone: node.clone() }));
      for (const entry of clones) {
        if (cloneParent) cloneParent.appendChild(entry.clone);
        if (input.offset && "x" in entry.clone) entry.clone.x += input.offset.x;
        if (input.offset && "y" in entry.clone) entry.clone.y += input.offset.y;
      }
      recordChange(
        "clone",
        clones.map((entry) => entry.clone.id),
      );
      return Promise.all(clones.map((entry) => serializeNode(entry.clone)));
    }
    if (method === "node.delete") {
      for (const node of nodes) node.remove();
      recordChange("delete", input.nodeIds);
      return input.nodeIds;
    }
    fail("UNSUPPORTED_BY_BRIDGE", `Unknown core method ${method}.`);
  }
  return { command: coreCommand };
}
