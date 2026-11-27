#!/usr/bin/env node
// Documentation gate for curved: relative links, #anchors, and backticked
// repository paths across README.md, AGENTS.md, and docs/*.md.
//
// Rules:
// - A relative link target must exist (file or directory). External URLs,
//   mailto:, and site-absolute paths are not repo paths and are skipped.
// - A same-file or cross-file #anchor must match a heading slug or an explicit
//   <a name="..."> / id="..." anchor, using GitHub slug rules (lowercase,
//   punctuation stripped, spaces to hyphens, duplicate headings suffixed -1,
//   -2, ...).
// - A backticked token that looks like a repo path must exist. Tokens with a
//   known top-level prefix (src/, scripts/, docs/, test/, deploy/, web/,
//   skills/, migrations/, .github/, .githooks/) are checked from the repo
//   root. Bare filenames are checked only at the root, or anywhere by
//   basename; a bare name that resolves nowhere is prose (a component or
//   symbol), not a path. Placeholders, globs, URLs, commands, build output,
//   and env files are skipped.
// - Numeric gate counts (test/check counts) outside MEMORY.md are warnings.
//   They rot faster than the prose around them; the check does not fail.
//
// Plain Node ESM, no dependencies. Exit 1 on any error, 0 otherwise.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALK_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".codegraph",
  "graphify-out",
]);
const BUILD_OUTPUT_SEGMENTS = new Set(["dist", "build", "coverage", "node_modules"]);
const TOP_LEVEL_PREFIXES = new Set([
  "src",
  "scripts",
  "docs",
  "test",
  "deploy",
  "web",
  "skills",
  "migrations",
  ".github",
  ".githooks",
]);
const REPO_FILE_EXTENSION =
  /\.(?:md|markdown|ts|tsx|mjs|cjs|js|jsx|json|sh|bash|css|html|sql|ya?ml|toml|conf|txt)$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE_START = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const EXPLICIT_ANCHOR = /<a\s[^>]*\b(?:name|id)\s*=\s*["']([^"']+)["']/gi;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\(([^)\n]+)\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const GATE_COUNT =
  /\b\d[\d,]*\s+(?:tests?|checks?)\b|\b\d[\d,]*\s+(?:behavior|architecture)\b|architecture:\s*ok\s*\(\d+\s+files?\)/gi;

function walk(dir, accept) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    if (WALK_SKIP.has(entry.name)) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, accept));
    } else if (entry.isFile() && accept(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

function toPosix(path) {
  return path.split("\\").join("/");
}

function repoPath(abs) {
  return toPosix(relative(ROOT, abs));
}

function listCheckedDocs() {
  const files = [join(ROOT, "README.md"), join(ROOT, "AGENTS.md")];
  for (const name of readdirSync(join(ROOT, "docs")).sort()) {
    if (name.endsWith(".md")) {
      files.push(join(ROOT, "docs", name));
    }
  }
  return files;
}

function parseFile(abs) {
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const inFence = new Array(lines.length).fill(false);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      inFence[index] = true;
      const close = line.match(FENCE_START);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const open = line.match(FENCE_START);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      inFence[index] = true;
    }
  }

  const anchors = new Set();
  const seenHeadings = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inFence[index]) {
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const base = slugify(heading[2]);
      if (base) {
        let slug = base;
        let suffix = 1;
        while (seenHeadings.has(slug)) {
          slug = `${base}-${suffix}`;
          suffix += 1;
        }
        seenHeadings.add(slug);
        anchors.add(slug);
      }
    }
    for (const match of line.matchAll(EXPLICIT_ANCHOR)) {
      anchors.add(match[1]);
    }
  }

  return { abs, lines, inFence, anchors };
}

// GitHub heading slugs: lowercase, punctuation removed, spaces to hyphens.
// Markdown markup inside the heading is reduced to its visible text first.
function slugify(text) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function inlineCodeRanges(line) {
  const ranges = [];
  for (const match of line.matchAll(INLINE_CODE)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function insideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function checkDestination(doc, dest) {
  if (!dest || SCHEME.test(dest) || dest.startsWith("//")) {
    return null;
  }
  if (dest.startsWith("/")) {
    return null;
  }

  const hashIndex = dest.indexOf("#");
  const pathPart = hashIndex === -1 ? dest : dest.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? null : decode(dest.slice(hashIndex + 1));
  const cleanPath = decode(pathPart.split("?")[0]);
  const target = cleanPath === "" ? doc.abs : resolve(dirname(doc.abs), cleanPath);

  if (cleanPath !== "" && !existsSync(target)) {
    return {
      kind: "error",
      message: `link target "${pathPart}" does not exist (resolved to ${repoPath(target)})`,
    };
  }
  if (anchor === null || anchor === "" || !existsSync(target)) {
    return { kind: "link" };
  }
  if (!statSync(target).isFile() || !/\.(?:md|markdown)$/i.test(target)) {
    return { kind: "link" };
  }
  const anchorDoc = target === doc.abs ? doc : getDoc(target);
  if (!anchorDoc.anchors.has(anchor)) {
    return {
      kind: "error",
      message: `anchor "#${anchor}" does not exist in ${repoPath(target)}`,
    };
  }
  return { kind: "anchor" };
}

function checkBacktickedPath(token) {
  if (!token || /\s/.test(token)) {
    return null;
  }
  if (/[<>{}%$*?'"`|,;=&]/.test(token)) {
    return null;
  }
  if (token.includes("://") || token.startsWith("//") || SCHEME.test(token)) {
    return null;
  }
  if (token.startsWith("#") || token.startsWith("-") || token.includes("@")) {
    return null;
  }

  let candidate = token.startsWith("./") ? token.slice(2) : token;
  if (!candidate || candidate === "." || candidate === "..") {
    return null;
  }
  if (candidate.startsWith("/")) {
    return null;
  }

  const parts = candidate.replace(/\/+$/, "").split("/");
  if (parts.some((part) => part.startsWith(".env") || BUILD_OUTPUT_SEGMENTS.has(part))) {
    return null;
  }

  if (parts.length > 1) {
    if (!TOP_LEVEL_PREFIXES.has(parts[0])) {
      return null;
    }
    const target = join(ROOT, ...parts);
    return existsSync(target)
      ? { kind: "path" }
      : {
          kind: "error",
          message: `repo path "${token}" does not exist (resolved to ${repoPath(target)})`,
        };
  }

  if (!REPO_FILE_EXTENSION.test(candidate)) {
    return null;
  }
  if (existsSync(join(ROOT, candidate))) {
    return { kind: "path" };
  }
  // A bare filename without a directory may name a symbol or component in
  // prose; only fail it when nothing in the tree carries that basename.
  return knownBasenames.has(candidate)
    ? { kind: "path" }
    : null;
}

const docCache = new Map();
function getDoc(abs) {
  if (!docCache.has(abs)) {
    docCache.set(abs, parseFile(abs));
  }
  return docCache.get(abs);
}

const checkedDocs = listCheckedDocs();
const knownBasenames = new Set(
  walk(ROOT, () => true).map((abs) => abs.slice(abs.lastIndexOf("/") + 1)),
);

const errors = [];
const warnings = [];
const counts = { files: 0, links: 0, anchors: 0, paths: 0 };

for (const abs of checkedDocs) {
  if (!existsSync(abs)) {
    errors.push({ file: repoPath(abs), line: 1, message: "documentation file is missing" });
    continue;
  }
  const doc = getDoc(abs);
  const file = repoPath(abs);
  counts.files += 1;

  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.inFence[index]) {
      continue;
    }
    const line = doc.lines[index];
    const codeRanges = inlineCodeRanges(line);

    for (const match of line.matchAll(MARKDOWN_LINK)) {
      if (insideRanges(match.index, codeRanges)) {
        continue;
      }
      let dest = match[2].trim();
      if (dest.startsWith("<") && dest.includes(">")) {
        dest = dest.slice(1, dest.indexOf(">"));
      } else {
        dest = dest.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "");
      }
      const result = checkDestination(doc, dest);
      if (!result) {
        continue;
      }
      if (result.kind === "error") {
        errors.push({ file, line: index + 1, message: result.message });
      } else if (result.kind === "link") {
        counts.links += 1;
      } else if (result.kind === "anchor") {
        counts.anchors += 1;
      }
    }

    for (const match of line.matchAll(INLINE_CODE)) {
      const result = checkBacktickedPath(match[1].trim());
      if (!result) {
        continue;
      }
      if (result.kind === "error") {
        errors.push({ file, line: index + 1, message: result.message });
      } else {
        counts.paths += 1;
      }
    }
  }
}

// Numeric gate counts rot; warn wherever they appear outside MEMORY.md.
for (const abs of walk(ROOT, (name) => name.endsWith(".md"))) {
  if (abs.slice(abs.lastIndexOf("/") + 1) === "MEMORY.md") {
    continue;
  }
  const doc = getDoc(abs);
  const file = repoPath(abs);
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.inFence[index]) {
      continue;
    }
    for (const match of doc.lines[index].matchAll(GATE_COUNT)) {
      // A number bound to a flag or assignment is command text, not a count.
      const before = doc.lines[index][match.index - 1];
      if (before === "=" || before === "-" || before === "/") {
        continue;
      }
      warnings.push({ file, line: index + 1, text: match[0] });
    }
  }
}

for (const warning of warnings) {
  console.log(`warning: ${warning.file}:${warning.line}: numeric gate count "${warning.text}" outside MEMORY.md`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`${error.file}:${error.line}: ${error.message}`);
  }
  console.error(`\ncheck-docs: ${errors.length} problem(s) across ${counts.files} documentation file(s)`);
  process.exit(1);
}

console.log(
  `docs: ok (${counts.files} files, ${counts.links} links, ${counts.anchors} anchors, ${counts.paths} paths, ${warnings.length} warning(s))`,
);
