import fs from "node:fs";
import path from "node:path";
import { normalizeTag, type KnownLocation } from "./projectTag.js";

// Directories that are never a project in their own right and can be huge;
// a stray .git inside one (a vendored or installed dependency) isn't
// something you'd want JARVIS launching sessions into.
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  ".cache",
]);

// Every git repo at or under `root`, at any depth — including repos nested
// inside other repos (monorepo packages or submodules with their own .git).
// `.git` counts whether it's a directory or a file (submodules and worktrees
// use a file). Symlinked directories are never followed, so a link pointing
// back up the tree can't loop the walk.
export function discoverRepos(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) found.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return found.sort();
}

function sanitizeName(name: string): string | undefined {
  const cleaned = name
    .replace(/^@[^/]+\//, "") // "@acme/payments-api" → "payments-api"
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

// Best-effort project name from the repo's own manifest. Parsed with plain
// regexes for the TOML formats rather than pulling in a parser, since only
// the one `name = "..."` line under a known table matters.
export function readManifestName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (typeof pkg.name === "string") {
      const name = sanitizeName(pkg.name);
      if (name) return name;
    }
  } catch {
    // no package.json, or not valid JSON
  }
  const tomlName = (file: string, tables: string[]) => {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      return undefined;
    }
    for (const table of tables) {
      const section = text.split(new RegExp(`^\\[${table.replace(/\./g, "\\.")}\\]\\s*$`, "m"))[1];
      if (!section) continue;
      const body = section.split(/^\[/m)[0];
      const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body);
      if (m) return sanitizeName(m[1]);
    }
    return undefined;
  };
  return tomlName("pyproject.toml", ["project", "tool.poetry"]) ?? tomlName("Cargo.toml", ["package"]);
}

export interface ResolvedTag {
  cwd: string;
  tag: string;
  // Why the tag isn't just the folder name, for the registration summary.
  reason: "plain" | "existing" | "manifest" | "parent";
}

// Assigns every repo a tag that's unique (in normalized form) across the
// batch and everything JARVIS already knows about. A repo keeps its plain
// folder name unless that name actually collides; every member of a
// colliding group is then disambiguated — none silently keeps the plain
// name — first by its manifest's package name, then by its parent
// folder(s), adding one more ancestor at a time until unique.
export function resolveTags(repos: string[], known: KnownLocation[]): ResolvedTag[] {
  const repoSet = new Set(repos);
  const taken = new Set<string>();
  const results = new Map<string, ResolvedTag>();

  // Anything already known elsewhere is fixed; a repo that's already
  // registered keeps its existing tag so re-running is stable.
  for (const k of known) {
    if (!k.cwd || repoSet.has(k.cwd)) continue;
    taken.add(normalizeTag(k.project_tag));
  }
  for (const k of known) {
    if (!k.cwd || !repoSet.has(k.cwd) || results.has(k.cwd)) continue;
    results.set(k.cwd, { cwd: k.cwd, tag: k.project_tag, reason: "existing" });
    taken.add(normalizeTag(k.project_tag));
  }

  const pending = repos.filter((r) => !results.has(r));
  const baseCounts = new Map<string, number>();
  for (const r of pending) {
    const key = normalizeTag(path.basename(r));
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }

  const colliding: string[] = [];
  for (const r of pending) {
    const base = path.basename(r);
    const key = normalizeTag(base);
    if (baseCounts.get(key) === 1 && !taken.has(key)) {
      results.set(r, { cwd: r, tag: base, reason: "plain" });
      taken.add(key);
    } else {
      colliding.push(r);
    }
  }

  for (const r of colliding) {
    const base = path.basename(r);
    const candidates: { tag: string; reason: ResolvedTag["reason"] }[] = [];
    const manifest = readManifestName(r);
    if (manifest && normalizeTag(manifest) !== normalizeTag(base)) {
      candidates.push({ tag: manifest, reason: "manifest" });
    }
    const ancestors: string[] = [];
    for (let dir = path.dirname(r); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      ancestors.unshift(path.basename(dir));
      candidates.push({ tag: `${base} (${ancestors.join("/")})`, reason: "parent" });
    }
    candidates.push({ tag: `${base} (${r})`, reason: "parent" });

    const pick = candidates.find((c) => !taken.has(normalizeTag(c.tag)))!;
    results.set(r, { cwd: r, tag: pick.tag, reason: pick.reason });
    taken.add(normalizeTag(pick.tag));
  }

  return repos.map((r) => results.get(r)!);
}
