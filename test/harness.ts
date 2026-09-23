// End-to-end harness for the approval loop. Spawns a real JARVIS server
// (fresh SQLite DB, fake `claude` on PATH, fake HTTPS push endpoint) and
// drives it the way Claude Code hooks and the PWA do, asserting on what
// actually reaches the blocked hook call.
//
//   npm run test:harness
//
// Only things that need a real `claude` session (hook timeout caps, laptop
// sleep/wake) are out of scope here.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { WebSocket } from "ws";

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
  `#!/bin/sh\necho "$*" >> "$FAKE_CLAUDE_LOG"\n`,
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

// ---------- main ----------

async function main() {
  const pushPort = await startPushEndpoint();
  const scenarios: [string, () => Promise<void>][] = [
    ["1. Registry race (same project, back-to-back requests)", scenarioCoreRace],
    ["2. Stale after restart / dropped hook connection", scenarioRestart],
    ["3. Ghost WebSocket + reconnect resync", () => scenarioGhostAndResync(pushPort)],
    ["4. Reply parsing across projects", scenarioParsing],
    ["5. Several sessions in one project", scenarioSameProjectSessions],
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
