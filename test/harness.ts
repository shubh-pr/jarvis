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
  `#!/bin/sh\necho "cwd=$(pwd -P) $*" >> "$FAKE_CLAUDE_LOG"\n`,
  { mode: 0o755 },
);

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

async function startServer(opts: { port?: number; dbPath?: string } = {}): Promise<Server> {
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
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
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
