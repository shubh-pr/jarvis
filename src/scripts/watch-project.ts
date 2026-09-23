import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const JARVIS_PORT = process.env.PORT ?? "8787";
const HOOKS_SECRET = process.env.HOOKS_SECRET;

if (!HOOKS_SECRET) {
  console.error("HOOKS_SECRET is not set in .env — run this from the JARVIS project directory.");
  process.exit(1);
}

const targetDir = process.argv[2];
if (!targetDir) {
  console.error("Usage: npx tsx src/scripts/watch-project.ts <path-to-project>");
  process.exit(1);
}

const projectPath = path.resolve(targetDir);
if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
  console.error(`Not a directory: ${projectPath}`);
  process.exit(1);
}

const claudeDir = path.join(projectPath, ".claude");
fs.mkdirSync(claudeDir, { recursive: true });

const settingsPath = path.join(claudeDir, "settings.local.json");
const existing = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  : {};

existing.hooks = existing.hooks ?? {};

function hookEntry(eventPath: string, timeout: number) {
  return {
    matcher: "*",
    hooks: [
      {
        type: "http",
        url: `http://localhost:${JARVIS_PORT}/api/hooks/${eventPath}`,
        headers: { Authorization: `Bearer ${HOOKS_SECRET}` },
        timeout,
      },
    ],
  };
}

function addIfMissing(event: string, entry: ReturnType<typeof hookEntry>) {
  const list: any[] = (existing.hooks[event] ??= []);
  const alreadyPresent = list.some((e) =>
    e.hooks?.some((h: any) => h.url === entry.hooks[0].url),
  );
  if (!alreadyPresent) list.push(entry);
}

addIfMissing("SessionStart", hookEntry("session-start", 30));
addIfMissing("PermissionRequest", hookEntry("permission-request", 604800)); // 7 days
addIfMissing("Stop", hookEntry("stop", 30));

fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
console.log(`JARVIS is now watching: ${projectPath}`);
console.log(`Wrote hooks to: ${settingsPath}`);
