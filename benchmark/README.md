# Live Figma Desktop benchmark

Measured on 2026-07-25 against a real Figma Desktop file (`Untitled`).

## Setup

- MCP Fig: local repository build, Desktop Plugin bridge, 8 runtime tools
- Legacy: `figma-console-mcp@1.37.1`, Figma Desktop Bridge, 113 runtime tools
- Node.js: 25.9.0
- Startup samples: 5
- Operation samples: 20 after 3 warm-up iterations
- Fixture operations: selection read, node read, document summary, node rename, Auto Layout write + validation, component description write, variable read, and instance create
- REST was excluded from operation timing. Legacy document summary uses `figma_execute` against the active document because `figma_get_file_data` uses the REST API and hit rate limiting during the first live run.
- Only the benchmark file's legacy Bridge instance was left open. Legacy routes commands to the most recently connected Figma file when multiple Bridge instances are active.

Raw results:

- [`raw/live-paired-fixture.json`](raw/live-paired-fixture.json)
- [`raw/mcp-fig-paired.json`](raw/mcp-fig-paired.json)
- [`raw/legacy-paired.json`](raw/legacy-paired.json)
- [`raw/mcp-fig-after.json`](raw/mcp-fig-after.json)
- [`raw/legacy-after.json`](raw/legacy-after.json)

The `*-paired.json` runs used one preserved fixture in the same Figma file: page `0:1`, frame `20:2`, node `20:3`, and component `20:4`. Both raw files embed the complete fixture identity in `metadata.fixture`, and both `node_read` payloads confirm node `20:3` (`Benchmark Node B`).

## Acceptance limitation

The paired node read, node write, Auto Layout, component, token, and instance cases ran against the same preserved fixture. Selection is not a strict same-selection comparison: MCP Fig observed the selection that existed before its run, while restarting Figma to switch development plugins cleared the legacy selection. Document summary operates on the same file and page, but the facades intentionally return different summary shapes.

MCP Fig was faster in **0 of 8 operation p50 cases** in the paired run, so the “lower p50 in a majority of cases” product criterion is not met. The legacy MCP must remain installed. The older `*-after.json` files remain historical workload-level diagnostics and use different fixture IDs (`7:17`/`7:18` versus `7:43`/`7:44`).

## Startup and surface

| Metric | MCP Fig | Legacy | MCP Fig / Legacy |
| --- | ---: | ---: | ---: |
| Initialize p50 | 141.6 ms | 522.0 ms | 0.27× |
| Initialize p95 | 151.2 ms | 1117.7 ms | 0.14× |
| List tools p50 | 3.1 ms | 7.2 ms | 0.44× |
| Handshake ready p50 | 400.7 ms | 1035.9 ms | 0.39× |
| Handshake ready p95 | 409.0 ms | 1635.6 ms | 0.25× |
| Runtime tools | 8 | 113 | 7.1% |
| Tool schema | 16,864 bytes | 145,709 bytes | 11.6% |

The compact facade reduced initialize p50 by 72.9%, handshake-ready p50 by 61.3%, tool count by 92.9%, and schema bytes by 88.4% in the paired run.

## Live operation latency

Values are `p50 / p95` in milliseconds.

| Case | MCP Fig | Legacy |
| --- | ---: | ---: |
| Selection (non-strict) | 5.11 / 41.69 | 0.16 / 0.40 |
| Node read | 2.20 / 40.21 | 1.05 / 83.71 |
| Document summary | 3.24 / 23.97 | 1.03 / 4.19 |
| Single write | 2.48 / 27.26 | 1.01 / 2.44 |
| Layout batch + validate | 6.93 / 32.37 | 2.30 / 94.23 |
| Component write | 3.49 / 23.86 | 1.38 / 23.88 |
| Tokens read | 1.65 / 37.67 | 0.31 / 1.35 |
| Instance write | 4.44 / 27.39 | 2.34 / 64.00 |

## Conclusion

MCP Fig's confirmed performance advantage is the smaller MCP surface and faster median startup/handshake. Steady-state operations remain in the low-millisecond range for both implementations. MCP Fig is not universally faster: selection, layout, token, and instance paths have higher tails and should be profiled after reconnect and multi-agent isolation are complete.

The legacy MCP must remain installed until reconnect/session recovery, multi-agent routing, and fresh-session validation pass.

The cold-start harness waits for each previous stdio client to close before relaunching, without a fixed sleep. Stdio shutdown also closes the localhost bridge host. `smoke:plugin` directly spawns `dist/index.js`, closes stdin, and asserts exit code 0 with no signal before checking that the port can be rebound; SDK kill fallback cannot satisfy this check.
