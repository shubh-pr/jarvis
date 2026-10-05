import path from "node:path";

// A permission request in plain English, for the card and the push. Each
// agent adapter builds one from its own tool names (describeTool); the
// pieces here are shared.
// - `title`: what it wants to do. For a shell command that's the agent's own
//   one-line description when it writes one — the clearest gist there is,
//   but it's the agent's claim, so it's never the only thing shown.
// - `tags`: Jarvis's own reading of the actual command — what kind of risk
//   it carries — independent of what the description says.
// - `detail`: the exact command or target, kept one tap away on the card.
export interface RequestSummary {
  title: string;
  tags: string[];
  detail?: string;
}

// Each rule reads either the command with quoted text blanked out (so a `>`
// inside a grep pattern isn't taken for a redirect) or, for code-level
// writes like `.write(`, the raw command.
const TAG_RULES: [RegExp, string, "bare" | "raw"][] = [
  [/(^|[\s;&|(])(rm|rmdir|unlink|shred)\s|\s-delete\b|\bgit\s+(\S+\s+)*clean\b|\bgit\s+(\S+\s+)*branch\s+-[dD]\b/, "deletes files", "bare"],
  [/\bgit\s+(\S+\s+)*push\b/, "pushes to a remote", "bare"],
  [/\bgit\s+(\S+\s+)*(commit|reset|checkout|switch|merge|rebase|cherry-pick|revert|stash|tag)\b/, "changes git history", "bare"],
  [/\b(npm\s+(install|i|ci|add|uninstall)|yarn\s+add|pnpm\s+add|pip3?\s+install|brew\s+install|apt(-get)?\s+install|npx)\b|\bmvnw?\s+(\S+\s+)*install\b/, "installs packages", "bare"],
  [/\b(curl|wget|ssh|scp|rsync|nc|telnet)\b|\bgit\s+(\S+\s+)*(fetch|pull|clone)\b|(^|[\s;&|(])(\.\/mvnw|mvn)(?![^;&|]*\s-o\b)[^;&|]*\s(compile|test|package|verify|install)\b/, "goes online", "bare"],
  [/https?:\/\/(?!localhost|127\.0\.0\.1)/, "goes online", "raw"],
  [/(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null|&)\S|\b(tee|mv|cp|mkdir|touch|chmod|chown|ln)\s|\bsed\s+(-\S+\s+)*-i/, "writes files", "bare"],
  [/\.write\(|open\([^)]*['"][wa]['"]/, "writes files", "raw"],
  [/(^|[\s;&|(])(python3?|node|ruby|perl|bash|sh|zsh)\s+(-c\b|-\s|<<|\S+\.(py|js|mjs|rb|pl|sh)\b)/, "runs a script", "bare"],
];

export function commandTags(command: string): string[] {
  const bare = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  const tags = TAG_RULES.filter(([re, , on]) => re.test(on === "bare" ? bare : command)).map(([, tag]) => tag);
  return [...new Set(tags)];
}

export function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.:]$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function shortPath(p: unknown, cwd: string): string {
  if (typeof p !== "string") return "a file";
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

export function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host || String(url);
  } catch {
    return String(url);
  }
}

// What a bare shell command is doing, when the agent didn't describe it.
export function guessBashTitle(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const known: Record<string, string> = {
    git: "Run a git command",
    npm: "Run an npm command",
    "./mvnw": "Run a Maven build",
    mvn: "Run a Maven build",
    rm: "Delete files",
    curl: "Make a web request",
    python3: "Run a Python script",
    python: "Run a Python script",
    node: "Run a Node script",
  };
  return known[first] ?? "Run a shell command";
}

// The same thing as one block of text: the chat log, push body, and any
// client that can't render the structured card.
export function summaryText(s: RequestSummary): string {
  const tags = s.tags.length ? `\n(${s.tags.join(" · ")})` : "";
  const detail = s.detail ? `\n$ ${s.detail}` : "";
  return `${s.title}${tags}${detail}`;
}
