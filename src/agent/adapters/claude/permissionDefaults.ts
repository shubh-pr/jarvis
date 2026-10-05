import fs from "node:fs";
import path from "node:path";

// Default Claude Code permission rules for a registered repo: read-only git
// and the repo's own offline build/test commands run without a prompt;
// state-changing commands always ask. These are Claude Code's own rules in
// the repo's .claude/settings.local.json — Jarvis's router and hold logic
// are untouched; an allowed command simply never raises a prompt.
//
// Why the rules look the way they do (each verified against a real
// `claude --print` run):
// - Plain `ls`/`cat`/`grep`/`find`/`git log` etc. already run unprompted by
//   Claude Code's built-in read-only handling, which also still prompts for
//   `find -delete`, `sed -i` and the like. So no broad rules for those.
// - Claude runs git as `git -C <repo path> …`, which the built-in handling
//   doesn't treat as read-only. The path is written out exactly rather than
//   wildcarded: `git -C * log *` would also match
//   `git -C /x -c core.pager='any command' log`, which executes code.
// - Rules match text only, with no notion of flags, so trailing wildcards
//   are used only where every extra argument is harmless. Build/test
//   commands are exact: `./mvnw -o test *` would also allow
//   `./mvnw -o test exec:exec …`.
// - Claude Code checks ask rules before allow rules, so the ask list holds
//   even against a broader allow rule added later.
// - Reading outside the repo (a sibling repo, the Maven cache) is inspection
//   too, so those folders are `additionalDirectories`: reads there are free.
//   That doesn't loosen writes — Edit/Write/NotebookEdit are ask rules, so
//   they prompt anywhere, even in a session switched to auto-accept edits,
//   and Bash writes (redirects, mkdir, …) prompt as always.

export interface PermissionRules {
  allow: string[];
  ask: string[];
  additionalDirectories: string[];
}

const GIT_READ = ["status", "log", "diff", "show"];
const GIT_WRITES_FILE = ["log", "diff", "show"]; // accept --output=<file>
const GIT_LIST_FORMS = ["branch --list", "remote -v", "stash list"];
const GIT_STATE_CHANGING = [
  "commit", "push", "pull", "fetch", "checkout", "switch", "reset", "merge", "rebase",
  "cherry-pick", "revert", "tag", "stash push", "stash pop", "stash drop", "stash clear",
  "branch -d", "branch -D", "branch -m", "remote add", "remote remove", "clean",
];

function bash(cmd: string): string {
  return `Bash(${cmd})`;
}

// Both the exact command and the command with anything after it.
function withArgs(cmd: string): string[] {
  return [bash(cmd), bash(`${cmd} *`)];
}

function mavenCommand(cwd: string): string | undefined {
  if (fs.existsSync(path.join(cwd, "mvnw"))) return "./mvnw";
  if (fs.existsSync(path.join(cwd, "pom.xml"))) return "mvn";
  return undefined;
}

function npmScripts(cwd: string): Record<string, unknown> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  } catch {
    return {};
  }
}

// `readDirs`: folders beyond the repo where reading shouldn't prompt.
export function defaultPermissions(cwd: string, readDirs: string[] = []): PermissionRules {
  const allow: string[] = [];
  const ask: string[] = ["Edit", "Write", "NotebookEdit"];
  // Claude quotes a path containing whitespace; cover both spellings.
  const prefixes = /\s/.test(cwd) ? [`git -C ${cwd}`, `git -C "${cwd}"`] : [`git -C ${cwd}`];

  for (const p of prefixes) {
    for (const sub of GIT_READ) allow.push(...withArgs(`${p} ${sub}`));
    for (const form of GIT_LIST_FORMS) allow.push(bash(`${p} ${form}`));
  }
  for (const form of GIT_LIST_FORMS) allow.push(bash(`git ${form}`));

  // A file-writing flag on an otherwise read-only git command still asks.
  for (const g of [...prefixes, "git"]) {
    for (const sub of GIT_WRITES_FILE) {
      ask.push(bash(`${g} ${sub} --output *`), bash(`${g} ${sub} --output=*`));
      ask.push(bash(`${g} ${sub} * --output *`), bash(`${g} ${sub} * --output=*`));
    }
    for (const sub of GIT_STATE_CHANGING) ask.push(...withArgs(`${g} ${sub}`));
  }

  // Offline build/test only (-o): no dependency downloads. Exact commands.
  const mvn = mavenCommand(cwd);
  if (mvn) {
    for (const goal of ["compile", "test", "package"]) {
      allow.push(bash(`${mvn} -o ${goal}`), bash(`${mvn} -o -q ${goal}`));
    }
  }
  const scripts = npmScripts(cwd);
  if (scripts.test) allow.push(bash("npm test"), bash("npm run test"));
  if (scripts.build) allow.push(bash("npm run build"));

  // Installs, deletes and network calls always ask.
  for (const cmd of ["npm install", "npm i", "npm ci", "npm uninstall", "npx", "yarn add", "pnpm add",
    "pip install", "pip3 install", "rm", "curl", "wget"]) {
    ask.push(...withArgs(cmd));
  }

  return {
    allow: [...new Set(allow)],
    ask: [...new Set(ask)],
    additionalDirectories: [...new Set(readDirs.filter((d) => d !== cwd))],
  };
}

// Adds the defaults to a settings object in place, keeping every rule
// already there. Returns how many rules were added.
export function mergePermissions(settings: any, rules: PermissionRules): number {
  settings.permissions = settings.permissions ?? {};
  let added = 0;
  for (const kind of ["allow", "ask", "additionalDirectories"] as const) {
    const list: string[] = (settings.permissions[kind] ??= []);
    for (const rule of rules[kind]) {
      if (!list.includes(rule)) {
        list.push(rule);
        added++;
      }
    }
  }
  return added;
}
