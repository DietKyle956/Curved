#!/usr/bin/env node
// Import-direction check for the curved architecture contract (ARCH.md section 9).
// Plain Node ESM, no dependencies: one rule table, one resolver, one walker.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", "test"]);
const SERVER_EXTENSIONS = [".ts"];
const WEB_EXTENSIONS = [".ts", ".tsx"];

// A static import/export (`from "x"`), a side-effect import (`import "x"`),
// a dynamic import, and a CommonJS require.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const ADAPTERS_PREFIX = "src/adapters/";
const SANCTIONED_ADAPTER_PEERS = {
  http: new Set(["github", "sse", "static"]),
};

function under(target, prefix) {
  return target.startsWith(prefix);
}

function isPackage(target, name) {
  return target === name || target.startsWith(`${name}/`);
}

function isNodeBuiltin(target) {
  return target.startsWith("node:");
}

// The first directory under src/adapters/, or null for a shared root-level file.
function adapterPeer(target) {
  if (!target.startsWith(ADAPTERS_PREFIX)) return null;
  const rest = target.slice(ADAPTERS_PREFIX.length).split("/");
  return rest.length > 1 ? rest[0] : null;
}

const RULES = [
  {
    name: "domain-boundary",
    applies: (file) => under(file, "src/domain/"),
    forbids: (file, target) =>
      under(target, "src/application/") ||
      under(target, "src/adapters/") ||
      under(target, "src/composition/") ||
      isPackage(target, "pg") ||
      isNodeBuiltin(target) ||
      isPackage(target, "react") ||
      isPackage(target, "react-dom"),
  },
  {
    name: "application-boundary",
    applies: (file) => under(file, "src/application/"),
    forbids: (file, target) =>
      under(target, "src/adapters/") ||
      under(target, "src/composition/") ||
      isPackage(target, "pg") ||
      isNodeBuiltin(target) ||
      isPackage(target, "react") ||
      isPackage(target, "react-dom"),
  },
  {
    name: "adapter-boundary",
    applies: (file) => under(file, ADAPTERS_PREFIX),
    forbids: (file, target) => {
      if (under(target, "src/composition/")) return true;
      const from = adapterPeer(file);
      const to = adapterPeer(target);
      if (from === null || to === null || from === to) return false;
      return !SANCTIONED_ADAPTER_PEERS[from]?.has(to);
    },
  },
  {
    name: "pg-import",
    applies: (file) =>
      under(file, "src/") && !under(file, "src/adapters/postgres/"),
    forbids: (file, target) => isPackage(target, "pg"),
  },
  {
    name: "web-backend-import",
    applies: (file) => under(file, "web/src/"),
    forbids: (file, target) =>
      under(target, "src/") && target !== "src/domain/status.ts",
  },
  {
    name: "web-domain-layer",
    applies: (file) => under(file, "web/src/domain/"),
    forbids: (file, target) =>
      isPackage(target, "react") ||
      isPackage(target, "react-dom") ||
      under(target, "web/src/adapters/") ||
      under(target, "web/src/application/") ||
      under(target, "web/src/ui/"),
  },
  {
    name: "web-application-layer",
    applies: (file) => under(file, "web/src/application/"),
    forbids: (file, target) =>
      under(target, "web/src/adapters/") || under(target, "web/src/ui/"),
  },
  {
    name: "web-ui-layer",
    applies: (file) => under(file, "web/src/ui/"),
    forbids: (file, target) => under(target, "web/src/adapters/"),
  },
  {
    name: "web-adapter-layer",
    applies: (file) => under(file, "web/src/adapters/"),
    forbids: (file, target) => under(target, "web/src/ui/"),
  },
];

function parseArgs(argv) {
  let root = resolve(SCRIPT_DIR, "..");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "missing value for --root" };
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }
  return { root };
}

function walk(directory, extensions) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(full, extensions));
      continue;
    }
    if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function extractSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

function toPosix(path) {
  return path.split(sep).join("/");
}

// Relative specifiers become posix paths relative to the root; bare
// specifiers stay package names. Anything that escapes the root is ignored.
function resolveTarget(root, file, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  const absolute = resolve(dirname(file), specifier);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return toPosix(rel);
}

function main(argv) {
  const { root, error } = parseArgs(argv);
  if (error !== undefined) {
    console.error("usage: node scripts/check-architecture.mjs [--root <dir>]");
    console.error(error);
    process.exitCode = 2;
    return;
  }

  const files = [
    ...walk(join(root, "src"), SERVER_EXTENSIONS),
    ...walk(join(root, "web", "src"), WEB_EXTENSIONS),
  ];
  const violations = [];

  for (const file of files) {
    const path = toPosix(relative(root, file));
    const source = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(source)) {
      const target = resolveTarget(root, file, specifier);
      if (target === null) continue;
      for (const rule of RULES) {
        if (!rule.applies(path)) continue;
        if (rule.forbids(path, target)) {
          violations.push(
            `${path}: forbidden import "${specifier}" (${rule.name})`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`architecture: ok (${files.length} files)`);
}

main(process.argv.slice(2));
