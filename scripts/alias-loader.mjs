// scripts/alias-loader.mjs
//
// Node ESM loader hook: maps the "@/" path alias (defined in tsconfig.json)
// to the repo root so scripts using --experimental-strip-types can import
// lib/*.ts files that themselves use "@/" imports.
//
// Usage (prepend to any node invocation that needs it):
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types ...

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const loaderSource = `
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const ROOT = ${JSON.stringify(repoRoot)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const candidates = [
      resolvePath(ROOT, rel + ".ts"),
      resolvePath(ROOT, rel + "/index.ts"),
      resolvePath(ROOT, rel),
    ];
    // Pick the first candidate that exists on disk. Falls back to the first
    // candidate (Node will throw with a clear error) if none exist.
    const chosen = candidates.find(existsSync) ?? candidates[0];
    return { url: pathToFileURL(chosen).href, shortCircuit: true };
  }

  // Resolve extensionless relative imports (e.g. "./withings") to .ts files
  // so that lib/*.ts files imported by scripts work when they use bare relative
  // specifiers without explicit .ts extensions.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.match(/\\.[a-z]+$/i)) {
    const parentUrl = context.parentURL ?? pathToFileURL(ROOT + "/x").href;
    // Decode URL-encoded characters (e.g. %20 for spaces) before resolving the path
    const parentPath = decodeURIComponent(new URL(parentUrl).pathname);
    const parentDir = parentPath.replace(/\\/[^\\/]*$/, "");
    const candidates = [
      resolvePath(parentDir, specifier + ".ts"),
      resolvePath(parentDir, specifier + "/index.ts"),
    ];
    const chosen = candidates.find(existsSync) ?? candidates[0];
    return { url: pathToFileURL(chosen).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
`;

register(
  "data:text/javascript," + encodeURIComponent(loaderSource),
  import.meta.url,
);
