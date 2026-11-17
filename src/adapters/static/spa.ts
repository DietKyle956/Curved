import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const INDEX_FILE = "index.html";
const BUILD_INSTRUCTION =
  "The web UI is not built: web/dist/index.html is missing. " +
  "Run `npm run build` to build the web UI into web/dist.";

function contentTypeFor(relativePath: string): string {
  return MIME_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream";
}

function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

/**
 * Turns a URL pathname into a safe relative path under the dist root, or
 * `null` when the path tries to escape it.
 */
function safeRelativePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return null;
  }
  const segments = decoded.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return null;
    }
  }
  return segments.join("/");
}

/**
 * Serves the built SPA from `webDistDir`: the requested file when it exists,
 * otherwise `index.html` so client-side routes work on reload. Paths that
 * escape the root and a missing build are rejected explicitly.
 */
export async function serveSpa(request: Request, webDistDir: string): Promise<Response> {
  const url = new URL(request.url);
  const relativePath = safeRelativePath(url.pathname);
  if (relativePath === null) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const root = resolve(webDistDir);
  let servedPath = relativePath;
  let content: Buffer;
  try {
    const candidate = resolve(root, relativePath);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error("path escapes the web root");
    }
    content = await readFile(candidate);
  } catch {
    servedPath = INDEX_FILE;
    try {
      content = await readFile(resolve(root, INDEX_FILE));
    } catch {
      return new Response(`${BUILD_INSTRUCTION}\n`, {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
  }

  const headers = new Headers({
    "content-type": contentTypeFor(servedPath),
    "cache-control": cacheControlFor(servedPath),
    "content-length": String(content.byteLength),
  });
  const isHead = request.method === "HEAD";
  return new Response(isHead ? null : new Uint8Array(content), { status: 200, headers });
}
