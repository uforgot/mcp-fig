import { isDeepStrictEqual } from "node:util";
import { DesktopPluginFigmaBridge } from "../dist/bridge/desktop-plugin.js";
import { ServiceClient } from "../dist/service/client.js";
import { servicePaths } from "../dist/service/paths.js";

const timeoutMs = Number(process.env.MCP_FIG_CANARY_TIMEOUT_MS ?? "300000");
const previousSessionIds = new Set(
  (process.env.MCP_FIG_AFTER_SESSION_IDS ?? "").split(",").filter(Boolean),
);
const clientId = `live-variables-styles-${process.pid}`;
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const prefix = `MCP Fig Variables Styles ${suffix}`;
const client = new ServiceClient({
  socketPath: process.env.MCP_FIG_SERVICE_SOCKET ?? servicePaths().socketPath,
  clientId,
});
const bridge = new DesktopPluginFigmaBridge(client, { clientId });
let fileKey;
let collectionId;
let nodeId;
const styleIds = [];
let runError;
let cleanupError;

function equal(left, right) {
  return isDeepStrictEqual(left, right);
}

function assert(condition, message, details) {
  if (!condition)
    throw new Error(
      details === undefined
        ? message
        : `${message}: ${JSON.stringify(details)}`,
    );
}

async function expectInvalid(run, label) {
  try {
    await run();
  } catch (error) {
    assert(
      error?.code === "INVALID_ARGUMENT",
      `${label} returned the wrong error`,
      { code: error?.code, message: error?.message },
    );
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function waitForPlugin() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const session of await client.sessionsAsync()) {
      if (previousSessionIds.has(session.sessionId)) continue;
      try {
        await bridge.targetFile(session.file.key);
        await bridge.getSelection(session.file.key);
        return session;
      } catch (error) {
        if (error?.code !== "NOT_CONNECTED") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Plugin did not complete a live read within ${timeoutMs}ms.`);
}

async function inspectTokens() {
  return bridge.tokens({ action: "inspect", fileKey });
}

try {
  const health = await client.health();
  const connected = await waitForPlugin();
  fileKey = connected.file.key;
  assert(fileKey, "Connected Plugin did not provide a file key.");
  const pages = await bridge.queryNodes({
    fileKey,
    nodeType: "PAGE",
    maxDepth: 1,
    limit: 100,
  });
  const page = pages.matches[0]?.node;
  assert(page, "Live document returned no PAGE node.");

  const [node] = await bridge.createNode({
    fileKey,
    parentId: page.id,
    nodeType: "RECTANGLE",
    name: `${prefix} Binding Target`,
    props: { x: 80, y: 80, width: 120, height: 80 },
    idempotencyKey: `variables-styles-node-${suffix}`,
  });
  assert(node, "Binding target creation returned no node.");
  nodeId = node.id;

  const collectionResult = await bridge.tokens({
    action: "collection_create",
    fileKey,
    name: `${prefix} Theme`,
    initialModeName: "Light",
  });
  collectionId = collectionResult.collection.id;
  const lightModeId = collectionResult.collection.defaultModeId;
  assert(lightModeId, "Collection create returned no default Light mode.");

  await bridge.tokens({
    action: "collection_update",
    fileKey,
    collectionId,
    name: `${prefix} Theme Updated`,
  });
  const brandResult = await bridge.tokens({
    action: "variable_create",
    fileKey,
    collectionId,
    name: `${prefix}/color/brand`,
    description: "Live brand color",
    resolvedType: "COLOR",
  });
  const accentResult = await bridge.tokens({
    action: "variable_create",
    fileKey,
    collectionId,
    name: `${prefix}/color/accent`,
    resolvedType: "COLOR",
  });
  const floatResult = await bridge.tokens({
    action: "variable_create",
    fileKey,
    collectionId,
    name: `${prefix}/spacing/base`,
    resolvedType: "FLOAT",
  });
  const temporaryResult = await bridge.tokens({
    action: "variable_create",
    fileKey,
    collectionId,
    name: `${prefix}/temporary`,
    resolvedType: "STRING",
  });
  const brandId = brandResult.variable.id;
  const accentId = accentResult.variable.id;
  const floatId = floatResult.variable.id;
  await bridge.tokens({
    action: "variable_update",
    fileKey,
    variableId: brandId,
    name: `${prefix}/color/brand-updated`,
    description: "Live brand color updated",
  });
  await bridge.tokens({
    action: "variable_delete",
    fileKey,
    variableId: temporaryResult.variable.id,
  });

  const added = await bridge.tokens({
    action: "apply",
    fileKey,
    operations: [
      { op: "mode_add", collectionId, name: "Dark" },
      { op: "mode_add", collectionId, name: "Temporary" },
    ],
  });
  const addedCollection = added.collections.find(
    (collection) => collection.id === collectionId,
  );
  const darkModeId = addedCollection?.modes.find(
    (mode) => mode.name === "Dark",
  )?.id;
  const temporaryModeId = addedCollection?.modes.find(
    (mode) => mode.name === "Temporary",
  )?.id;
  assert(
    darkModeId && temporaryModeId,
    "Mode add readback was incomplete.",
    added,
  );
  await bridge.tokens({
    action: "apply",
    fileKey,
    operations: [
      { op: "mode_rename", collectionId, modeId: darkModeId, name: "Night" },
      { op: "mode_rename", collectionId, modeId: darkModeId, name: "Dark" },
      { op: "mode_remove", collectionId, modeId: temporaryModeId },
    ],
  });

  const light = { r: 0.12, g: 0.24, b: 0.48, a: 1 };
  const dark = { r: 0.72, g: 0.82, b: 0.96, a: 1 };
  await bridge.tokens({
    action: "apply",
    fileKey,
    operations: [
      {
        op: "set_value",
        variableId: brandId,
        modeId: lightModeId,
        value: light,
      },
      { op: "set_value", variableId: brandId, modeId: darkModeId, value: dark },
      { op: "set_value", variableId: floatId, modeId: lightModeId, value: 8 },
      { op: "set_value", variableId: floatId, modeId: darkModeId, value: 12 },
      {
        op: "alias",
        variableId: accentId,
        modeId: lightModeId,
        targetVariableId: brandId,
      },
      {
        op: "alias",
        variableId: accentId,
        modeId: darkModeId,
        targetVariableId: brandId,
      },
      { op: "bind", nodeIds: [nodeId], field: "fills", variableId: accentId },
    ],
  });

  const tokenReadback = await inspectTokens();
  const collection = tokenReadback.collections.find(
    (candidate) => candidate.id === collectionId,
  );
  const brand = tokenReadback.variables.find(
    (candidate) => candidate.id === brandId,
  );
  const accent = tokenReadback.variables.find(
    (candidate) => candidate.id === accentId,
  );
  assert(
    collection?.name === `${prefix} Theme Updated`,
    "Collection rename mismatch",
    collection,
  );
  assert(
    equal(collection.modes, [
      { id: lightModeId, name: "Light" },
      { id: darkModeId, name: "Dark" },
    ]),
    "Canonical Light/Dark modes mismatch",
    collection?.modes,
  );
  assert(
    equal(brand?.valuesByMode[lightModeId], light),
    "Light RGBA mismatch",
    brand,
  );
  assert(
    equal(brand?.valuesByMode[darkModeId], dark),
    "Dark RGBA mismatch",
    brand,
  );
  assert(
    equal(accent?.valuesByMode[lightModeId], {
      type: "VARIABLE_ALIAS",
      id: brandId,
    }),
    "Light alias mismatch",
    accent,
  );
  assert(
    equal(accent?.valuesByMode[darkModeId], {
      type: "VARIABLE_ALIAS",
      id: brandId,
    }),
    "Dark alias mismatch",
    accent,
  );
  const [boundNode] = await bridge.getNodes([nodeId], fileKey);
  assert(
    equal(boundNode?.fills?.[0]?.boundVariables?.color, {
      type: "VARIABLE_ALIAS",
      id: accentId,
    }),
    "Node binding readback mismatch",
    boundNode?.fills,
  );

  await expectInvalid(
    () =>
      bridge.tokens({
        action: "apply",
        fileKey,
        operations: [
          {
            op: "alias",
            variableId: brandId,
            modeId: lightModeId,
            targetVariableId: accentId,
          },
        ],
      }),
    "alias cycle",
  );
  await expectInvalid(
    () =>
      bridge.tokens({
        action: "apply",
        fileKey,
        operations: [
          {
            op: "alias",
            variableId: brandId,
            modeId: lightModeId,
            targetVariableId: floatId,
          },
        ],
      }),
    "alias type mismatch",
  );
  const afterInvalid = await inspectTokens();
  const brandAfterInvalid = afterInvalid.variables.find(
    (candidate) => candidate.id === brandId,
  );
  assert(
    equal(brandAfterInvalid?.valuesByMode[lightModeId], light),
    "Invalid alias changed the prior Light value",
    brandAfterInvalid,
  );

  const styleWrites = [
    {
      kind: "PAINT",
      name: `${prefix} Paint`,
      description: "Live paint",
      paints: [
        { type: "SOLID", color: { r: 0.18, g: 0.32, b: 0.64 }, opacity: 1 },
      ],
    },
    {
      kind: "TEXT",
      name: `${prefix} Text`,
      text: {
        fontName: { family: "Inter", style: "Regular" },
        fontSize: 16,
        lineHeight: { unit: "PIXELS", value: 24 },
        letterSpacing: { unit: "PERCENT", value: 0 },
        paragraphSpacing: 8,
      },
    },
    {
      kind: "EFFECT",
      name: `${prefix} Effect`,
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.2 },
          offset: { x: 0, y: 2 },
          radius: 8,
          visible: true,
          blendMode: "NORMAL",
        },
      ],
    },
    {
      kind: "GRID",
      name: `${prefix} Grid`,
      grids: [
        {
          pattern: "COLUMNS",
          alignment: "STRETCH",
          gutterSize: 24,
          count: 12,
          offset: 0,
        },
      ],
    },
  ];
  for (const style of styleWrites) {
    const created = await bridge.styles({ action: "create", fileKey, style });
    styleIds.push(created.style.id);
  }
  const styles = await bridge.styles({ action: "inspect", fileKey, styleIds });
  assert(
    styles.styles.length === 4,
    "Style inventory count mismatch",
    styles.styles,
  );
  for (const write of styleWrites) {
    const actual = styles.styles.find((style) => style.name === write.name);
    assert(
      actual?.kind === write.kind && actual.source === "local",
      "Style readback mismatch",
      {
        expected: write,
        actual,
      },
    );
  }
  await bridge.styles({
    action: "update",
    fileKey,
    styleId: styleIds[0],
    style: {
      kind: "PAINT",
      name: `${prefix} Paint Updated`,
      paints: [
        { type: "SOLID", color: { r: 0.7, g: 0.6, b: 0.5 }, opacity: 0.9 },
      ],
    },
  });
  const paintReadback = await bridge.styles({
    action: "inspect",
    fileKey,
    styleIds: [styleIds[0]],
  });
  assert(
    equal(paintReadback.styles[0]?.paints, [
      {
        type: "SOLID",
        visible: true,
        opacity: 0.9,
        blendMode: "NORMAL",
        color: { r: 0.7, g: 0.6, b: 0.5 },
      },
    ]) ||
      equal(paintReadback.styles[0]?.paints, [
        { type: "SOLID", color: { r: 0.7, g: 0.6, b: 0.5 }, opacity: 0.9 },
      ]),
    "Updated paint exact readback mismatch",
    paintReadback.styles[0],
  );

  await bridge.tokens({
    action: "apply",
    fileKey,
    operations: [{ op: "unbind", nodeIds: [nodeId], field: "fills" }],
  });
  const [unboundNode] = await bridge.getNodes([nodeId], fileKey);
  assert(
    !unboundNode?.fills?.[0]?.boundVariables?.color,
    "Unbind readback still has fills binding",
    unboundNode,
  );

  console.log(
    JSON.stringify(
      {
        passed: true,
        transport: "persistent-service-ipc",
        servicePid: health.pid,
        fileKey,
        fileName: connected.file.name,
        collection: {
          id: collectionId,
          modes: collection.modes,
          light,
          dark,
          aliasTarget: brandId,
          bindingVariable: accentId,
        },
        invalidAliasCycle: "INVALID_ARGUMENT/no-mutation",
        invalidAliasTypeMismatch: "INVALID_ARGUMENT/no-mutation",
        styles: styles.styles.map(({ id, kind, name, source }) => ({
          id,
          kind,
          name,
          source,
        })),
        cleanupPending: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  runError = error;
} finally {
  try {
    for (const styleId of [...styleIds].reverse()) {
      try {
        await bridge.styles({ action: "delete", fileKey, styleId });
      } catch (error) {
        if (error?.code !== "NODE_NOT_FOUND") cleanupError ??= error;
      }
    }
    styleIds.length = 0;
    if (collectionId) {
      await bridge.tokens({
        action: "collection_delete",
        fileKey,
        collectionId,
      });
      collectionId = undefined;
    }
    if (nodeId) {
      await bridge.deleteNodes({
        fileKey,
        nodeIds: [nodeId],
        idempotencyKey: `variables-styles-cleanup-${suffix}`,
      });
      nodeId = undefined;
    }
    if (fileKey) {
      const tokenInventory = await inspectTokens();
      assert(
        !tokenInventory.collections.some((collection) =>
          collection.name.startsWith(prefix),
        ),
        "Collection cleanup verification failed",
        tokenInventory.collections,
      );
      const styleInventory = await bridge.styles({
        action: "inspect",
        fileKey,
      });
      assert(
        !styleInventory.styles.some((style) => style.name.startsWith(prefix)),
        "Style cleanup verification failed",
        styleInventory.styles,
      );
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    await bridge.close();
  } catch (error) {
    cleanupError ??= error;
  }
}

if (cleanupError) {
  if (runError)
    throw new AggregateError(
      [runError, cleanupError],
      "Variables/styles live canary failed and cleanup did not complete.",
    );
  throw cleanupError;
}
if (runError) throw runError;
console.log(JSON.stringify({ cleanup: true, prefix }));
