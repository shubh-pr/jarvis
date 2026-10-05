import fs from "node:fs";
import path from "node:path";
import type { InstallOptions } from "../types.js";
import { defaultPermissions, mergePermissions } from "./permissionDefaults.js";

// Writes the Jarvis hooks (and, unless withPermissions is off, the default
// permission rules) into the repo's .claude/settings.local.json. Claude Code
// doesn't merge hook config from an ancestor directory into a repo beneath
// it, so every repo gets its own. Returns the number of permission rules
// added.
export function installProject(projectPath: string, opts: InstallOptions): number {
  // UserPromptSubmit takes no matcher; it's written the way it was verified.
  const hookEntry = (eventPath: string, timeout: number, matcher: string | null = "*") => ({
    ...(matcher === null ? {} : { matcher }),
    hooks: [
      {
        type: "http",
        url: `http://localhost:${opts.jarvisPort}/api/hooks/${eventPath}`,
        headers: { Authorization: `Bearer ${opts.hooksSecret}` },
        timeout,
      },
    ],
  });

  const claudeDir = path.join(projectPath, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  settings.hooks = settings.hooks ?? {};

  const addIfMissing = (event: string, entry: ReturnType<typeof hookEntry>) => {
    const list: any[] = (settings.hooks[event] ??= []);
    const alreadyPresent = list.some((e) => e.hooks?.some((h: any) => h.url === entry.hooks[0].url));
    if (!alreadyPresent) list.push(entry);
  };
  addIfMissing("SessionStart", hookEntry("session-start", 30));
  addIfMissing("UserPromptSubmit", hookEntry("user-prompt-submit", 10, null)); // marks a turn as started
  addIfMissing("PermissionRequest", hookEntry("permission-request", 604800)); // 7 days
  addIfMissing("Stop", hookEntry("stop", 30));

  const added = opts.withPermissions ? mergePermissions(settings, defaultPermissions(projectPath, opts.readDirs)) : 0;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return added;
}
