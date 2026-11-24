import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SKILLS_ROOT = join(REPO_ROOT, "skills");

const EXPECTED_SKILLS = ["curved-agent", "curved-api", "curved-cli"];
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LINES = 500;
const FORBIDDEN_TEXT = [
  "curv3d.duckdns.org",
  "129.213.209.162",
  "158.101.127.247",
  "/srv/curved",
  "/home/",
  "C:\\",
];
const TOKEN_PATTERN = /\bcrv_[A-Za-z0-9_-]{8,}\b/;

interface Frontmatter {
  fields: Map<string, string>;
  body: string;
}

/**
 * Parses the small YAML subset the skills use: inline scalars and folded or
 * literal block scalars. It deliberately does not implement all of YAML.
 */
function parseFrontmatter(text: string): Frontmatter {
  assert.ok(text.startsWith("---\n"), "SKILL.md must start with ---");
  const close = text.indexOf("\n---\n", 4);
  assert.notEqual(close, -1, "SKILL.md frontmatter must close with ---");
  const header = text.slice(4, close);
  const body = text.slice(close + 5);
  const fields = new Map<string, string>();
  const lines = header.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    let value = match[2] ?? "";
    if (key === undefined) {
      continue;
    }
    if (value === ">-" || value === "|" || value === "") {
      const collected: string[] = [];
      while (
        index + 1 < lines.length &&
        (lines[index + 1] ?? "").startsWith("  ")
      ) {
        index += 1;
        collected.push((lines[index] ?? "").trim());
      }
      value = collected.join(" ").trim();
    }
    value = value.replace(/^["']|["']$/g, "");
    fields.set(key, value);
  }

  return { fields, body };
}

async function skillNames(): Promise<string[]> {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function markdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}

function linkTargets(text: string): string[] {
  const targets: string[] = [];
  const pattern = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    if (target !== undefined) {
      targets.push(target);
    }
  }
  return targets;
}

test("skills/ holds exactly the three installer-facing skills", async () => {
  assert.deepEqual(await skillNames(), EXPECTED_SKILLS);
});

test("every skill has valid spec frontmatter", async () => {
  const descriptions = new Set<string>();
  for (const name of await skillNames()) {
    const file = join(SKILLS_ROOT, name, "SKILL.md");
    const { fields, body } = parseFrontmatter(await readFile(file, "utf8"));

    assert.equal(fields.get("name"), name, `${file}: name must match the directory`);
    assert.match(name, NAME_PATTERN, `${name}: invalid skill name`);
    assert.ok(
      name.length <= MAX_NAME_LENGTH,
      `${name}: name exceeds ${MAX_NAME_LENGTH} characters`,
    );

    const description = fields.get("description") ?? "";
    assert.ok(description.length > 0, `${file}: description is required`);
    assert.ok(
      description.length <= MAX_DESCRIPTION_LENGTH,
      `${file}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
    );
    assert.ok(
      !descriptions.has(description),
      `${file}: description duplicates another skill`,
    );
    descriptions.add(description);

    assert.ok(body.trim().length > 0, `${file}: body is empty`);
    assert.ok(
      body.split("\n").length <= MAX_BODY_LINES,
      `${file}: body exceeds ${MAX_BODY_LINES} lines`,
    );
  }
});

test("skill files contain no deployment hosts, local paths, or tokens", async () => {
  for (const name of await skillNames()) {
    for (const file of await markdownFiles(join(SKILLS_ROOT, name))) {
      const text = await readFile(file, "utf8");
      for (const forbidden of FORBIDDEN_TEXT) {
        assert.ok(
          !text.includes(forbidden),
          `${file}: contains forbidden text "${forbidden}"`,
        );
      }
      assert.doesNotMatch(
        text,
        TOKEN_PATTERN,
        `${file}: contains a token-shaped string`,
      );
    }
  }
});

test("relative links in skill files resolve inside the skill", async () => {
  for (const name of await skillNames()) {
    const skillDir = join(SKILLS_ROOT, name);
    for (const file of await markdownFiles(skillDir)) {
      const text = (await readFile(file, "utf8")).replace(
        /```[\s\S]*?```/g,
        "",
      );
      for (const target of linkTargets(text)) {
        if (/^(?:https?:|mailto:|#|<)/i.test(target)) {
          continue;
        }
        const clean = (target.split("#")[0] ?? "").trim();
        if (clean.length === 0) {
          continue;
        }
        const resolved = resolve(dirname(file), clean);
        assert.ok(
          resolved === skillDir || resolved.startsWith(skillDir + sep),
          `${file}: link escapes the skill: ${target}`,
        );
        let exists = true;
        try {
          await stat(resolved);
        } catch {
          exists = false;
        }
        assert.ok(exists, `${file}: missing link target ${target}`);
      }
    }
  }
});

test("reference files are linked from SKILL.md", async () => {
  for (const name of await skillNames()) {
    const skillDir = join(SKILLS_ROOT, name);
    const references = join(skillDir, "references");
    let entries: string[];
    try {
      entries = await readdir(references);
    } catch {
      continue;
    }
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const relativePath = `references/${entry}`;
      assert.ok(
        skill.includes(relativePath),
        `${name}: SKILL.md does not link ${relativePath}`,
      );
    }
  }
});
