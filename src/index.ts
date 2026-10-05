import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";
import {
  createAuthToken,
  isValidAuthToken,
  addPushSubscription,
  removePushSubscription,
  markPendingPermissionsStale,
  clearStartingSessions,
  repairSessionFolders,
} from "./db.js";
import { serveStatic } from "./staticServer.js";
import { attachWebSocketServer } from "./wsServer.js";
import { broadcastPush } from "./push.js";
import { resolvePermission } from "./agent/permissions.js";
import { handleInbound, restoreQueueLeftByRestart } from "./agent/router.js";
import { listProjectHistories, projectBlocks, projectMessages } from "./agent/history.js";
import { searchHistory } from "./agent/search.js";
import { handleSessionStart, handleUserPromptSubmit, handlePermissionRequest, handleStop, handleToolStart, handleToolEnd } from "./hooks/routes.js";
import { adapterFor, getAdapter } from "./agent/adapters/index.js";
import { recordRateLimits } from "./usage.js";

// The hook URLs below are the ones watch-project has always written into
// Claude Code's settings, so events arriving on them are Claude's.
const hookAgent = getAdapter("claude");

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// An activity hook's body, or null if it can't be used. Unlike readJsonBody
// it never rejects and never cuts the connection: an oversized body (a
// PostToolUse can carry a large tool result) is read to the end and dropped,
// so the agent still gets its normal empty reply.
function readActivityBody(req: http.IncomingMessage): Promise<any | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 2_000_000) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > 2_000_000) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const ACTIVITY_HOOKS: Record<string, (adapter: typeof hookAgent, body: any) => void> = {
  "/api/hooks/pre-tool-use": handleToolStart,
  "/api/hooks/post-tool-use": handleToolEnd,
};

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !isValidAuthToken(token)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function requireHookAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const header = req.headers.authorization ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (secret !== config.hooksSecret) {
    sendJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    sendJson(res, 200, { status: "ok", service: "jarvis" });
    return;
  }

  if (req.url === "/api/login" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => {
        if (body?.passcode !== config.authPasscode) {
          sendJson(res, 401, { error: "Invalid passcode" });
          return;
        }
        const token = crypto.randomBytes(32).toString("hex");
        createAuthToken(token);
        sendJson(res, 200, { token });
      })
      .catch(() => sendJson(res, 400, { error: "Invalid request body" }));
    return;
  }

  if (req.url === "/api/push/vapid-public-key" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { key: config.vapidPublicKey });
    return;
  }

  if (req.url === "/api/push/subscribe" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => {
        const endpoint = body?.endpoint;
        const p256dh = body?.keys?.p256dh;
        const auth = body?.keys?.auth;
        if (!endpoint || !p256dh || !auth) {
          sendJson(res, 400, { error: "Invalid subscription" });
          return;
        }
        addPushSubscription(endpoint, p256dh, auth);
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 400, { error: "Invalid request body" }));
    return;
  }

  if (req.url === "/api/push/unsubscribe" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => {
        if (body?.endpoint) removePushSubscription(body.endpoint);
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 400, { error: "Invalid request body" }));
    return;
  }

  if (req.url === "/api/push/test" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    broadcastPush({
      title: "JARVIS",
      body: "Test push notification — if you see this with the app closed, it works.",
      url: "/",
    }).then(() => sendJson(res, 200, { ok: true }));
    return;
  }

  if (req.url === "/api/hooks/session-start" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => handleSessionStart(hookAgent, body))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => {
        console.error("session-start hook failed:", err);
        sendJson(res, 400, { error: "Invalid request body" });
      });
    return;
  }

  if (req.url === "/api/hooks/user-prompt-submit" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => handleUserPromptSubmit(hookAgent, body))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => {
        console.error("user-prompt-submit hook failed:", err);
        sendJson(res, 400, { error: "Invalid request body" });
      });
    return;
  }

  if (req.url === "/api/hooks/permission-request" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    // res "close" before the response is written means the agent dropped
    // the hook call — the request must not stay answerable after that.
    const connection = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) connection.abort();
    });
    readJsonBody(req)
      .then((body) => handlePermissionRequest(hookAgent, body, connection.signal))
      .then((result) => {
        if (result) sendJson(res, 200, result);
      })
      .catch((err) => {
        console.error("permission-request hook failed:", err);
        sendJson(res, 400, { error: "Invalid request body" });
      });
    return;
  }

  // Observe-only activity hooks — see "Observe-only hooks" in ARCHITECTURE.md.
  // PreToolUse holds the tool call until it gets a reply, and a decision in
  // that reply would override your approvals. So the reply is fixed: 200 with
  // an empty body (no output, no decision), sent before the event is even
  // looked at, whatever the body holds — malformed, oversized or otherwise.
  // A handler can't change it: it runs only after the reply has gone.
  // Plan usage from the status line (usage.ts). Like the activity hooks it
  // only ever gets an empty 200, so a status line never waits on Jarvis.
  if (req.url === "/api/hooks/usage" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    readActivityBody(req).then((body) => {
      res.writeHead(200);
      res.end();
      if (body?.rate_limits) recordRateLimits(body.rate_limits);
    });
    return;
  }

  const activityHandler = req.method === "POST" ? ACTIVITY_HOOKS[req.url ?? ""] : undefined;
  if (activityHandler) {
    if (!requireHookAuth(req, res)) return;
    readActivityBody(req).then((body) => {
      res.writeHead(200);
      res.end();
      if (body === null) return;
      try {
        activityHandler(hookAgent, body);
      } catch (err) {
        console.error("activity hook failed:", err);
      }
    });
    return;
  }

  if (req.url === "/api/hooks/stop" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => handleStop(hookAgent, body))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => {
        console.error("stop hook failed:", err);
        sendJson(res, 400, { error: "Invalid request body" });
      });
    return;
  }

  if (req.url === "/api/agent/resolve" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => {
        if (
          typeof body?.toolUseID !== "string" ||
          (body.decision !== "allow" && body.decision !== "deny")
        ) {
          sendJson(res, 400, { error: "Invalid resolve request" });
          return;
        }
        const outcome = resolvePermission(
          body.toolUseID,
          body.decision,
          typeof body.message === "string" ? body.message : undefined,
          Boolean(body.interrupt),
        );
        sendJson(res, outcome.ok ? 200 : outcome.reason === "stale" ? 409 : 404, outcome);
      })
      .catch(() => sendJson(res, 400, { error: "Invalid request body" }));
    return;
  }

  // Per-project history: /api/projects, and ?key=<project path> for one
  // project's blocks or messages, optionally within [from, to] (epoch ms).
  const url = new URL(req.url ?? "/", "http://localhost");
  // Search across all history, or one project with ?key=<project path>.
  if (req.method === "GET" && url.pathname === "/api/search") {
    if (!requireAuth(req, res)) return;
    return sendJson(res, 200, searchHistory(url.searchParams.get("q") ?? "", url.searchParams.get("key") || undefined));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/projects")) {
    if (!requireAuth(req, res)) return;
    const key = url.searchParams.get("key") ?? "";
    const num = (name: string) => {
      const v = url.searchParams.get(name);
      return v !== null && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    if (url.pathname === "/api/projects") return sendJson(res, 200, { projects: listProjectHistories() });
    if (!key) return sendJson(res, 400, { error: "Missing project key" });
    if (url.pathname === "/api/projects/blocks") return sendJson(res, 200, { blocks: projectBlocks(key, num("from"), num("to")) });
    if (url.pathname === "/api/projects/messages") return sendJson(res, 200, { messages: projectMessages(key, num("from"), num("to")) });
    return sendJson(res, 404, { error: "Not found" });
  }

  if (serveStatic(req, res)) return;

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// A permission-request hook connection can legitimately stay open for a long
// time waiting on a phone reply — never let Node's own timeout kill it.
server.requestTimeout = 0;
server.headersTimeout = 0;

// Hook calls from before this process started died with the old process;
// record them as stale so replies to them are refused rather than
// reinterpreted as new instructions.
const staleCount = markPendingPermissionsStale();
if (staleCount) console.log(`Marked ${staleCount} permission request(s) from a previous run as stale.`);
clearStartingSessions();
for (const f of repairSessionFolders((s) => adapterFor(s).startFolder(s.transcript_path))) console.log(`Session ${f.id.slice(0, 8)}: folder corrected from ${f.from} to ${f.to} (from its transcript).`);

attachWebSocketServer(server, handleInbound);

server.listen(config.port, () => {
  console.log(`JARVIS listening on http://localhost:${config.port}`);
  restoreQueueLeftByRestart();
});
