import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "dotenv/config";
import { registerProject, listSessions, listProjects } from "../db.js";
import { discoverRepos, resolveTags, type ResolvedTag } from "../hooks/repoDiscovery.js";
import { getAdapter, DEFAULT_AGENT } from "../agent/adapters/index.js";

// Usage: npm run watch-project <path> [--force] [--no-permissions]
//
// <path> may be a single repo, or a folder holding many (like a directory
// you keep all your client work under). Every git repo at or under <path>,
// at any depth, is registered as its own project with its own hooks —
// Claude Code doesn't merge hook config from an ancestor directory down into
// a repo underneath it, so hooks have to live in each repo. --force skips
// discovery and registers <path> itself as one project.
//
// Each repo also gets default permission rules (see
// agent/adapters/claude/permissionDefaults.ts):
// read-only git and its offline build/test commands run without a prompt,
// state-changing commands always ask. Existing rules are kept; re-running
// only adds what's missing. --no-permissions leaves permissions untouched.

const JARVIS_PORT = process.env.PORT ?? "8787";
const HOOKS_SECRET = process.env.HOOKS_SECRET;

if (!HOOKS_SECRET) {
  console.error("HOOKS_SECRET is not set in .env — run this from the JARVIS project directory.");
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const withPermissions = !args.includes("--no-permissions");
const targetDir = args.find((a) => !a.startsWith("--"));
if (!targetDir) {
  console.error("Usage: npm run watch-project <path> [--force] [--no-permissions]");
  process.exit(1);
}

const resolved = path.resolve(targetDir);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
  console.error(`Not a directory: ${resolved}`);
  process.exit(1);
}
// Registered paths must match the cwd Claude Code reports for a session
// there, which is the real path — not a symlink the user happened to type.
const rootPath = fs.realpathSync(resolved);

// New projects run the default agent; its adapter writes the hooks (and,
// unless --no-permissions, the default permission rules) into the repo.
const adapter = getAdapter(DEFAULT_AGENT);

// Where reading shouldn't prompt beyond the repo itself: the folder the
// repos were discovered under (siblings are routinely read for context), and
// the local Maven cache for Maven repos (dependency sources). Reads only —
// writes anywhere still prompt.
const m2 = path.join(os.homedir(), ".m2", "repository");
function readDirsFor(projectPath: string): string[] {
  const dirs: string[] = [];
  if (rootPath !== projectPath) dirs.push(rootPath);
  const isMaven = fs.existsSync(path.join(projectPath, "pom.xml"));
  if (isMaven && fs.existsSync(m2)) dirs.push(fs.realpathSync(m2));
  return dirs;
}

// Which directories become projects. A plain folder with no repo anywhere
// under it is still watched as-is, as before.
let targets: string[];
if (force) {
  targets = [rootPath];
} else {
  const repos = discoverRepos(rootPath);
  targets = repos.length ? repos : [rootPath];
}

// Registered projects first, so a directory that's already registered keeps
// its registered tag over some older session's tag for the same path.
const known = [
  ...listProjects().map((p) => ({ project_tag: p.tag, cwd: p.cwd })),
  ...listSessions(),
];
const tags = resolveTags(targets, known);

let rulesAdded = 0;
for (const t of tags) {
  rulesAdded += adapter.installProject(t.cwd, {
    jarvisPort: JARVIS_PORT,
    hooksSecret: HOOKS_SECRET,
    withPermissions,
    readDirs: readDirsFor(t.cwd),
  });
  // Registering (not just writing hooks) is what makes the project a target
  // for "open <tag>" — JARVIS needs a cwd to spawn into before any session
  // has ever run there.
  registerProject(t.tag, t.cwd, adapter.id);
}

const home = os.homedir();
const pretty = (p: string) => (p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
const why = (t: ResolvedTag) =>
  t.reason === "manifest"
    ? "  (renamed from its package name — folder name collides)"
    : t.reason === "parent"
      ? "  (parent folder added — folder name collides)"
      : t.reason === "existing"
        ? "  (already registered)"
        : "";

if (tags.length === 1 && tags[0].cwd === rootPath) {
  console.log(`JARVIS is now watching: ${pretty(rootPath)}`);
  console.log(`Registered as project "${tags[0].tag}"${why(tags[0])} — say "open ${tags[0].tag} <instruction>" to have JARVIS launch a session here.`);
} else {
  console.log(`Found ${tags.length} git repo${tags.length === 1 ? "" : "s"} under ${pretty(rootPath)}. Registered each as its own project:`);
  const width = Math.max(...tags.map((t) => t.tag.length));
  for (const t of tags) console.log(`  ${t.tag.padEnd(width)}  ${pretty(t.cwd)}${why(t)}`);
  console.log(`\nSay "open <tag> <instruction>" to have JARVIS launch a session in any of them.`);
  console.log(`(To register ${pretty(rootPath)} itself as a single project instead, rerun with --force.)`);
}
if (withPermissions) {
  console.log(
    rulesAdded
      ? `Added ${rulesAdded} default permission rule${rulesAdded === 1 ? "" : "s"}: read-only git and offline build/test run without a prompt; state-changing commands always ask.`
      : "Default permission rules were already in place.",
  );
}
