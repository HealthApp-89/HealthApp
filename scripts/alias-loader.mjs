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

const ROOT = ${JSON.stringify(repoRoot)};

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const candidates = [
      resolvePath(ROOT, rel + ".ts"),
      resolvePath(ROOT, rel),
      resolvePath(ROOT, rel + "/index.ts"),
    ];
    // Return the first candidate — Node will throw if the file doesn't exist
    return { url: pathToFileURL(candidates[0]).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

register(
  "data:text/javascript," + encodeURIComponent(loaderSource),
  import.meta.url,
);
