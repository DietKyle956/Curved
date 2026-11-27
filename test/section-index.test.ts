// Guards the section indexes at the top of the hot large files. A stale index
// costs more than none, so every entry must resolve against the source it
// describes: ranges stay ordered, each named symbol is still declared inside
// its range, and each phase/line anchor still lands on the line it claims.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
const INDEX_LINE_LIMIT = 20;

const TARGETS = [
  "web/src/application/workspace.ts",
  "scripts/acceptance-browser.mjs",
  "src/adapters/http/app.ts",
  "web/src/ui/IssueDetail.tsx",
];

// "// label | symbol, symbol | L10-20"
const ENTRY = /^\/\/ ([^|]+?) \| (.+?) \| L(\d+)-(\d+)$/;
// phase:"some phase"@123 or line:"some text"@123
const ANCHOR = /^(phase|line):"(.+)"@(\d+)$/;
const SYMBOL = /^[A-Za-z_$][\w$]*$/;

type Entry = {
  line: number;
  label: string;
  tokens: string[];
  start: number;
  end: number;
};

function parseIndex(source: string, target: string): Entry[] {
  const entries: Entry[] = [];
  source.split("\n").forEach((text, index) => {
    const match = ENTRY.exec(text);
    if (match === null) {
      return;
    }
    const [, label = "", symbols = "", start = "0", end = "0"] = match;
    entries.push({
      line: index + 1,
      label: label.trim(),
      tokens: symbols
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
      start: Number(start),
      end: Number(end),
    });
  });
  assert.ok(
    entries.length >= 3,
    `${target}: expected at least 3 section index entries, found ${entries.length}`,
  );
  return entries;
}

for (const target of TARGETS) {
  test(`section index resolves in ${target}`, async () => {
    const source = await readFile(join(REPO_ROOT, target), "utf8");
    const lines = source.split("\n");
    const entries = parseIndex(source, target);
    let previousEnd = 0;

    for (const entry of entries) {
      const where = `${target}:${entry.line} "${entry.label}"`;
      assert.ok(
        entry.line <= INDEX_LINE_LIMIT,
        `${where} sits past the first ${INDEX_LINE_LIMIT} lines`,
      );
      assert.ok(
        entry.start > previousEnd,
        `${where} starts at L${entry.start}, before the previous range ends at L${previousEnd}`,
      );
      assert.ok(
        entry.start <= entry.end && entry.end <= lines.length,
        `${where} has an invalid range L${entry.start}-${entry.end}`,
      );

      for (const token of entry.tokens) {
        const anchor = ANCHOR.exec(token);
        if (anchor !== null) {
          const [, kind = "", text = "", anchorText = "0"] = anchor;
          const anchorLine = Number(anchorText);
          assert.ok(
            anchorLine >= entry.start && anchorLine <= entry.end,
            `${where} anchors ${token} outside its own range`,
          );
          const expected = kind === "phase" ? `state.phase = "${text}"` : text;
          assert.ok(
            (lines[anchorLine - 1] ?? "").includes(expected),
            `${where} anchors ${token}, but line ${anchorLine} does not contain ${JSON.stringify(expected)}`,
          );
          continue;
        }

        assert.match(token, SYMBOL, `${where} has a malformed entry ${token}`);
        const declaration = new RegExp(
          `\\b(?:const|let|var|function|class|interface|type|enum)\\b[^\\n]*\\b${token}\\b`,
        );
        const declared = lines
          .slice(entry.start - 1, entry.end)
          .some((line) => declaration.test(line));
        assert.ok(
          declared,
          `${where} names ${token}, but no declaration is inside L${entry.start}-${entry.end}`,
        );
      }

      previousEnd = entry.end;
    }
  });
}
