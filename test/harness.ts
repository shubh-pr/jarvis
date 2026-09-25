// End-to-end harness for the approval loop. Spawns a real JARVIS server
// (fresh SQLite DB, fake `claude` on PATH, fake HTTPS push endpoint) and
// drives it the way Claude Code hooks and the PWA do, asserting on what
// actually reaches the blocked hook call.
//
//   npm run test:harness
//
// Only things that need a real `claude` session (hook timeout caps, laptop
// sleep/wake) are out of scope here.

import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { WebSocket } from "ws";
import Database from "better-sqlite3";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASSCODE = "harness-passcode";
const HOOKS_SECRET = "harness-hooks-secret";
// Must exceed the server's guard against typed replies to brand-new requests.
const FRESH_GUARD_WAIT_MS = 1700;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-harness-"));
const VAPID = webpush.generateVAPIDKeys();

// ---------- tiny assertion recorder ----------

type Result = { scenario: string; name: string; pass: boolean; detail?: string };
const results: Result[] = [];
let currentScenario = "";

function check(name: string, pass: boolean, detail?: string) {
  results.push({ scenario: currentScenario, name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n        → ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | false, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ---------- fake `claude` binary ----------

const FAKE_BIN = path.join(TMP, "bin");
const FAKE_CLAUDE_LOG = path.join(TMP, "claude-invocations.log");
fs.mkdirSync(FAKE_BIN);
fs.writeFileSync(
  path.join(FAKE_BIN, "claude"),
  // While the hold file exists the fake stays running, like a real claude
  // mid-turn; otherwise it exits at once.
  `#!/bin/sh\nprintf 'cwd=%s %s\\n' "$(pwd -P)" "$(printf '%s' "$*" | tr '\\n' '|')" >> "$FAKE_CLAUDE_LOG"\nwhile [ -e "$FAKE_CLAUDE_HOLD" ]; do sleep 0.1; done\n`,
  { mode: 0o755 },
);

const FAKE_CLAUDE_HOLD = path.join(TMP, "claude-hold");
const holdClaude = () => fs.writeFileSync(FAKE_CLAUDE_HOLD, "");
const releaseClaude = () => fs.rmSync(FAKE_CLAUDE_HOLD, { force: true });

function claudeInvocations(): string[] {
  if (!fs.existsSync(FAKE_CLAUDE_LOG)) return [];
  return fs.readFileSync(FAKE_CLAUDE_LOG, "utf8").split("\n").filter(Boolean);
}

function resetClaudeLog() {
  fs.rmSync(FAKE_CLAUDE_LOG, { force: true });
}

// ---------- fake push service (web-push only speaks HTTPS) ----------

let pushCount = 0;
async function startPushEndpoint(): Promise<number> {
  const key = path.join(TMP, "key.pem");
  const cert = path.join(TMP, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  const port = await freePort();
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    req.resume();
    req.on("end", () => {
      pushCount++;
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(port, r));
  srv.unref();
  return port;
}

// ---------- JARVIS server process ----------

interface Server {
  port: number;
  dbPath: string;
  proc: ChildProcess;
  output: string[];
}

async function startServer(opts: { port?: number; dbPath?: string; env?: Record<string, string> } = {}): Promise<Server> {
  const port = opts.port ?? (await freePort());
  const dbPath = opts.dbPath ?? path.join(TMP, `jarvis-${crypto.randomUUID()}.db`);
  const output: string[] = [];
  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      AUTH_PASSCODE: PASSCODE,
      HOOKS_SECRET,
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPID_PRIVATE_KEY: VAPID.privateKey,
      VAPID_SUBJECT: "mailto:harness@example.com",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      FAKE_CLAUDE_LOG,
      FAKE_CLAUDE_HOLD,
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => output.push(d.toString()));
  proc.stderr!.on("data", (d) => output.push(d.toString()));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://localhost:${port}/health`).then((r) => r.ok, () => false);
    if (ok) return { port, dbPath, proc, output };
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`server failed to start:\n${output.join("")}`);
}

function killServer(s: Server): Promise<void> {
  return new Promise((resolve) => {
    if (s.proc.exitCode !== null) return resolve();
    s.proc.once("exit", () => resolve());
    s.proc.kill("SIGKILL");
  });
}

async function login(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  return (await res.json()).token;
}

async function subscribePush(port: number, token: string, pushPort: number) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  await fetch(`http://localhost:${port}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      endpoint: `https://localhost:${pushPort}/push/${crypto.randomUUID()}`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: crypto.randomBytes(16).toString("base64url"),
      },
    }),
  });
}

// ---------- hook calls (what Claude Code does) ----------

interface HookCall {
  settled: boolean;
  result?: any;
  error?: unknown;
  abort: () => void;
  behavior: () => string | undefined;
}

function permissionHook(port: number, sessionId: string, cwd: string, command: string): HookCall {
  const ac = new AbortController();
  const call: HookCall = {
    settled: false,
    abort: () => ac.abort(),
    behavior: () => call.result?.hookSpecificOutput?.decision?.behavior,
  };
  fetch(`http://localhost:${port}/api/hooks/permission-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
    body: JSON.stringify({
      session_id: sessionId,
      cwd,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command },
    }),
    signal: ac.signal,
  })
    .then((r) => r.json())
    .then(
      (json) => { call.settled = true; call.result = json; },
      (err) => { call.settled = true; call.error = err; },
    );
  return call;
}

function projectDir(...parts: string[]): string {
  const dir = path.join(TMP, "projects", ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Mirrors what `watch-project.ts` does to a real DB — writes directly rather
// than importing src/db.ts, since that module opens its own connection at
// import time keyed off process.env.DB_PATH, which belongs to the spawned
// server here, not this harness process.
function registerProjectDirect(dbPath: string, tag: string, cwd: string): void {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (tag, cwd, created_at, last_used_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(tag) DO UPDATE SET cwd = excluded.cwd, last_used_at = excluded.last_used_at`,
  ).run(tag, cwd, now, now);
  db.close();
}

// ---------- PWA client ----------

class Client {
  events: any[] = [];
  private constructor(public ws: WebSocket) {
    ws.on("message", (raw) => {
      try { this.events.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
  }

  static open(port: number, token: string, opts: { autoPong?: boolean } = {}): Promise<Client> {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`, { autoPong: opts.autoPong ?? true });
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }

  waitFor(pred: (e: any) => boolean, timeoutMs = 1500): Promise<any | undefined> {
    return until(() => this.events.find(pred), timeoutMs);
  }

  latest(pred: (e: any) => boolean): any | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (pred(this.events[i])) return this.events[i];
    return undefined;
  }

  async toolUseIdFor(sessionId: string, command: string): Promise<string | undefined> {
    const ev = await this.waitFor(
      (e) => e.type === "permission_request" && e.toolUseID &&
        (e.sessionId === sessionId || e.tag === sessionId) && String(e.content).includes(command),
    );
    return ev?.toolUseID;
  }

  // Sends one inbound message and waits for the server's ack for it.
  async request(msg: Record<string, unknown>, timeoutMs = 1500): Promise<any | undefined> {
    const clientId = crypto.randomUUID();
    this.ws.send(JSON.stringify({ ...msg, clientId }));
    return this.waitFor((e) => e.type === "ack" && e.clientId === clientId, timeoutMs);
  }

  close() { this.ws.terminate(); }
}

function describeAck(ack: any): string {
  return ack ? JSON.stringify(ack) : "no ack received";
}

// ---------- scenarios ----------

async function scenarioCoreRace() {
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const cwd = projectDir("proj-race");
    const sid = "session-race";

    const h1 = permissionHook(srv.port, sid, cwd, "rm -rf build");
    const id1 = await c.toolUseIdFor(sid, "rm -rf build");
    const h2 = permissionHook(srv.port, sid, cwd, "git push --force");
    const id2 = await c.toolUseIdFor(sid, "git push --force");
    await sleep(300);

    check("1.1 request #1 is still pending after #2 arrives in the same project (no auto-deny)",
      !h1.settled, `hook #1 already returned ${JSON.stringify(h1.result)}`);

    const ack1 = await c.request({ type: "decision", toolUseID: id1, decision: "allow" });
    await until(() => h1.settled, 1000);
    check("1.2 a decision tagged with #1's toolUseID resolves #1",
      h1.behavior() === "allow", `hook #1 → ${h1.behavior() ?? "unresolved"}; ${describeAck(ack1)}`);
    check("1.3 …and does not touch #2", !h2.settled, `hook #2 → ${h2.behavior()}`);

    const ack2 = await c.request({ type: "decision", toolUseID: id1, decision: "allow" });
    check("1.4 a repeat decision for already-resolved #1 is rejected as stale",
      ack2?.ok === false && ack2?.reason === "stale" && !h2.settled,
      `${describeAck(ack2)}; hook #2 settled=${h2.settled}`);

    // The exact harm window: a new request lands right before a typed "yes".
    const h3 = permissionHook(srv.port, sid, cwd, "npm publish");
    const id3 = await c.toolUseIdFor(sid, "npm publish");
    const ack3 = await c.request({ type: "chat", content: "yes", replyTo: id3 });
    await sleep(200);
    check("1.5 a typed 'yes' against a request that arrived <1.5s ago is refused, not applied",
      !h3.settled && !h2.settled && ack3?.ok === false,
      `hook #3 → ${h3.behavior() ?? "unresolved"}, hook #2 → ${h2.behavior() ?? "unresolved"}; ${describeAck(ack3)}`);

    await sleep(FRESH_GUARD_WAIT_MS);
    const ack4 = await c.request({ type: "chat", content: "yes" });
    await sleep(200);
    check("1.6 a bare 'yes' with two requests pending in one project is refused as ambiguous",
      !h3.settled && !h2.settled && ack4?.ok === false,
      `hook #3 → ${h3.behavior() ?? "unresolved"}, hook #2 → ${h2.behavior() ?? "unresolved"}; ${describeAck(ack4)}`);

    const ack5 = await c.request({ type: "chat", content: "yes", replyTo: id3 });
    await until(() => h3.settled, 1000);
    check("1.7 once settled on screen, a typed 'yes' with replyTo=#3 approves exactly #3",
      h3.behavior() === "allow" && !h2.settled,
      `hook #3 → ${h3.behavior() ?? "unresolved"}, hook #2 settled=${h2.settled}; ${describeAck(ack5)}`);

    void id2;
    h2.abort();
    c.close();
  } finally {
    await killServer(srv);
  }
}

async function scenarioRestart() {
  resetClaudeLog();
  let srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const cwd = projectDir("proj-restart");
    const sid = "session-restart";

    const h = permissionHook(srv.port, sid, cwd, "terraform apply");
    const idR = await c.toolUseIdFor(sid, "terraform apply");
    c.close();

    await killServer(srv);
    await until(() => h.settled, 2000);
    check("2.1 killing JARVIS gives the blocked hook call an immediate connection error (claude isn't left hanging)",
      h.settled && h.error !== undefined, h.settled ? `got result ${JSON.stringify(h.result)}` : "still hanging after 2s");

    srv = await startServer({ port: srv.port, dbPath: srv.dbPath });
    const c2 = await Client.open(srv.port, token);
    const snap = await c2.waitFor((e) => e.type === "permissions");
    const item = snap?.items?.find((i: any) => i.toolUseID === idR);
    check("2.2 after restart, the orphaned request is reported as stale",
      item?.status === "stale", snap ? `snapshot item: ${JSON.stringify(item)}` : "no permissions snapshot on connect");

    const ackYes = await c2.request({ type: "chat", content: "yes" });
    await sleep(800);
    const invoked = claudeInvocations();
    check("2.3 a 'yes' sent after restart is refused, not run as a new `claude --resume --print` turn",
      invoked.length === 0 && ackYes?.ok === false,
      `claude invoked: ${JSON.stringify(invoked)}; ${describeAck(ackYes)}`);

    const ackDec = await c2.request({ type: "decision", toolUseID: idR, decision: "allow" });
    check("2.4 a tagged decision for the dead request is rejected as stale",
      ackDec?.ok === false && ackDec?.reason === "stale", describeAck(ackDec));

    // Hook connection dropped while pending (Esc in the terminal, claude exit).
    resetClaudeLog();
    const hc = permissionHook(srv.port, sid, cwd, "docker system prune");
    const idC = await c2.toolUseIdFor(sid, "docker system prune");
    await sleep(100);
    hc.abort();
    await sleep(300);
    const snapC = c2.latest((e) => e.type === "permissions");
    const itemC = snapC?.items?.find((i: any) => i.toolUseID === idC);
    const ackC = await c2.request({ type: "chat", content: "yes", replyTo: idC });
    await sleep(500);
    check("2.5 a request whose hook connection closed is marked cancelled, and replies to it are refused",
      itemC?.status === "cancelled" && ackC?.ok === false && claudeInvocations().length === 0,
      `snapshot item: ${JSON.stringify(itemC)}; ${describeAck(ackC)}; claude invoked: ${JSON.stringify(claudeInvocations())}`);

    c2.close();
  } finally {
    await killServer(srv);
  }
}

async function scenarioGhostAndResync(pushPort: number) {
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    await subscribePush(srv.port, token, pushPort);
    const cwd = projectDir("proj-push");
    const sid = "session-push";

    const healthy = await Client.open(srv.port, token);
    let before = pushCount;
    const hA = permissionHook(srv.port, sid, cwd, "make deploy");
    const idA = await healthy.toolUseIdFor(sid, "make deploy");
    await until(() => pushCount > before, 2000);
    check("3.1 a permission request is pushed even while some other client (e.g. a laptop tab) is connected",
      pushCount > before, "no push sent — a connected client suppressed it");

    const ghost = await Client.open(srv.port, token, { autoPong: false });
    before = pushCount;
    const hB = permissionHook(srv.port, sid, cwd, "kubectl delete pod");
    const idB = await healthy.toolUseIdFor(sid, "kubectl delete pod");
    await until(() => pushCount > before, 2000);
    check("3.2 a permission request is pushed while a ghost (non-ponging) socket still looks connected",
      pushCount > before, "no push sent — the ghost socket suppressed it");

    const ackA = await healthy.request({ type: "decision", toolUseID: idA, decision: "allow" });
    await until(() => hA.settled, 1000);
    healthy.close();
    ghost.close();

    const fresh = await Client.open(srv.port, token);
    const snap = await fresh.waitFor((e) => e.type === "permissions");
    const history = await fresh.waitFor((e) => e.type === "history");
    const itemA = snap?.items?.find((i: any) => i.toolUseID === idA);
    const itemB = snap?.items?.find((i: any) => i.toolUseID === idB);
    check("3.3 on reconnect, pending state is resynced: #B pending, resolved #A not shown as pending",
      itemB?.status === "pending" && (!itemA || itemA.status !== "pending"),
      snap ? `A=${JSON.stringify(itemA)} B=${JSON.stringify(itemB)} (ack for A: ${describeAck(ackA)})` : "no permissions snapshot on connect");

    const replayedReqs = (history?.messages ?? []).filter((m: any) => m.type === "permission_request");
    check("3.4 history arrives as one snapshot, and each replayed request carries its toolUseID",
      replayedReqs.length === 2 && replayedReqs.every((m: any) => m.toolUseID),
      history ? `replayed requests: ${JSON.stringify(replayedReqs)}` : "no history snapshot — backlog replayed as loose messages");

    const snapIdx = fresh.events.findIndex((e) => e.type === "permissions");
    const histIdx = fresh.events.findIndex((e) => e.type === "history");
    check("3.5 permission states arrive before the history they label (no stale-button flash on reconnect)",
      snapIdx !== -1 && histIdx !== -1 && snapIdx < histIdx, `permissions at #${snapIdx}, history at #${histIdx}`);

    hB.abort();
    fresh.close();
  } finally {
    await killServer(srv);
  }
}

async function scenarioParsing() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);

    const ha = permissionHook(srv.port, "session-alpha", projectDir("alpha-app"), "rm -rf dist");
    const hb = permissionHook(srv.port, "session-beta", projectDir("beta-app"), "git reset --hard");
    await c.toolUseIdFor("session-alpha", "rm -rf dist");
    await c.toolUseIdFor("session-beta", "git reset --hard");
    await sleep(FRESH_GUARD_WAIT_MS);

    await c.request({ type: "chat", content: "yes" });
    await sleep(300);
    check("4.1 a bare 'yes' with two projects waiting resolves neither",
      !ha.settled && !hb.settled, `alpha → ${ha.behavior()}, beta → ${hb.behavior()}`);

    const ackB = await c.request({ type: "chat", content: "yes beta-app" });
    await until(() => hb.settled, 1000);
    check("4.2 'yes beta-app' approves beta-app (not deny-with-guidance) and leaves alpha-app pending",
      hb.behavior() === "allow" && !ha.settled,
      `beta → ${hb.behavior() ?? "unresolved"} ${JSON.stringify(hb.result?.hookSpecificOutput?.decision ?? {})}; alpha settled=${ha.settled}; ${describeAck(ackB)}`);

    // Approving lets beta's turn carry on; a new instruction waits for that
    // turn to end, so end it the way claude would.
    await stopHook(srv.port, "session-beta", projectDir("beta-app"));
    const ackI = await c.request({ type: "chat", content: "beta-app run the tests" });
    // Spawning the fake claude (a shell script) can take a while under load.
    await until(() => claudeInvocations().length > 0, 2000);
    const invoked = claudeInvocations();
    check("4.3 an instruction naming beta-app reaches it while alpha-app is still waiting",
      invoked.some((l) => l.includes("--resume session-beta")) && !ha.settled,
      `claude invoked: ${JSON.stringify(invoked)}; alpha settled=${ha.settled}; ${describeAck(ackI)}`);

    await c.request({ type: "chat", content: "no alpha-app" });
    await until(() => ha.settled, 1000);
    check("4.4 'no alpha-app' denies alpha-app", ha.behavior() === "deny", `alpha → ${ha.behavior() ?? "unresolved"}`);

    // Same basename in two parents → "identity" and "identity (two)".
    const hc = permissionHook(srv.port, "session-id-one", projectDir("one", "identity"), "drop table users");
    await c.toolUseIdFor("session-id-one", "drop table users");
    const hd = permissionHook(srv.port, "session-id-two", projectDir("two", "identity"), "drop table orders");
    await c.toolUseIdFor("session-id-two", "drop table orders");
    await sleep(FRESH_GUARD_WAIT_MS);
    const ackD = await c.request({ type: "chat", content: "yes identity (two)" });
    await until(() => hc.settled || hd.settled, 1000);
    check("4.5 'yes identity (two)' approves that project, not the similarly named 'identity'",
      hd.behavior() === "allow" && !hc.settled,
      `identity(two) → ${hd.behavior() ?? "unresolved"}, identity → ${hc.behavior() ?? "unresolved"}; ${describeAck(ackD)}`);

    hc.abort();
    hd.abort();
    c.close();
  } finally {
    await killServer(srv);
  }
}

function sessionStartHook(port: number, sessionId: string, cwd: string): Promise<unknown> {
  return fetch(`http://localhost:${port}/api/hooks/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
    body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "SessionStart" }),
  }).then((r) => r.json());
}

async function scenarioSameProjectSessions() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const cwd = projectDir("gamma-app");
    // Two sessions in one project (an old one never retired + the current one).
    await sessionStartHook(srv.port, "session-gamma-old", cwd);
    await sleep(20);
    await sessionStartHook(srv.port, "session-gamma-new", cwd);

    const ack1 = await c.request({ type: "chat", content: "summarise the latest changes" });
    await until(() => claudeInvocations().length > 0, 2000);
    const first = claudeInvocations();
    check("5.1 with two sessions of the only active project, an unnamed instruction goes to its newest session",
      first.length === 1 && first[0].includes("--resume session-gamma-new"),
      `claude invoked: ${JSON.stringify(first)}; ${describeAck(ack1)}`);

    await sessionStartHook(srv.port, "session-delta", projectDir("delta-app"));
    resetClaudeLog();
    const ack2 = await c.request({ type: "chat", content: "tell me about the gamma app project" });
    await until(() => claudeInvocations().length > 0, 2000);
    const second = claudeInvocations();
    check("5.2 'gamma app' (space instead of hyphen) names gamma-app when another project is also active",
      second.length === 1 && second[0].includes("--resume session-gamma-new"),
      `claude invoked: ${JSON.stringify(second)}; ${describeAck(ack2)}`);

    c.close();
  } finally {
    await killServer(srv);
  }
}

async function scenarioOpenProject() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);

    const ack1 = await c.request({ type: "chat", content: "open nonexistent-project do something" });
    check("6.1 'open' on an unregistered, never-seen project is refused, nothing spawned",
      claudeInvocations().length === 0 && ack1?.ok === false && ack1?.reason === "unknown_project",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack1)}`);

    const epsilonCwd = projectDir("epsilon-app");
    registerProjectDirect(srv.dbPath, "epsilon-app", epsilonCwd);

    const ack2 = await c.request({ type: "chat", content: "open epsilon-app" });
    check("6.2 'open <registered project>' with no instruction and nothing running is refused, nothing spawned",
      claudeInvocations().length === 0 && ack2?.ok === false && ack2?.reason === "needs_instruction",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack2)}`);

    const ack3 = await c.request({ type: "chat", content: "open epsilon-app check for lint errors" });
    await until(() => claudeInvocations().length > 0, 2000);
    const launched = claudeInvocations();
    check("6.3 'open <registered project> <instruction>' with nothing running launches a fresh session (--print, no --resume)",
      launched.length === 1 && launched[0].includes("--print") && !launched[0].includes("--resume") && launched[0].includes("check for lint errors"),
      `claude invoked: ${JSON.stringify(launched)}; ${describeAck(ack3)}`);

    // The freshly launched claude reports in exactly like a manually started one.
    await sessionStartHook(srv.port, "session-epsilon", epsilonCwd);
    resetClaudeLog();

    const ack4 = await c.request({ type: "chat", content: "open epsilon-app" });
    check("6.4 'open' on a project with an active session (no instruction) reports already-open, nothing spawned",
      claudeInvocations().length === 0 && ack4?.ok === true && ack4?.action === "already_open",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack4)}`);

    const ack5 = await c.request({ type: "chat", content: "open epsilon-app run the tests" });
    await until(() => claudeInvocations().length > 0, 2000);
    const resumed = claudeInvocations();
    check("6.5 'open' on a project with an active session (with instruction) routes to it via --resume, not a fresh launch",
      resumed.length === 1 && resumed[0].includes("--resume session-epsilon") && !resumed[0].includes("--print epsilon"),
      `claude invoked: ${JSON.stringify(resumed)}; ${describeAck(ack5)}`);

    c.close();
  } finally {
    await killServer(srv);
  }
}

// ---------- watch-project.ts discovery and tagging (no server needed) ----------

function runWatchProject(args: string[], dbPath: string, port: number): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/watch-project.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DB_PATH: dbPath, AUTH_PASSCODE: "x", HOOKS_SECRET: "x", PORT: String(port) },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function projectRows(dbPath: string): { tag: string; cwd: string }[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`SELECT tag, cwd FROM projects ORDER BY tag`).all() as { tag: string; cwd: string }[];
  db.close();
  return rows;
}

function mkRepo(dir: string, opts: { gitFile?: boolean; files?: Record<string, string> } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  if (opts.gitFile) fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../.git/modules/x\n");
  else fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  for (const [name, content] of Object.entries(opts.files ?? {})) fs.writeFileSync(path.join(dir, name), content);
  return fs.realpathSync(dir);
}

async function scenarioWatchProjectDiscovery() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-umbrella-")));
  const port = await freePort();
  try {
    // An umbrella folder of independent repos at different depths — the
    // shape of a real mis-registration (KRONO/<group>/<repo>/.git) — plus a
    // repo nested inside another repo, a submodule-style .git *file*, a
    // dependency repo under node_modules, and a symlink back up the tree.
    const umbrella = path.join(root, "umbrella");
    const repoOne = mkRepo(path.join(umbrella, "group-a", "repo-one"));
    const innerPkg = mkRepo(path.join(umbrella, "group-a", "repo-one", "packages", "inner-pkg"), { gitFile: true });
    const repoTwo = mkRepo(path.join(umbrella, "group-b", "deep", "er", "repo-two"));
    mkRepo(path.join(umbrella, "group-b", "node_modules", "some-dep"));
    fs.symlinkSync(umbrella, path.join(umbrella, "group-a", "loop"));

    const db1 = path.join(root, "one.db");
    const r1 = runWatchProject([umbrella], db1, port);
    const rows1 = r1.code === 0 ? projectRows(db1) : [];
    const cwds1 = rows1.map((r) => r.cwd).sort();
    check("7.1 watching an umbrella folder registers every repo under it, at any depth, including a repo inside a repo",
      r1.code === 0 && JSON.stringify(cwds1) === JSON.stringify([innerPkg, repoOne, repoTwo].sort()),
      `exit=${r1.code}; registered=${JSON.stringify(rows1)}; stderr=${JSON.stringify(r1.stderr.slice(0, 300))}`);
    check("7.2 …with hooks written into each repo, none into the umbrella itself or the node_modules dependency",
      [repoOne, innerPkg, repoTwo].every((d) => fs.existsSync(path.join(d, ".claude", "settings.local.json"))) &&
        !fs.existsSync(path.join(umbrella, ".claude")) &&
        !fs.existsSync(path.join(umbrella, "group-b", "node_modules", "some-dep", ".claude")),
      `hooks present: ${JSON.stringify([repoOne, innerPkg, repoTwo].map((d) => fs.existsSync(path.join(d, ".claude"))))}`);
    check("7.3 repos with unique folder names keep their plain name as the tag",
      JSON.stringify(rows1.map((r) => r.tag).sort()) === JSON.stringify(["inner-pkg", "repo-one", "repo-two"]),
      `tags: ${JSON.stringify(rows1.map((r) => r.tag))}`);

    const db2 = path.join(root, "two.db");
    const r2 = runWatchProject([umbrella, "--force"], db2, port);
    const rows2 = r2.code === 0 ? projectRows(db2) : [];
    check("7.4 --force registers the umbrella folder itself as one project, skipping discovery",
      r2.code === 0 && rows2.length === 1 && rows2[0].cwd === fs.realpathSync(umbrella) &&
        fs.existsSync(path.join(umbrella, ".claude", "settings.local.json")),
      `exit=${r2.code}; registered=${JSON.stringify(rows2)}`);

    const plain = path.join(root, "plain-folder");
    fs.mkdirSync(plain);
    const db3 = path.join(root, "three.db");
    const r3 = runWatchProject([plain], db3, port);
    const rows3 = r3.code === 0 ? projectRows(db3) : [];
    check("7.5 a plain folder with no repo in it is still watched as-is",
      r3.code === 0 && rows3.length === 1 && rows3[0].tag === "plain-folder",
      `exit=${r3.code}; registered=${JSON.stringify(rows3)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioTagCollisions() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-collide-")));
  const port = await freePort();
  const dbPath = path.join(root, "scratch.db");
  try {
    const products = path.join(root, "products");
    const payApi = mkRepo(path.join(products, "pay", "api"), { files: { "package.json": JSON.stringify({ name: "@acme/payments-api" }) } });
    const billApi = mkRepo(path.join(products, "bill", "api"), { files: { "pyproject.toml": `[build-system]\nrequires = ["x"]\n\n[project]\nname = "billing-api"\nversion = "1.0"\n` } });
    const idApi = mkRepo(path.join(products, "id", "api"));
    const uniqueSvc = mkRepo(path.join(products, "svc", "unique-svc"));
    // Different folder names that a typed message can't tell apart.
    const authHr = mkRepo(path.join(products, "hr", "Auth_Central"));
    const authOther = mkRepo(path.join(products, "other", "auth-central"));

    const r1 = runWatchProject([products], dbPath, port);
    const byCwd = new Map((r1.code === 0 ? projectRows(dbPath) : []).map((r) => [r.cwd, r.tag]));
    const summary = JSON.stringify(Object.fromEntries(byCwd));

    check("8.1 colliding folder names take the package name from package.json (scope stripped) or pyproject.toml",
      byCwd.get(payApi) === "payments-api" && byCwd.get(billApi) === "billing-api",
      `exit=${r1.code}; ${summary}; stderr=${JSON.stringify(r1.stderr.slice(0, 300))}`);
    check("8.2 a colliding repo without a manifest falls back to its parent folder, and no repo keeps the bare colliding name",
      byCwd.get(idApi) === "api (id)" && ![...byCwd.values()].includes("api"),
      summary);
    check("8.3 a repo whose name doesn't collide keeps its plain name",
      byCwd.get(uniqueSvc) === "unique-svc", summary);
    check("8.4 names that differ only in case/separators count as colliding and are both disambiguated",
      byCwd.get(authHr) === "Auth_Central (hr)" && byCwd.get(authOther) === "auth-central (other)", summary);

    const r2 = runWatchProject([products], dbPath, port);
    const again = JSON.stringify(Object.fromEntries((r2.code === 0 ? projectRows(dbPath) : []).map((r) => [r.cwd, r.tag])));
    check("8.5 re-running on the same folder keeps every tag stable", r2.code === 0 && again === summary,
      `before=${summary}; after=${again}`);

    // A new repo colliding with a project registered earlier, elsewhere: the
    // existing one keeps its tag, the newcomer is disambiguated.
    const existingGateway = mkRepo(path.join(root, "elsewhere", "gateway"));
    registerProjectDirect(dbPath, "gateway", existingGateway);
    const newGateway = mkRepo(path.join(root, "later", "x", "gateway"));
    const r3 = runWatchProject([path.join(root, "later")], dbPath, port);
    const rows3 = new Map((r3.code === 0 ? projectRows(dbPath) : []).map((r) => [r.cwd, r.tag]));
    check("8.6 a repo colliding with an already-registered project is disambiguated; the existing one is untouched",
      rows3.get(existingGateway) === "gateway" && rows3.get(newGateway) === "gateway (x)",
      `exit=${r3.code}; ${JSON.stringify(Object.fromEntries(rows3))}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioAmbiguousOpen() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const payApi = fs.realpathSync(projectDir("pay", "api"));
    const billApi = fs.realpathSync(projectDir("bill", "api"));
    const idApi = fs.realpathSync(projectDir("id", "api"));
    const gateway = fs.realpathSync(projectDir("x", "gateway"));
    registerProjectDirect(srv.dbPath, "payments-api", payApi);
    registerProjectDirect(srv.dbPath, "billing-api", billApi);
    registerProjectDirect(srv.dbPath, "api (id)", idApi);
    registerProjectDirect(srv.dbPath, "gateway (x)", gateway);

    const ack1 = await c.request({ type: "chat", content: "open api check the logs" });
    const said1 = c.latest((e) => e.tag === "jarvis" && e.type === "chat")?.content ?? "";
    check("9.1 'open api' when three projects share the folder name 'api' is refused, listing each with its path",
      claudeInvocations().length === 0 && ack1?.reason === "ambiguous" &&
        ["payments-api", "billing-api", "api (id)"].every((t) => said1.includes(t)) && said1.includes("pay/api"),
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack1)}; said=${JSON.stringify(said1)}`);

    const ack2 = await c.request({ type: "chat", content: "open payments-api and billing-api run the tests" });
    check("9.2 naming two projects in one 'open' is refused rather than picking one",
      claudeInvocations().length === 0 && ack2?.reason === "ambiguous",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack2)}`);

    const ack3 = await c.request({ type: "chat", content: "open api (id) run the tests" });
    await until(() => claudeInvocations().length > 0, 2000);
    const inv3 = claudeInvocations();
    check("9.3 the full disambiguated tag opens exactly that project",
      inv3.length === 1 && inv3[0].startsWith(`cwd=${idApi} `) && inv3[0].includes("--print run the tests"),
      `claude invoked: ${JSON.stringify(inv3)}; ${describeAck(ack3)}`);

    resetClaudeLog();
    const ack4 = await c.request({ type: "chat", content: "open gateway check health" });
    await until(() => claudeInvocations().length > 0, 2000);
    const inv4 = claudeInvocations();
    check("9.4 a folder name only one project has resolves to it, even though its tag was disambiguated",
      inv4.length === 1 && inv4[0].startsWith(`cwd=${gateway} `),
      `claude invoked: ${JSON.stringify(inv4)}; ${describeAck(ack4)}`);

    // The session that launch produces must carry the registered tag, or a
    // second "open" would miss it and launch a duplicate.
    await sessionStartHook(srv.port, "session-gateway", gateway);
    resetClaudeLog();
    const ack5 = await c.request({ type: "chat", content: "open gateway (x)" });
    check("9.5 a session started in a registered project's folder takes that project's tag, so 'open' finds it running",
      claudeInvocations().length === 0 && ack5?.action === "already_open",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack5)}`);

    c.close();
  } finally {
    await killServer(srv);
  }
}

function markSessionDone(dbPath: string, sessionId: string): void {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.prepare(`UPDATE sessions SET status = 'done' WHERE id = ?`).run(sessionId);
  db.close();
}

async function scenarioReplyTarget() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    await sessionStartHook(srv.port, "session-identity", projectDir("identity"));
    await sessionStartHook(srv.port, "session-auth", projectDir("auth-central"));
    const toIdentity = (changedMsAgo?: number) => ({ sessionId: "session-identity", changedMsAgo });
    const invokedAfter = async (ms = 600) => {
      await until(() => claudeInvocations().length > 0, ms);
      return claudeInvocations();
    };

    const ack1 = await c.request({ type: "chat", content: "summarise the one you just described", replyToSession: toIdentity(5000) });
    const inv1 = await invokedAfter(2000);
    check("10.1 with two projects active, an unnamed message goes to the reply target's session",
      inv1.length === 1 && inv1[0].includes("--resume session-identity"),
      `claude invoked: ${JSON.stringify(inv1)}; ${describeAck(ack1)}`);

    // --- The target changed just before send ---
    resetClaudeLog();
    const ack2 = await c.request({ type: "chat", content: "carry on", replyToSession: toIdentity(1499) });
    const inv2 = await invokedAfter();
    check("10.2 a target that switched 1499ms before send is refused, nothing sent",
      inv2.length === 0 && ack2?.ok === false && ack2?.reason === "fresh",
      `claude invoked: ${JSON.stringify(inv2)}; ${describeAck(ack2)}`);

    const ack3 = await c.request({ type: "chat", content: "carry on", replyToSession: toIdentity(1500) });
    const inv3 = await invokedAfter(2000);
    check("10.3 …while one that has been showing for 1500ms is used",
      inv3.length === 1 && inv3[0].includes("--resume session-identity"),
      `claude invoked: ${JSON.stringify(inv3)}; ${describeAck(ack3)}`);

    resetClaudeLog();
    const ack4 = await c.request({ type: "chat", content: "carry on", replyToSession: toIdentity(undefined) });
    const inv4 = await invokedAfter();
    check("10.4 a target sent without its age is treated as just-switched and refused (fails closed)",
      inv4.length === 0 && ack4?.reason === "fresh",
      `claude invoked: ${JSON.stringify(inv4)}; ${describeAck(ack4)}`);

    const ack5 = await c.request({ type: "chat", content: "auth-central run the linter", replyToSession: toIdentity(100) });
    const inv5 = await invokedAfter(2000);
    check("10.5 naming a project explicitly wins over a target that just switched — routed there, not refused",
      inv5.length === 1 && inv5[0].includes("--resume session-auth") && ack5?.ok === true,
      `claude invoked: ${JSON.stringify(inv5)}; ${describeAck(ack5)}`);

    // --- The target's session has ended ---
    markSessionDone(srv.dbPath, "session-identity");
    resetClaudeLog();
    const ack6 = await c.request({ type: "chat", content: "and the other thing", replyToSession: toIdentity(5000) });
    const inv6 = await invokedAfter();
    check("10.6 a target whose session has ended is refused — not re-routed to auth-central, now the only active project",
      inv6.length === 0 && ack6?.reason === "target_ended",
      `claude invoked: ${JSON.stringify(inv6)}; ${describeAck(ack6)}`);

    const ack7 = await c.request({ type: "chat", content: "and the other thing", replyToSession: { sessionId: "session-never-existed", changedMsAgo: 5000 } });
    const inv7 = await invokedAfter();
    check("10.7 a target session the server has never heard of is refused the same way",
      inv7.length === 0 && ack7?.reason === "target_ended",
      `claude invoked: ${JSON.stringify(inv7)}; ${describeAck(ack7)}`);

    // --- The target never answers a permission request ---
    const gammaCwd = projectDir("gamma-svc");
    const deltaCwd = projectDir("delta-svc");
    await sessionStartHook(srv.port, "session-gamma", gammaCwd);
    await sessionStartHook(srv.port, "session-delta", deltaCwd);
    const hg = permissionHook(srv.port, "session-gamma", gammaCwd, "rm -rf gamma-cache");
    const hd = permissionHook(srv.port, "session-delta", deltaCwd, "rm -rf delta-cache");
    await c.toolUseIdFor("session-gamma", "rm -rf gamma-cache");
    await c.toolUseIdFor("session-delta", "rm -rf delta-cache");
    await sleep(FRESH_GUARD_WAIT_MS);
    const ack8 = await c.request({ type: "chat", content: "yes", replyToSession: { sessionId: "session-gamma", changedMsAgo: 5000 } });
    await sleep(300);
    check("10.8 a bare 'yes' with two requests waiting is still refused — the reply target never picks which one to approve",
      !hg.settled && !hd.settled && ack8?.ok === false,
      `gamma → ${hg.behavior() ?? "unresolved"}, delta → ${hd.behavior() ?? "unresolved"}; ${describeAck(ack8)}`);

    await c.request({ type: "decision", toolUseID: (await c.toolUseIdFor("session-gamma", "rm -rf gamma-cache"))!, decision: "deny" });
    await until(() => hg.settled, 1000);
    await stopHook(srv.port, "session-gamma", gammaCwd); // the denied turn winds up
    resetClaudeLog();
    const ack9 = await c.request({ type: "chat", content: "run the tests instead", replyToSession: { sessionId: "session-gamma", changedMsAgo: 5000 } });
    const inv9 = await invokedAfter(2000);
    check("10.9 free text aimed at gamma goes to gamma, and doesn't become guidance for delta's pending request",
      inv9.length === 1 && inv9[0].includes("--resume session-gamma") && !hd.settled,
      `claude invoked: ${JSON.stringify(inv9)}; delta settled=${hd.settled}; ${describeAck(ack9)}`);

    hd.abort();
    c.close();
  } finally {
    await killServer(srv);
  }
}

async function scenarioOpenChoice() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const tpA = fs.realpathSync(projectDir("NOBLEABLE-BE", "tenant-provisioning"));
    const tpB = fs.realpathSync(projectDir("SCRIBBER-REPOS", "tenant-provisioning"));
    registerProjectDirect(srv.dbPath, "tenant-provisioning (NOBLEABLE-BE)", tpA);
    registerProjectDirect(srv.dbPath, "tenant-provisioning (SCRIBBER-REPOS)", tpB);
    // identity is running and is what the composer targets — exactly the
    // state in which the answer used to be injected into identity.
    await sessionStartHook(srv.port, "session-identity", projectDir("identity"));
    const target = { sessionId: "session-identity", changedMsAgo: 5000 };
    const invoked = async (ms = 2000) => {
      await until(() => claudeInvocations().length > 0, ms);
      return claudeInvocations();
    };

    const ack1 = await c.request({ type: "chat", content: "open tenant-provisioning run the tests", replyToSession: target });
    const list1 = c.latest((e) => e.tag === "jarvis" && e.choiceId);
    check("11.1 an ambiguous open offers a numbered list with an id the answer must carry",
      ack1?.reason === "ambiguous" && typeof ack1?.choiceId === "string" && list1?.choices?.length === 2 &&
        list1.content.includes("1. tenant-provisioning") && claudeInvocations().length === 0,
      `${describeAck(ack1)}; list=${JSON.stringify(list1)}`);

    const ack2 = await c.request({ type: "chat", content: "2", openChoice: ack1?.choiceId, replyToSession: target });
    const inv2 = await invoked();
    check("11.2 answering '2' opens that project in a new session with the original instruction — not injected into identity",
      inv2.length === 1 && inv2[0].startsWith(`cwd=${tpB} `) && inv2[0].includes("--print run the tests") && !inv2[0].includes("--resume") &&
        ack2?.action === "launching",
      `claude invoked: ${JSON.stringify(inv2)}; ${describeAck(ack2)}`);

    resetClaudeLog();
    const ack3 = await c.request({ type: "chat", content: "1", openChoice: ack1?.choiceId, replyToSession: target });
    const inv3 = await (async () => { await sleep(500); return claudeInvocations(); })();
    check("11.3 a list that was already answered is refused — and the reply isn't sent to the reply target instead",
      inv3.length === 0 && ack3?.ok === false && ack3?.reason === "stale",
      `claude invoked: ${JSON.stringify(inv3)}; ${describeAck(ack3)}`);

    const ack4 = await c.request({ type: "chat", content: "open tenant-provisioning", replyToSession: target });
    const ack5 = await c.request({ type: "chat", content: "tenant-provisioning", openChoice: ack4?.choiceId, replyToSession: target });
    await sleep(500);
    check("11.4 an answer that still doesn't pick exactly one option gets the list again, sending nothing",
      claudeInvocations().length === 0 && ack5?.reason === "ambiguous" && typeof ack5?.choiceId === "string" && ack5.choiceId !== ack4?.choiceId,
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack5)}`);

    const ack6 = await c.request({ type: "chat", content: "tenant-provisioning (NOBLEABLE-BE) check the logs", openChoice: ack5?.choiceId, replyToSession: target });
    const inv6 = await invoked();
    check("11.5 answering with the full name and a new instruction opens that project with the new instruction",
      inv6.length === 1 && inv6[0].startsWith(`cwd=${tpA} `) && inv6[0].includes("--print check the logs"),
      `claude invoked: ${JSON.stringify(inv6)}; ${describeAck(ack6)}`);

    // The chosen project already has a session: completing the open routes
    // to it, exactly as "open <exact tag>" would.
    await sessionStartHook(srv.port, "session-tp-scribber", tpB);
    resetClaudeLog();
    const ack7 = await c.request({ type: "chat", content: "open tenant-provisioning status report", replyToSession: target });
    const ack8 = await c.request({ type: "chat", content: "2", openChoice: ack7?.choiceId, replyToSession: target });
    const inv8 = await invoked();
    check("11.6 picking a project that's already running routes to its session rather than launching another",
      inv8.length === 1 && inv8[0].includes("--resume session-tp-scribber") && inv8[0].includes("status report"),
      `claude invoked: ${JSON.stringify(inv8)}; ${describeAck(ack8)}`);

    // Without the list's id (✕ pressed), the same text is ordinary free text.
    resetClaudeLog();
    const ack9 = await c.request({ type: "chat", content: "open tenant-provisioning", replyToSession: target });
    const ack10 = await c.request({ type: "chat", content: "2", replyToSession: target });
    const inv10 = await invoked();
    check("11.7 once choosing mode is left, a reply is ordinary text for the reply target — the list only applies when named",
      typeof ack9?.choiceId === "string" && inv10.length === 1 && inv10[0].includes("--resume session-identity"),
      `claude invoked: ${JSON.stringify(inv10)}; ${describeAck(ack10)}`);

    c.close();
  } finally {
    await killServer(srv);
  }
}

function readPermissions(repo: string): { allow: string[]; ask: string[] } | undefined {
  const f = path.join(repo, ".claude", "settings.local.json");
  if (!fs.existsSync(f)) return undefined;
  return JSON.parse(fs.readFileSync(f, "utf8")).permissions;
}

async function scenarioPermissionDefaults() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-perms-")));
  const port = await freePort();
  const dbPath = path.join(root, "scratch.db");
  try {
    const mvnw = mkRepo(path.join(root, "repos", "svc-mvnw"), { files: { "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" } });
    const pomOnly = mkRepo(path.join(root, "repos", "svc-pom"), { files: { "pom.xml": "<project/>" } });
    const npmApp = mkRepo(path.join(root, "repos", "web-app"), { files: { "package.json": JSON.stringify({ scripts: { test: "jest", build: "vite build" } }) } });
    const npmBare = mkRepo(path.join(root, "repos", "web-lib"), { files: { "package.json": JSON.stringify({ name: "web-lib" }) } });
    const spaced = mkRepo(path.join(root, "repos", "my repo"));
    // A repo whose settings already have your own rules.
    const custom = mkRepo(path.join(root, "repos", "custom"));
    fs.mkdirSync(path.join(custom, ".claude"));
    fs.writeFileSync(path.join(custom, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(make lint)"], deny: ["Bash(git push *)"] } }));

    const r1 = runWatchProject([path.join(root, "repos")], dbPath, port);
    const pm = readPermissions(mvnw), pp = readPermissions(pomOnly), pn = readPermissions(npmApp), pb = readPermissions(npmBare);
    const ps = readPermissions(spaced), pc = readPermissions(custom);

    check("12.1 read-only git with the repo's exact path is allowed; the path is never a wildcard",
      r1.code === 0 && !!pm && pm.allow.includes(`Bash(git -C ${mvnw} log *)`) && pm.allow.includes(`Bash(git -C ${mvnw} status)`) &&
        ![pm, pp, pn, pb, ps, pc].some((p) => p && p.allow.some((r) => r.includes("git -C *"))),
      `exit=${r1.code}; stderr=${JSON.stringify(r1.stderr.slice(0, 200))}; sample=${JSON.stringify(pm?.allow.slice(0, 4))}`);
    check("12.2 build/test rules match the repo's tooling: ./mvnw, mvn, or npm scripts that exist — offline and exact only",
      !!pm && pm.allow.includes("Bash(./mvnw -o test)") && !pm.allow.some((r) => r.startsWith("Bash(./mvnw") && r.includes("*")) &&
        !!pp && pp.allow.includes("Bash(mvn -o package)") && !pp.allow.some((r) => r.includes("mvnw")) &&
        !!pn && pn.allow.includes("Bash(npm test)") && pn.allow.includes("Bash(npm run build)") &&
        !!pb && !pb.allow.some((r) => r.startsWith("Bash(npm")) && !pm.allow.some((r) => /Bash\(\.\/mvnw (test|compile|package)/.test(r)),
      `mvnw=${JSON.stringify(pm?.allow.filter((r) => r.includes("mvn")))}; npm=${JSON.stringify(pn?.allow.filter((r) => r.includes("npm")))}`);
    check("12.3 state-changing git, installs, deletes, curl, and git's --output flag always ask",
      !!pm && [`Bash(git -C ${mvnw} push)`, `Bash(git push *)`, `Bash(git -C ${mvnw} log * --output *)`, "Bash(npm install *)", "Bash(rm *)", "Bash(curl *)"]
        .every((r) => pm.ask.includes(r)) && !pm.allow.some((r) => /push|fetch|commit|curl|install/.test(r)),
      `ask sample=${JSON.stringify(pm?.ask.slice(0, 6))}`);
    check("12.4 a path containing a space gets the quoted spelling too",
      !!ps && ps.allow.includes(`Bash(git -C "${spaced}" status)`) && ps.allow.includes(`Bash(git -C ${spaced} status)`),
      JSON.stringify(ps?.allow.filter((r) => r.includes("status"))));
    check("12.5 rules already in the file are kept, including a stricter deny",
      !!pc && pc.allow.includes("Bash(make lint)") && (pc as any).deny?.includes("Bash(git push *)"),
      JSON.stringify(pc && { allow: pc.allow.slice(0, 2), deny: (pc as any).deny }));

    const before = JSON.stringify(readPermissions(mvnw));
    const r2 = runWatchProject([path.join(root, "repos")], dbPath, port);
    check("12.6 re-running adds nothing — no duplicate rules",
      r2.code === 0 && JSON.stringify(readPermissions(mvnw)) === before && r2.stdout.includes("already in place"),
      `stdout=${JSON.stringify(r2.stdout.slice(-120))}`);

    const optOut = mkRepo(path.join(root, "elsewhere", "opt-out"));
    const r3 = runWatchProject([optOut, "--no-permissions"], dbPath, port);
    check("12.7 --no-permissions writes the hooks but leaves permissions untouched",
      r3.code === 0 && readPermissions(optOut) === undefined && fs.existsSync(path.join(optOut, ".claude", "settings.local.json")),
      `exit=${r3.code}; perms=${JSON.stringify(readPermissions(optOut))}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function stopHook(port: number, sessionId: string, cwd: string): Promise<unknown> {
  return fetch(`http://localhost:${port}/api/hooks/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
    body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "Stop" }),
  }).then((r) => r.json());
}

async function scenarioStartingSession() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const svc = fs.realpathSync(projectDir("slow-svc"));
    registerProjectDirect(srv.dbPath, "slow-svc", svc);
    const settle = () => sleep(400);

    holdClaude(); // the launched claude stays mid-first-turn until released
    const ack1 = await c.request({ type: "chat", content: "open slow-svc run the migration" });
    await until(() => claudeInvocations().length > 0, 2000);
    const launch = claudeInvocations()[0] ?? "";
    const sid = /--session-id (\S+)/.exec(launch)?.[1];
    check("13.1 a launch picks its session ID up front and the session is registered immediately as starting",
      !!sid && sid === ack1?.sessionId && launch.includes("--print run the migration"),
      `launch=${JSON.stringify(launch)}; ${describeAck(ack1)}`);

    const ack2 = await c.request({ type: "chat", content: "open slow-svc also check the logs" });
    await settle();
    check("13.2 a second open with an instruction during the window queues it instead of launching a duplicate",
      claudeInvocations().length === 1 && ack2?.action === "queued" && ack2?.sessionId === sid,
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack2)}`);

    const ack3 = await c.request({ type: "chat", content: "open slow-svc" });
    await settle();
    check("13.3 a second open with no instruction reports it's still starting, launching nothing",
      claudeInvocations().length === 1 && ack3?.action === "starting",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack3)}`);

    const ack4 = await c.request({ type: "chat", content: "and summarise the result", replyToSession: { sessionId: sid, changedMsAgo: 5000 } });
    await settle();
    check("13.4 an unaddressed reply aimed at the starting session is queued too — nothing is run inside it mid-turn",
      claudeInvocations().length === 1 && ack4?.action === "queued",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack4)}`);

    await stopHook(srv.port, sid!, svc);
    await until(() => claudeInvocations().length > 1, 2000);
    const after = claudeInvocations().slice(1);
    check("13.5 when the first turn ends, everything queued goes in as one resumed turn, in order",
      after.length === 1 && after[0].includes(`--resume ${sid}`) &&
        after[0].indexOf("also check the logs") < after[0].indexOf("and summarise the result") && after[0].includes("also check the logs"),
      `after stop: ${JSON.stringify(after)}`);

    await stopHook(srv.port, sid!, svc); // the turn that delivered the queue ends
    resetClaudeLog();
    const ack6 = await c.request({ type: "chat", content: "open slow-svc run the tests" });
    await until(() => claudeInvocations().length > 0, 2000);
    check("13.6 once ready, it behaves as any open session: an instruction goes straight in",
      claudeInvocations().length === 1 && claudeInvocations()[0].includes(`--resume ${sid}`) && ack6?.action === "instructed",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack6)}`);
    releaseClaude();

    // A launch whose process dies before any turn ends doesn't block the
    // project forever, and says what it didn't deliver.
    const flaky = fs.realpathSync(projectDir("flaky-svc"));
    registerProjectDirect(srv.dbPath, "flaky-svc", flaky);
    resetClaudeLog();
    const ack7 = await c.request({ type: "chat", content: "open flaky-svc build it" });
    const ack8 = await c.request({ type: "chat", content: "open flaky-svc then deploy" });
    await until(() => !!c.latest((e) => e.tag === "jarvis" && String(e.content).includes("exited before finishing")), 6000);
    const notice = c.latest((e) => e.tag === "jarvis" && String(e.content).includes("exited before finishing"))?.content ?? "";
    resetClaudeLog();
    const ack9 = await c.request({ type: "chat", content: "open flaky-svc build it again" });
    await until(() => claudeInvocations().length > 0, 2000);
    const relaunch = claudeInvocations()[0] ?? "";
    check("13.7 a launch that dies before finishing a turn is closed, reports the queued message it didn't send, and can be opened again",
      ack8?.action === "queued" && notice.includes('"then deploy"') &&
        relaunch.includes("--session-id") && !relaunch.includes(String(ack7?.sessionId)) && ack9?.action === "launching",
      `notice=${JSON.stringify(notice)}; relaunch=${JSON.stringify(relaunch)}; ${describeAck(ack9)}`);

    c.close();
  } finally {
    releaseClaude();
    await killServer(srv);
  }
}

function userPromptSubmitHook(port: number, sessionId: string, cwd: string, prompt: string): Promise<unknown> {
  return fetch(`http://localhost:${port}/api/hooks/user-prompt-submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
    body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "UserPromptSubmit", prompt }),
  }).then((r) => r.json());
}

async function scenarioMidTurn() {
  resetClaudeLog();
  const srv = await startServer({ env: { BUSY_NUDGE_MS: "1500" } });
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const termCwd = projectDir("term-svc");
    const jarvisCwd = projectDir("jarvis-svc");
    const settle = () => sleep(400);
    const to = (sessionId: string) => ({ sessionId, changedMsAgo: 5000 });

    // --- A turn you started in a terminal (seen only through its hooks) ---
    await stopHook(srv.port, "session-term", termCwd); // an idle, known session
    await userPromptSubmitHook(srv.port, "session-term", termCwd, "refactor the auth module");
    resetClaudeLog();
    const ack1 = await c.request({ type: "chat", content: "also update the README", replyToSession: to("session-term") });
    await settle();
    check("14.1 a message for a session whose terminal turn is running waits — no second process",
      claudeInvocations().length === 0 && ack1?.action === "queued",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack1)}`);

    const ack2 = await c.request({ type: "chat", content: "open term-svc and bump the version" });
    await settle();
    check("14.2 …and so does a second one, including via open",
      claudeInvocations().length === 0 && ack2?.action === "queued",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack2)}`);

    await stopHook(srv.port, "session-term", termCwd);
    await until(() => claudeInvocations().length > 0, 2000);
    const inv3 = claudeInvocations();
    check("14.3 when the terminal turn ends, the waiting messages go in as one turn, in order",
      inv3.length === 1 && inv3[0].includes("--resume session-term") &&
        inv3[0].indexOf("also update the README") < inv3[0].indexOf("bump the version"),
      `claude invoked: ${JSON.stringify(inv3)}`);

    // --- Two turns started by Jarvis back to back ---
    await stopHook(srv.port, "session-term", termCwd); // the delivered turn ends
    await stopHook(srv.port, "session-jarvis", jarvisCwd);
    holdClaude();
    resetClaudeLog();
    await c.request({ type: "chat", content: "run the linter", replyToSession: to("session-jarvis") });
    await until(() => claudeInvocations().length > 0, 2000);
    const ack5 = await c.request({ type: "chat", content: "then fix what it finds", replyToSession: to("session-jarvis") });
    await settle();
    check("14.4 a second message while Jarvis's own resumed turn is running waits instead of starting a concurrent process",
      claudeInvocations().length === 1 && ack5?.action === "queued",
      `claude invoked: ${JSON.stringify(claudeInvocations())}; ${describeAck(ack5)}`);

    resetClaudeLog();
    releaseClaude(); // the process exits without ever sending Stop
    await until(() => claudeInvocations().length > 0, 3000);
    const inv6 = claudeInvocations();
    const notice6 = c.latest((e) => e.tag === "jarvis" && String(e.content).includes("ended without reporting back"))?.content ?? "";
    check("14.5 if that process exits without a Stop, the session is free: the waiting message is sent, and you're told why",
      inv6.length === 1 && inv6[0].includes("--resume session-jarvis") && inv6[0].includes("then fix what it finds") && !!notice6,
      `claude invoked: ${JSON.stringify(inv6)}; notice=${JSON.stringify(notice6)}`);

    // --- A turn that went quiet (e.g. interrupted, which never sends Stop) ---
    const quietCwd = projectDir("quiet-svc");
    await stopHook(srv.port, "session-quiet", quietCwd);
    await userPromptSubmitHook(srv.port, "session-quiet", quietCwd, "long task");
    resetClaudeLog();
    await c.request({ type: "chat", content: "open quiet-svc check the results" });
    await until(() => !!c.latest((e) => e.tag === "jarvis" && String(e.content).includes("no activity")), 9000);
    const nudge = c.latest((e) => e.tag === "jarvis" && String(e.content).includes("no activity"))?.content ?? "";
    check("14.6 a quiet session with a message waiting gets one notice offering 'send now' — and nothing is sent on a guess",
      nudge.includes("send now quiet-svc") && claudeInvocations().length === 0,
      `nudge=${JSON.stringify(nudge)}; claude invoked: ${JSON.stringify(claudeInvocations())}`);

    const ack7 = await c.request({ type: "chat", content: "send now quiet-svc" });
    await until(() => claudeInvocations().length > 0, 2000);
    const inv7 = claudeInvocations();
    check("14.7 'send now' delivers the waiting message anyway",
      inv7.length === 1 && inv7[0].includes("--resume session-quiet") && inv7[0].includes("check the results") && ack7?.action === "sent_now",
      `claude invoked: ${JSON.stringify(inv7)}; ${describeAck(ack7)}`);

    c.close();
  } finally {
    releaseClaude();
    await killServer(srv);
  }
}

async function scenarioStatus() {
  let srv = await startServer();
  try {
    const token = await login(srv.port);
    let c = await Client.open(srv.port, token);
    const idCwd = projectDir("st-identity");
    const acCwd = projectDir("st-auth");

    // Old sessions left stored as "running": each was mid-turn (a request
    // approved, turn carrying on) when Jarvis restarted, so no Stop arrived.
    await stopHook(srv.port, "old-auth-idle", acCwd); // an older, cleanly idle session
    for (const [sid, cwd] of [["old-identity", idCwd], ["newer-auth", acCwd]] as const) {
      const h = permissionHook(srv.port, sid, cwd, `echo ${sid}`);
      const id = await c.toolUseIdFor(sid, `echo ${sid}`);
      await c.request({ type: "decision", toolUseID: id, decision: "allow" });
      await until(() => h.settled, 1000);
    }
    c.close();
    await killServer(srv);
    srv = await startServer({ port: srv.port, dbPath: srv.dbPath });
    c = await Client.open(srv.port, token);

    // A fresh terminal session in identity is genuinely mid-turn.
    await userPromptSubmitHook(srv.port, "new-identity", idCwd, "refactor");

    const statusOf = async () => {
      await c.request({ type: "chat", content: "status" });
      return (c.latest((e) => e.tag === "jarvis" && String(e.content).startsWith("Active projects"))?.content ?? "") as string;
    };
    const st1 = await statusOf();
    const lines = st1.split("\n").filter((l) => l.startsWith("• "));
    check("15.1 status shows one line per project, however many sessions it has",
      lines.length === 2 && lines.filter((l) => l.includes("st-identity")).length === 1 && lines.filter((l) => l.includes("st-auth")).length === 1,
      JSON.stringify(st1));
    check("15.2 the working session is the one shown for identity, with the stale one folded into a count",
      lines.some((l) => l === "• st-identity — working, turn in progress (+1 older idle session)"), JSON.stringify(st1));
    check("15.3 a stale stored 'running' is never shown — auth-central is idle",
      lines.some((l) => l === "• st-auth — idle, ready for your next instruction (+1 older idle session)") && !/— running/.test(st1),
      JSON.stringify(st1));

    // Two sessions genuinely working in one project (two terminals).
    await userPromptSubmitHook(srv.port, "second-identity", idCwd, "write tests");
    const st2 = await statusOf();
    check("15.4 two sessions truly active in one project are both listed",
      st2.includes("• st-identity — 2 sessions active (+1 older idle session):") && st2.includes("new-iden") && st2.includes("second-i"),
      JSON.stringify(st2));
    c.close();
  } finally {
    await killServer(srv);
  }
}

function askHook(port: number, sessionId: string, cwd: string, questions: unknown[]): HookCall {
  const ac = new AbortController();
  const call: HookCall = {
    settled: false,
    abort: () => ac.abort(),
    behavior: () => call.result?.hookSpecificOutput?.decision?.behavior,
  };
  fetch(`http://localhost:${port}/api/hooks/permission-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
    body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } }),
    signal: ac.signal,
  })
    .then((r) => r.json())
    .then((json) => { call.settled = true; call.result = json; }, (err) => { call.settled = true; call.error = err; });
  return call;
}

async function scenarioQuestions() {
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const cwd = projectDir("q-identity");
    const trust = {
      question: "How do requests reach the identity service, and who sets X-User-ID?",
      header: "Trust model",
      multiSelect: false,
      options: [
        { label: "Gateway verifies JWT", description: "An API gateway checks the token and sets X-User-ID." },
        { label: "Identity verifies JWT", description: "Clients call identity directly with a bearer token." },
        { label: "Not decided yet", description: "Stop here." },
      ],
    };
    const answersOf = (h: HookCall) => h.result?.hookSpecificOutput?.decision?.updatedInput?.answers;
    const ask = async (sid: string, qs: unknown[]) => {
      const h = askHook(srv.port, sid, cwd, qs);
      const id = await c.toolUseIdFor(sid, (qs[0] as any).question.slice(0, 30));
      await sleep(FRESH_GUARD_WAIT_MS);
      return { h, id: id! };
    };

    const a = await ask("q1", [trust]);
    const snap = c.latest((e) => e.type === "permissions");
    const item = snap?.items?.find((i: any) => i.toolUseID === a.id);
    const card = c.latest((e) => e.type === "permission_request" && e.toolUseID === a.id);
    check("16.1 an AskUserQuestion reaches the phone as its real question and options, not 'Permission requested… YES/NO'",
      item?.questions?.[0]?.options?.length === 3 && item.questions[0].header === "Trust model" &&
        item.questions[0].options[1].description.includes("bearer token") &&
        String(card?.content).startsWith("Claude is asking (Trust model):") && !String(card?.content).includes("YES/NO"),
      `item=${JSON.stringify(item)}; content=${JSON.stringify(card?.content)}`);

    const ack2 = await c.request({ type: "decision", toolUseID: a.id, decision: "allow" });
    await sleep(300);
    const ack2b = await c.request({ type: "chat", content: "yes", replyTo: a.id });
    await sleep(300);
    check("16.2 a generic Approve, or a typed 'yes', on a question is refused — it's still waiting for an answer",
      !a.h.settled && ack2?.reason === "needs_answer" && ack2b?.reason === "needs_answer",
      `hook settled=${a.h.settled}; ${describeAck(ack2)}; ${describeAck(ack2b)}`);

    const bad = await c.request({ type: "answer", toolUseID: a.id, answers: {} });
    const ack3 = await c.request({ type: "answer", toolUseID: a.id, answers: { [trust.question]: "Identity verifies JWT" } });
    await until(() => a.h.settled, 1000);
    const dec = a.h.result?.hookSpecificOutput?.decision;
    check("16.3 answering from the card allows the call with the answer keyed by question text — the shape Claude reads",
      bad?.reason === "needs_answer" && ack3?.action === "answered" && dec?.behavior === "allow" &&
        answersOf(a.h)?.[trust.question] === "Identity verifies JWT" && dec?.updatedInput?.questions?.[0]?.header === "Trust model",
      `decision=${JSON.stringify(dec)}; ${describeAck(bad)}; ${describeAck(ack3)}`);
    await sleep(200);
    const status3 = c.latest((e) => e.type === "permissions")?.items?.find((i: any) => i.toolUseID === a.id)?.status;
    check("16.4 …and the card is then marked answered", status3 === "answered", `status=${status3}`);

    const b = await ask("q2", [trust]);
    await c.request({ type: "chat", content: "2", replyTo: b.id });
    await until(() => b.h.settled, 1000);
    const cc = await ask("q3", [trust]);
    await c.request({ type: "chat", content: "full report", replyTo: cc.id });
    await until(() => cc.h.settled, 1000);
    check("16.5 a typed reply answers it: an option number picks that option, other text is a free-text answer",
      answersOf(b.h)?.[trust.question] === "Identity verifies JWT" && answersOf(cc.h)?.[trust.question] === "full report",
      `number→${JSON.stringify(answersOf(b.h))}; text→${JSON.stringify(answersOf(cc.h))}`);

    const multi = { question: "Which checks should run?", header: "Checks", multiSelect: true,
      options: [{ label: "Lint" }, { label: "Unit tests" }, { label: "Integration tests" }] };
    const m = await ask("q4", [multi]);
    const badM = await c.request({ type: "answer", toolUseID: m.id, answers: { [multi.question]: ["Lint", "Fuzzing"] } });
    await c.request({ type: "chat", content: "1,3", replyTo: m.id });
    await until(() => m.h.settled, 1000);
    check("16.6 multi-select answers are arrays of option labels; a label that isn't an option is refused",
      badM?.reason === "needs_answer" && JSON.stringify(answersOf(m.h)?.[multi.question]) === JSON.stringify(["Lint", "Integration tests"]),
      `answers=${JSON.stringify(answersOf(m.h))}; ${describeAck(badM)}`);

    const t = await ask("q5", [trust]);
    await c.request({ type: "decision", toolUseID: t.id, decision: "allow", answerInTerminal: true });
    await until(() => t.h.settled, 1000);
    const d = await ask("q6", [trust]);
    await c.request({ type: "decision", toolUseID: d.id, decision: "deny" });
    await until(() => d.h.settled, 1000);
    const tDec = t.h.result?.hookSpecificOutput?.decision, dDec = d.h.result?.hookSpecificOutput?.decision;
    check("16.7 'Answer in terminal' passes it on unanswered (a plain allow), and Dismiss denies it without stopping Claude",
      tDec?.behavior === "allow" && tDec?.updatedInput === undefined &&
        dDec?.behavior === "deny" && dDec?.interrupt === false && String(dDec?.message).includes("dismissed"),
      `terminal=${JSON.stringify(tDec)}; dismiss=${JSON.stringify(dDec)}`);

    const two = await ask("q7", [trust, multi]);
    const ack8 = await c.request({ type: "chat", content: "2", replyTo: two.id });
    await sleep(300);
    const ack8b = await c.request({ type: "answer", toolUseID: two.id, answers: { [trust.question]: "Not decided yet", [multi.question]: ["Unit tests"] } });
    await until(() => two.h.settled, 1000);
    check("16.8 several questions at once can't be answered by one typed reply — the card answers them all together",
      ack8?.reason === "needs_answer" && ack8b?.action === "answered" &&
        answersOf(two.h)?.[trust.question] === "Not decided yet" && JSON.stringify(answersOf(two.h)?.[multi.question]) === '["Unit tests"]',
      `${describeAck(ack8)}; answers=${JSON.stringify(answersOf(two.h))}`);

    const bash = permissionHook(srv.port, "q8", cwd, "echo still-normal");
    const bashId = await c.toolUseIdFor("q8", "echo still-normal");
    await c.request({ type: "decision", toolUseID: bashId, decision: "allow" });
    await until(() => bash.settled, 1000);
    check("16.9 ordinary permission requests are unchanged: Approve allows them with no answers attached",
      bash.behavior() === "allow" && bash.result?.hookSpecificOutput?.decision?.updatedInput === undefined,
      JSON.stringify(bash.result));
    c.close();
  } finally {
    await killServer(srv);
  }
}

async function scenarioQueueControl() {
  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const cwd = projectDir("qc-svc");
    const to = { sessionId: "qc-session", changedMsAgo: 5000 };
    const queueFor = (sid: string) => (c.latest((e) => e.type === "queue")?.sessions ?? []).find((s: any) => s.sessionId === sid)?.items ?? [];

    await stopHook(srv.port, "qc-session", cwd);
    await userPromptSubmitHook(srv.port, "qc-session", cwd, "long refactor"); // a terminal turn is running
    await c.request({ type: "chat", content: "find out bottle neck in identity", replyToSession: to });
    await c.request({ type: "chat", content: "full report", replyToSession: to });
    await sleep(200);
    const items = queueFor("qc-session");
    await c.request({ type: "chat", content: "status" });
    const st = c.latest((e) => e.tag === "jarvis" && String(e.content).startsWith("Active projects"))?.content ?? "";
    check("17.1 the queue shows each waiting message's actual text, with an ID — and so does status",
      items.length === 2 && items[0].text === "find out bottle neck in identity" && items[1].text === "full report" && !!items[0].id &&
        st.includes('1. "find out bottle neck in identity"') && st.includes('2. "full report"'),
      `queue=${JSON.stringify(items)}; status=${JSON.stringify(st)}`);

    const fresh = await Client.open(srv.port, token);
    const onConnect = await fresh.waitFor((e) => e.type === "queue");
    check("17.2 a client that connects later gets the queue too",
      onConnect?.sessions?.[0]?.items?.length === 2, JSON.stringify(onConnect));
    fresh.close();

    const ack3 = await c.request({ type: "unqueue", queueItemId: items[1].id });
    await sleep(200);
    check("17.3 removing one message takes it off the queue and leaves the rest",
      ack3?.action === "unqueued" && JSON.stringify(queueFor("qc-session").map((i: any) => i.text)) === '["find out bottle neck in identity"]',
      `${describeAck(ack3)}; queue=${JSON.stringify(queueFor("qc-session"))}`);

    await stopHook(srv.port, "qc-session", cwd); // the terminal turn ends
    await until(() => claudeInvocations().length > 0, 2000);
    const inv = claudeInvocations();
    check("17.4 when the session is free, only what's still queued is sent — the removed message never goes in",
      inv.length === 1 && inv[0].includes("find out bottle neck in identity") && !inv[0].includes("full report") && queueFor("qc-session").length === 0,
      `claude invoked: ${JSON.stringify(inv)}; queue=${JSON.stringify(queueFor("qc-session"))}`);

    const ack5 = await c.request({ type: "unqueue", queueItemId: items[0].id });
    check("17.5 removing a message that has already been sent is refused, not reported as removed",
      ack5?.ok === false && ack5?.reason === "stale", describeAck(ack5));

    // Take everything back: nothing is sent at all.
    await stopHook(srv.port, "qc-session", cwd); // the delivered turn ends
    await userPromptSubmitHook(srv.port, "qc-session", cwd, "another terminal turn");
    await c.request({ type: "chat", content: "never mind this one", replyToSession: to });
    await sleep(200);
    const only = queueFor("qc-session")[0];
    await c.request({ type: "unqueue", queueItemId: only?.id });
    resetClaudeLog();
    await stopHook(srv.port, "qc-session", cwd);
    await sleep(600);
    check("17.6 with every queued message removed, the turn ending sends nothing",
      !!only && claudeInvocations().length === 0 && queueFor("qc-session").length === 0,
      `claude invoked: ${JSON.stringify(claudeInvocations())}`);

    // A launch that dies: a removed message isn't reported as lost.
    const flaky = fs.realpathSync(projectDir("qc-flaky"));
    registerProjectDirect(srv.dbPath, "qc-flaky", flaky);
    holdClaude();
    const launch = await c.request({ type: "chat", content: "open qc-flaky build it" });
    await c.request({ type: "chat", content: "open qc-flaky keep this" });
    await c.request({ type: "chat", content: "open qc-flaky drop this" });
    await sleep(200);
    const drop = queueFor(launch?.sessionId).find((i: any) => i.text === "drop this");
    await c.request({ type: "unqueue", queueItemId: drop?.id });
    releaseClaude();
    await until(() => !!c.latest((e) => e.tag === "jarvis" && String(e.content).includes("exited before finishing")), 4000);
    const lost = c.latest((e) => e.tag === "jarvis" && String(e.content).includes("exited before finishing"))?.content ?? "";
    check("17.7 if a launch dies, the lost-message report lists only what was still queued",
      lost.includes('"keep this"') && !lost.includes("drop this"), JSON.stringify(lost));
    c.close();
  } finally {
    releaseClaude();
    await killServer(srv);
  }
}

function toolHook(port: number, sessionId: string, cwd: string, toolName: string, toolInput: unknown): HookCall {
  const ac = new AbortController();
  const call: HookCall = { settled: false, abort: () => ac.abort(), behavior: () => call.result?.hookSpecificOutput?.decision?.behavior };
  fetch(`http://localhost:${port}/api/hooks/permission-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_SECRET}` },
    body: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "PermissionRequest", tool_name: toolName, tool_input: toolInput }),
    signal: ac.signal,
  }).then((r) => r.json()).then((j) => { call.settled = true; call.result = j; }, (e) => { call.settled = true; call.error = e; });
  return call;
}

async function scenarioGatingAndCards() {
  // --- Part 1: the rollout — reads beyond the repo free, writes never ---
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-gate-")));
  const port = await freePort();
  try {
    const umbrella = path.join(root, "work");
    const mvnRepo = mkRepo(path.join(umbrella, "svc-a"), { files: { "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" } });
    const nodeRepo = mkRepo(path.join(umbrella, "web-b"), { files: { "package.json": "{}" } });
    const single = mkRepo(path.join(root, "solo-repo"));
    runWatchProject([umbrella], path.join(root, "a.db"), port);
    runWatchProject([single], path.join(root, "b.db"), port);
    const perms = (repo: string) => JSON.parse(fs.readFileSync(path.join(repo, ".claude", "settings.local.json"), "utf8")).permissions;
    const m2 = path.join(os.homedir(), ".m2", "repository");
    const hasM2 = fs.existsSync(m2);
    const pa = perms(mvnRepo), pb = perms(nodeRepo), ps = perms(single);
    check("18.1 repos found under a folder can read their siblings without a prompt (the folder is an additional directory)",
      pa.additionalDirectories?.includes(fs.realpathSync(umbrella)) && pb.additionalDirectories?.includes(fs.realpathSync(umbrella)),
      JSON.stringify({ a: pa.additionalDirectories, b: pb.additionalDirectories }));
    check("18.2 Maven repos can also read the local Maven cache; others and single-repo watches get no extra folders",
      (!hasM2 || pa.additionalDirectories.includes(fs.realpathSync(m2))) && !pb.additionalDirectories.some((d: string) => d.includes(".m2")) &&
        (ps.additionalDirectories ?? []).length === 0,
      JSON.stringify({ a: pa.additionalDirectories, b: pb.additionalDirectories, solo: ps.additionalDirectories }));
    check("18.3 Claude's edit tools are ask rules in every repo, so a wider readable area never loosens writes",
      [pa, pb, ps].every((p) => ["Edit", "Write", "NotebookEdit"].every((t) => p.ask.includes(t))),
      JSON.stringify(pa.ask.slice(0, 4)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  resetClaudeLog();
  const srv = await startServer();
  try {
    const token = await login(srv.port);
    const c = await Client.open(srv.port, token);
    const cwd = fs.realpathSync(projectDir("card-svc"));
    registerProjectDirect(srv.dbPath, "card-svc", cwd);
    await c.request({ type: "chat", content: "open card-svc run the checks" });
    await until(() => claudeInvocations().length > 0, 2000);
    const launch = claudeInvocations()[0] ?? "";
    const sid = /--session-id (\S+)/.exec(launch)?.[1];
    await stopHook(srv.port, sid!, cwd);
    resetClaudeLog();
    await c.request({ type: "chat", content: "then summarise", replyToSession: { sessionId: sid, changedMsAgo: 5000 } });
    await until(() => claudeInvocations().length > 0, 2000);
    const resume = claudeInvocations()[0] ?? "";
    check("18.4 every claude Jarvis starts — launch and resume — is pinned to the default permission mode",
      launch.includes("--permission-mode default") && resume.includes("--permission-mode default") && resume.includes(`--resume ${sid}`),
      `launch=${JSON.stringify(launch)}; resume=${JSON.stringify(resume)}`);

    // --- Part 2: the card says what it wants to do, in plain English ---
    const summaryOf = async (sid2: string, marker: string, tool: string, input: unknown) => {
      const h = toolHook(srv.port, sid2, cwd, tool, input);
      const id = await c.toolUseIdFor(sid2, marker);
      const item = c.latest((e) => e.type === "permissions")?.items?.find((i: any) => i.toolUseID === id);
      const card = c.latest((e) => e.type === "permission_request" && e.toolUseID === id);
      h.abort();
      return { summary: item?.summary, content: String(card?.content ?? "") };
    };
    const push = await summaryOf("card-1", "git push origin main", "Bash", { command: "git push origin main", description: "push the release branch." });
    check("18.5 the card leads with Claude's own one-line description, in sentence case, not the raw command",
      push.summary?.title === "Push the release branch" && !push.content.includes("Permission requested") && !push.content.includes("YES/NO") &&
        push.content.startsWith("Push the release branch"),
      JSON.stringify(push));
    check("18.6 Jarvis tags what the command actually does, independent of the description",
      JSON.stringify(push.summary?.tags) === JSON.stringify(["pushes to a remote"]) && push.summary?.detail === "git push origin main",
      JSON.stringify(push.summary));

    const sneaky = await summaryOf("card-2", "rm -rf build", "Bash", { command: "npm test && rm -rf build", description: "Run the unit tests" });
    check("18.7 a harmless-sounding description doesn't hide a risky command — the tags still say it deletes files",
      sneaky.summary?.title === "Run the unit tests" && sneaky.summary?.tags.includes("deletes files"), JSON.stringify(sneaky.summary));

    const quoted = await summaryOf("card-3", "<release>", "Bash", { command: `grep -n "java.version\\|<release>" pom.xml`, description: "Find the Java version" });
    const bare = await summaryOf("card-4", "curl -s https://api.example.com", "Bash", { command: "curl -s https://api.example.com/health" });
    check("18.8 a '>' inside quotes isn't read as a redirect; a command with no description still gets a sensible gist",
      quoted.summary?.tags.length === 0 && bare.summary?.title === "Make a web request" && bare.summary?.tags.includes("goes online"),
      JSON.stringify({ quoted: quoted.summary, bare: bare.summary }));

    const edit = await summaryOf("card-5", "Edit src/app.ts", "Edit", { file_path: path.join(cwd, "src", "app.ts"), old_string: "a", new_string: "b" });
    check("18.9 an edit reads 'Edit <path relative to the project>' and is tagged as a write",
      edit.summary?.title === "Edit src/app.ts" && edit.summary?.tags.includes("writes files"), JSON.stringify(edit.summary));
    c.close();
  } finally {
    await killServer(srv);
  }
}

// ---------- main ----------

async function main() {
  const pushPort = await startPushEndpoint();
  const scenarios: [string, () => Promise<void>][] = [
    ["1. Registry race (same project, back-to-back requests)", scenarioCoreRace],
    ["2. Stale after restart / dropped hook connection", scenarioRestart],
    ["3. Ghost WebSocket + reconnect resync", () => scenarioGhostAndResync(pushPort)],
    ["4. Reply parsing across projects", scenarioParsing],
    ["5. Several sessions in one project", scenarioSameProjectSessions],
    ["6. Open a project JARVIS hasn't started itself", scenarioOpenProject],
    ["7. watch-project.ts discovers every nested repo", scenarioWatchProjectDiscovery],
    ["8. Tag collisions resolved at registration", scenarioTagCollisions],
    ["9. Ambiguous 'open' is refused, never guessed", scenarioAmbiguousOpen],
    ["10. Composer reply target", scenarioReplyTarget],
    ["11. Answering a 'which project?' list", scenarioOpenChoice],
    ["12. Default permission rules from watch-project", scenarioPermissionDefaults],
    ["13. A session that's still starting counts as open", scenarioStartingSession],
    ["14. Messages for a session mid-turn wait for it", scenarioMidTurn],
    ["15. Status: one line per project, live state only", scenarioStatus],
    ["16. Claude's questions are answered, not approved", scenarioQuestions],
    ["17. Seeing and removing queued messages", scenarioQueueControl],
    ["18. Writes stay gated everywhere; cards in plain English", scenarioGatingAndCards],
  ];
  for (const [title, run] of scenarios) {
    currentScenario = title;
    console.log(`\n${title}`);
    try {
      await run();
    } catch (err) {
      check("scenario crashed", false, err instanceof Error ? err.stack : String(err));
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main();
