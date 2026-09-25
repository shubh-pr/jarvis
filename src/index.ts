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
} from "./db.js";
import { serveStatic } from "./staticServer.js";
import { attachWebSocketServer } from "./wsServer.js";
import { broadcastPush } from "./push.js";
import { resolvePermission } from "./agent/permissions.js";
import { handleInbound } from "./agent/router.js";
import { handleSessionStart, handleUserPromptSubmit, handlePermissionRequest, handleStop } from "./hooks/routes.js";

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
      .then((body) => handleSessionStart(body))
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
      .then((body) => handleUserPromptSubmit(body))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => {
        console.error("user-prompt-submit hook failed:", err);
        sendJson(res, 400, { error: "Invalid request body" });
      });
    return;
  }

  if (req.url === "/api/hooks/permission-request" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    // res "close" before the response is written means Claude Code dropped
    // the hook call — the request must not stay answerable after that.
    const connection = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) connection.abort();
    });
    readJsonBody(req)
      .then((body) => handlePermissionRequest(body, connection.signal))
      .then((result) => {
        if (result) sendJson(res, 200, result);
      })
      .catch((err) => {
        console.error("permission-request hook failed:", err);
        sendJson(res, 400, { error: "Invalid request body" });
      });
    return;
  }

  if (req.url === "/api/hooks/stop" && req.method === "POST") {
    if (!requireHookAuth(req, res)) return;
    readJsonBody(req)
      .then((body) => handleStop(body))
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

attachWebSocketServer(server, handleInbound);

server.listen(config.port, () => {
  console.log(`JARVIS listening on http://localhost:${config.port}`);
});
