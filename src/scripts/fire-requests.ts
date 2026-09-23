// Fires fake PermissionRequest hook calls at a running JARVIS server, exactly
// as Claude Code would, so display/state behavior under back-to-back requests
// can be watched on a real phone without coaxing a real session into it.
//
//   npm run fire-requests                       # 2 requests, 300ms apart
//   npm run fire-requests -- --count 3 --gap 0  # 3 at once
//   npm run fire-requests -- --projects alpha,beta  # one per project
//
// Each hook call stays open until you answer it from the PWA; the decision
// it receives is printed here. Ctrl-C drops the open calls, which JARVIS
// should show as "cancelled". Nothing is executed — the commands are labels.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import "dotenv/config";

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "2" },
    gap: { type: "string", default: "300" },
    project: { type: "string", default: "jarvis-test" },
    projects: { type: "string" },
  },
});

const PORT = process.env.PORT ?? "8787";
const HOOKS_SECRET = process.env.HOOKS_SECRET;
const DB_PATH = process.env.DB_PATH ?? "./jarvis.db";
if (!HOOKS_SECRET) {
  console.error("HOOKS_SECRET is not set in .env — run this from the JARVIS project directory.");
  process.exit(1);
}

const projects = values.projects ? values.projects.split(",").map((p) => p.trim()).filter(Boolean) : null;
const count = projects ? projects.length : Number(values.count);
const gapMs = Number(values.gap);
if (!Number.isInteger(count) || count < 1 || !Number.isFinite(gapMs) || gapMs < 0) {
  console.error("--count must be a positive integer and --gap a non-negative number of ms.");
  process.exit(1);
}

// The project tag is derived from the cwd's basename. The directory is
// created so that an instruction typed at a fake project fails with a clear
// claude error rather than a confusing spawn ENOENT.
const runId = crypto.randomBytes(3).toString("hex");
const sessions = new Map<string, { sessionId: string; cwd: string }>();
function sessionFor(project: string) {
  let s = sessions.get(project);
  if (!s) {
    const cwd = path.join(os.tmpdir(), "jarvis-fake-projects", project);
    fs.mkdirSync(cwd, { recursive: true });
    s = { sessionId: `fake-${project}-${runId}`, cwd };
    sessions.set(project, s);
  }
  return s;
}

const controllers: AbortController[] = [];
const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

async function fire(i: number): Promise<void> {
  const project = projects ? projects[i] : values.project!;
  const { sessionId, cwd } = sessionFor(project);
  const command = `echo "JARVIS TEST #${i + 1} of ${count} (${project})"`;
  const ac = new AbortController();
  controllers.push(ac);

  console.log(`${elapsed()}  sent     #${i + 1} [${project}] ${command}`);
  try {
    const res = await fetch(`http://localhost:${PORT}/api/hooks/permission-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
      body: JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command, description: `Fake request ${i + 1} from fire-requests` },
      }),
      signal: ac.signal,
    });
    const body: any = await res.json();
    const d = body?.hookSpecificOutput?.decision;
    const detail = d?.message ? ` — "${d.message}"` : "";
    console.log(`${elapsed()}  answered #${i + 1} [${project}] ${d?.behavior ?? JSON.stringify(body)}${detail}`);
  } catch (err: any) {
    if (ac.signal.aborted) return;
    console.log(`${elapsed()}  failed   #${i + 1} [${project}] ${err?.cause?.code ?? err?.message ?? err}`);
  }
}

// Fake sessions would otherwise stay "active" forever (nothing retires a
// session yet) and break "only one active project" routing for real ones.
function retireFakeSessions() {
  try {
    const db = new Database(DB_PATH);
    const stmt = db.prepare(`UPDATE sessions SET status = 'done' WHERE id = ?`);
    for (const { sessionId } of sessions.values()) stmt.run(sessionId);
    db.close();
  } catch (err) {
    console.error("Couldn't retire fake sessions:", err);
  }
}

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log(`\n${elapsed()}  Ctrl-C — dropping open hook calls (JARVIS should mark them cancelled).`);
  for (const ac of controllers) ac.abort();
});

async function main() {
  console.log(`Firing ${count} fake permission request(s) at localhost:${PORT}, ${gapMs}ms apart. Answer them from the PWA.\n`);
  const calls: Promise<void>[] = [];
  for (let i = 0; i < count && !interrupted; i++) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    calls.push(fire(i));
  }
  await Promise.all(calls);
  retireFakeSessions();
  console.log(`\n${elapsed()}  Done. Fake sessions marked done.`);
  process.exit(0);
}

main();
