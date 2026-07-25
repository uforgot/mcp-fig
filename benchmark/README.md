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

- [`raw/mcp-fig-after.json`](raw/mcp-fig-after.json)
- [`raw/legacy-after.json`](raw/legacy-after.json)

## Acceptance limitation

The two runs used the same Mac, Figma Desktop file, node types, and operations, but the raw fixture IDs differ (`7:17`/`7:18` versus `7:43`/`7:44`). The operation table is therefore a workload-level diagnostic, not proof of the stricter same-node requirement. A fresh paired run against one preserved fixture is still required for that criterion.

MCP Fig was faster in **0 of 8 operation p50 cases** in this run, so the “lower p50 in a majority of cases” product criterion is not met. The legacy MCP must remain installed.

## Startup and surface

| Metric | MCP Fig | Legacy | MCP Fig / Legacy |
| --- | ---: | ---: | ---: |
| Initialize p50 | 151.7 ms | 533.8 ms | 0.28× |
| Initialize p95 | 161.8 ms | 775.6 ms | 0.21× |
| List tools p50 | 3.1 ms | 6.1 ms | 0.51× |
| Handshake ready p50 | 420.0 ms | 1039.7 ms | 0.40× |
| Handshake ready p95 | 3180.4 ms | 1811.0 ms | 1.76× |
| Runtime tools | 8 | 113 | 7.1% |
| Tool schema | 16,864 bytes | 145,709 bytes | 11.6% |

The compact facade reduced initialize p50 by 71.6%, handshake-ready p50 by 59.6%, tool count by 92.9%, and schema bytes by 88.4%. MCP Fig handshake p95 remains less stable and needs reconnect/session work.

## Live operation latency

Values are `p50 / p95` in milliseconds.

| Case | MCP Fig | Legacy |
| --- | ---: | ---: |
| Selection | 2.75 / 17.71 | 0.73 / 0.99 |
| Node read | 3.50 / 26.27 | 3.29 / 34.76 |
| Document summary | 2.97 / 19.58 | 2.42 / 28.24 |
| Single write | 3.23 / 5.25 | 1.85 / 9.85 |
| Layout batch + validate | 7.74 / 29.11 | 3.82 / 25.17 |
| Component write | 4.80 / 17.53 | 2.59 / 26.51 |
| Tokens read | 2.63 / 24.30 | 1.18 / 16.00 |
| Instance write | 6.09 / 40.58 | 3.63 / 30.39 |

## Conclusion

MCP Fig's confirmed performance advantage is the smaller MCP surface and faster median startup/handshake. Steady-state operations remain in the low-millisecond range for both implementations. MCP Fig is not universally faster: selection, layout, token, and instance paths have higher tails and should be profiled after reconnect and multi-agent isolation are complete.

The legacy MCP must remain installed until reconnect/session recovery, multi-agent routing, and fresh-session validation pass.

The cold-start harness waits for each previous stdio client to close before relaunching, without a fixed sleep. Stdio shutdown also closes the localhost bridge host. `smoke:plugin` directly spawns `dist/index.js`, closes stdin, and asserts exit code 0 with no signal before checking that the port can be rebound; SDK kill fallback cannot satisfy this check.
