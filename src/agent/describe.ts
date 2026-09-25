import path from "node:path";

// A permission request in plain English, for the card and the push:
// - `title`: what it wants to do. For Bash that's the one-line description
//   Claude writes for every command — the clearest gist there is, but it's
//   Claude's own claim, so it's never the only thing shown.
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

function commandTags(command: string): string[] {
  const bare = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  const tags = TAG_RULES.filter(([re, , on]) => re.test(on === "bare" ? bare : command)).map(([, tag]) => tag);
  return [...new Set(tags)];
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.:]$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function shortPath(p: unknown, cwd: string): string {
  if (typeof p !== "string") return "a file";
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host || String(url);
  } catch {
    return String(url);
  }
}

// What a bare command is doing, when Claude didn't describe it.
function guessBashTitle(command: string): string {
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

export function describeRequest(toolName: string, input: any, cwd: string): RequestSummary {
  switch (toolName) {
    case "Bash": {
      const command = String(input?.command ?? "");
      const described = typeof input?.description === "string" && input.description.trim();
      return {
        title: described ? sentence(input.description) : guessBashTitle(command),
        tags: commandTags(command),
        detail: command,
      };
    }
    case "Edit":
    case "MultiEdit":
      return { title: `Edit ${shortPath(input?.file_path, cwd)}`, tags: ["writes files"], detail: input?.file_path };
    case "Write":
      return { title: `Create or overwrite ${shortPath(input?.file_path, cwd)}`, tags: ["writes files"], detail: input?.file_path };
    case "NotebookEdit":
      return { title: `Edit notebook ${shortPath(input?.notebook_path, cwd)}`, tags: ["writes files"], detail: input?.notebook_path };
    case "WebFetch":
      return { title: `Open ${hostOf(input?.url)}`, tags: ["goes online"], detail: input?.url };
    case "WebSearch":
      return { title: `Search the web for "${String(input?.query ?? "")}"`, tags: ["goes online"] };
    case "Read":
      return { title: `Read ${shortPath(input?.file_path, cwd)}`, tags: [], detail: input?.file_path };
    case "Glob":
    case "Grep":
      return { title: `Search files for ${JSON.stringify(input?.pattern ?? "")}`, tags: [], detail: input?.path };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return { title: `Use ${mcp[2].replace(/_/g, " ")} (${mcp[1]})`, tags: [], detail: JSON.stringify(input) };
      return { title: `Use ${toolName}`, tags: [], detail: JSON.stringify(input) };
    }
  }
}

// The same thing as one block of text: the chat log, push body, and any
// client that can't render the structured card.
export function summaryText(s: RequestSummary): string {
  const tags = s.tags.length ? `\n(${s.tags.join(" · ")})` : "";
  const detail = s.detail ? `\n$ ${s.detail}` : "";
  return `${s.title}${tags}${detail}`;
}
