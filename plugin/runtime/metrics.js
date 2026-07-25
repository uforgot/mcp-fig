// biome-ignore lint/correctness/noUnusedVariables: Used by the deterministic plugin assembly.
function createPluginMetrics() {
  let activeCommandMetrics = null;

  function start() {
    activeCommandMetrics = { sceneTraversalNodeCount: 0 };
  }

  function countSceneTraversal(count = 1) {
    if (activeCommandMetrics) {
      activeCommandMetrics.sceneTraversalNodeCount += count;
    }
  }

  function sceneTraversalNodeCount() {
    return activeCommandMetrics?.sceneTraversalNodeCount ?? 0;
  }

  function finish() {
    activeCommandMetrics = null;
  }

  return { start, countSceneTraversal, sceneTraversalNodeCount, finish };
}
