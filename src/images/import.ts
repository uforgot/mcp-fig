import { lookup } from "node:dns/promises";
import { realpath, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

import { McpFigError } from "../errors.js";

export const MAX_IMAGE_IMPORT_BYTES = 650_000;
export type ImportImageMime = "image/png" | "image/jpeg" | "image/gif";
export type ImageSource =
  | { type: "local"; path: string }
  | { type: "url"; url: string };

function invalid(message: string): never {
  throw new McpFigError("INVALID_ARGUMENT", message);
}

export function sniffImageMime(bytes: Uint8Array): ImportImageMime {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  return invalid("Image must have a valid PNG, JPEG, or GIF signature.");
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:"))
    return privateAddress(normalized.slice(7));
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  );
}

async function validateRemote(
  url: URL,
): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== "https:") invalid("Image URL must use HTTPS.");
  if (url.username || url.password)
    invalid("Image URL credentials are not allowed.");
  if (url.port && url.port !== "443")
    invalid("Image URL must use the default HTTPS port.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
    invalid("Local image hosts are not allowed.");
  const addresses = await lookup(url.hostname, {
    all: true,
    verbatim: true,
  }).catch(() => invalid("Image URL hostname could not be resolved."));
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => privateAddress(address))
  )
    invalid("Image URL resolves to a private or reserved address.");
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6))
    return invalid("Image URL address family is unsupported.");
  return { address: selected.address, family: selected.family };
}

function pinnedRequest(
  url: URL,
  target: { address: string; family: 4 | 6 },
): Promise<{ status: number; location?: string; bytes?: Uint8Array }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      url,
      {
        headers: {
          accept: "image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
          "user-agent": "mcp-fig/0.0.0 image-import",
        },
        lookup: ((
          _hostname,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        }) as LookupFunction,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.resume();
          resolveRequest({ status, ...(location ? { location } : {}) });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          resolveRequest({ status });
          return;
        }
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > MAX_IMAGE_IMPORT_BYTES) {
          response.destroy();
          rejectRequest(
            new McpFigError(
              "INVALID_ARGUMENT",
              `Image payload exceeds ${MAX_IMAGE_IMPORT_BYTES} bytes.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_IMAGE_IMPORT_BYTES) {
            response.destroy(
              new McpFigError(
                "INVALID_ARGUMENT",
                `Image payload exceeds ${MAX_IMAGE_IMPORT_BYTES} bytes.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolveRequest({ status, bytes: Buffer.concat(chunks, total) }),
        );
        response.on("error", rejectRequest);
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("timeout")));
    request.on("error", rejectRequest);
    request.end();
  });
}

async function fromUrl(initial: string): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(initial);
  } catch {
    return invalid("Image URL is malformed.");
  }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const target = await validateRemote(url);
    const response = await pinnedRequest(url, target).catch(
      (error: unknown) => {
        if (error instanceof McpFigError) throw error;
        const reason = error instanceof Error ? error.message : "unknown error";
        return invalid(`Image URL request failed: ${reason}`);
      },
    );
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirects === 3)
        invalid("Image URL redirect limit exceeded.");
      url = new URL(response.location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      invalid(`Image URL returned HTTP ${response.status}.`);
    if (!response.bytes) invalid("Image URL returned no body.");
    return response.bytes;
  }
  return invalid("Image URL redirect limit exceeded.");
}

async function fromLocal(path: string): Promise<Uint8Array> {
  if (path.length > 4096) invalid("Image path is too long.");
  const ownerRoot = await realpath(homedir());
  const target = await realpath(resolve(path)).catch(() =>
    invalid("Image file was not found."),
  );
  const rel = relative(ownerRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    invalid("Local image path must resolve inside the owner home directory.");
  const info = await stat(target);
  if (!info.isFile()) invalid("Local image source must be a regular file.");
  if (info.size > MAX_IMAGE_IMPORT_BYTES)
    invalid(`Image payload exceeds ${MAX_IMAGE_IMPORT_BYTES} bytes.`);
  const { readFile } = await import("node:fs/promises");
  return readFile(target);
}

export async function readImageSource(
  source: ImageSource,
): Promise<{ bytes: Uint8Array; mimeType: ImportImageMime }> {
  const bytes =
    source.type === "local"
      ? await fromLocal(source.path)
      : await fromUrl(source.url);
  if (bytes.byteLength < 6) invalid("Image payload is too small.");
  return { bytes, mimeType: sniffImageMime(bytes) };
}
