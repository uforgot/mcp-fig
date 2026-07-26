import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const FIELDS = [
  "timestamp",
  "level",
  "traceId",
  "requestId",
  "clientId",
  "daemonPid",
  "sessionId",
  "fileKey",
  "method",
  "action",
  "targetNodeIds",
  "revision",
  "errorCode",
  "latencyMs",
  "retryable",
];

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (
      !["--trace", "--error-code", "--log", "--output-dir", "--date"].includes(
        key,
      )
    ) {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${key} requires a value.`);
    parsed[key.slice(2)] = value;
    index += 1;
  }
  if (!parsed.trace && !parsed["error-code"]) {
    throw new Error("Pass --trace <id> or --error-code <code>.");
  }
  return parsed;
}

function cleanString(value, max = 512) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cleaned = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || character === "|" ? " " : character;
    })
    .join("");
  return cleaned.slice(0, max);
}

function redact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const event = {};
  for (const field of FIELDS) {
    const item = value[field];
    if (field === "daemonPid" || field === "latencyMs") {
      if (typeof item === "number" && Number.isFinite(item))
        event[field] = item;
    } else if (field === "retryable") {
      if (typeof item === "boolean") event[field] = item;
    } else if (field === "targetNodeIds") {
      if (Array.isArray(item)) {
        event[field] = item
          .slice(0, 100)
          .map((id) => cleanString(id, 256))
          .filter(Boolean);
      }
    } else {
      const cleaned = cleanString(item);
      if (cleaned) event[field] = cleaned;
    }
  }
  return event.traceId && event.action ? event : undefined;
}

async function readEvents(path) {
  const events = [];
  let malformed = 0;
  for (const candidate of [`${path}.3`, `${path}.2`, `${path}.1`, path]) {
    let text;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = redact(JSON.parse(line));
        if (event) events.push(event);
        else malformed += 1;
      } catch {
        malformed += 1;
      }
    }
  }
  return { events, malformed };
}

function safeSegment(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96) || "unknown";
}

function table(events) {
  const columns = [
    "timestamp",
    "traceId",
    "level",
    "action",
    "requestId",
    "clientId",
    "sessionId",
    "fileKey",
    "method",
    "targetNodeIds",
    "revision",
    "errorCode",
    "latencyMs",
    "retryable",
  ];
  const rows = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const event of events) {
    rows.push(
      `| ${columns
        .map((column) => {
          const value = event[column];
          return Array.isArray(value) ? value.join(", ") : String(value ?? "");
        })
        .join(" | ")} |`,
    );
  }
  return rows.join("\n");
}

export async function generateBugReport(options) {
  const logPath = resolve(
    options.log ??
      process.env.MCP_FIG_EVENT_LOG ??
      join(homedir(), "Library", "Logs", "mcp-fig", "events.jsonl"),
  );
  const { events, malformed } = await readEvents(logPath);
  const selected = events.filter(
    (event) =>
      (!options.trace || event.traceId === options.trace) &&
      (!options.errorCode || event.errorCode === options.errorCode),
  );
  if (selected.length === 0) {
    throw new Error(
      "No redacted events matched the requested trace/errorCode.",
    );
  }
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const identity = options.trace
    ? safeSegment(options.trace)
    : `error-${safeSegment(options.errorCode)}`;
  const outputDirectory = resolve(options.outputDir ?? "bugs");
  const output = join(outputDirectory, `${date}-${identity}.md`);
  await mkdir(outputDirectory, { recursive: true });
  const content =
    `# MCP Fig focused bug report: ${identity}\n\n` +
    `- Source: ${basename(logPath)} (including available rotations)\n` +
    `- Filter: ${options.trace ? `traceId=${options.trace}` : `errorCode=${options.errorCode}`}\n` +
    `- Matched events: ${selected.length}\n` +
    `- Malformed/skipped lines: ${malformed}\n\n` +
    `## Redacted event chain\n\n${table(selected)}\n\n` +
    `## Focused fix loop\n\n` +
    `1. **Capture** — preserve this redacted chain and the exact user-visible failure.\n` +
    `2. **Reproduce** — reproduce only the failing method/action with the same target and revision preconditions.\n` +
    `3. **Failing test** — add the smallest deterministic regression test and observe the intended RED failure.\n` +
    `4. **Minimal fix** — patch the narrow owner; do not retry or mark unknown writes successful.\n` +
    `5. **Focused test** — rerun the failing test plus adjacent correlation/redaction tests.\n` +
    `6. **Relevant live canary** — run only the canary matching the touched boundary and record real output.\n\n` +
    `This report does not modify source, commit, or push automatically.\n`;
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, output);
  return output;
}

const direct =
  resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname);
if (direct) {
  try {
    const parsed = args(process.argv.slice(2));
    const output = await generateBugReport({
      trace: parsed.trace,
      errorCode: parsed["error-code"],
      log: parsed.log,
      outputDir: parsed["output-dir"],
      date: parsed.date,
    });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
