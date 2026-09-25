import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  isValidAuthToken,
  listActiveSessions,
  listMessages,
  listRecentPermissions,
} from "./db.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
// How far back resolved/stale/cancelled requests stay in the snapshot, so the
// UI can label an old request card instead of leaving it looking answerable.
const PERMISSION_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

export type InboundMessage =
  | {
      type: "decision";
      clientId?: string;
      toolUseID: string;
      decision: "allow" | "deny";
      message?: string;
      // For a question: pass it to the terminal unanswered, deliberately.
      answerInTerminal?: boolean;
    }
  | { type: "answer"; clientId?: string; toolUseID: string; answers: unknown }
  | { type: "unqueue"; clientId?: string; queueItemId: string }
  | {
      type: "chat";
      clientId?: string;
      content: string;
      replyTo?: string;
      // The reply target shown in the composer when this was sent: which
      // session the user was looking at, and how long it had been showing.
      replyToSession?: { sessionId: string; changedMsAgo?: number };
      // Set while the composer is answering a "which project?" list.
      openChoice?: string;
    };

export type Reply = (payload: unknown) => void;

const clients = new Set<TrackedSocket>();

// Other state a client needs on connect (e.g. the message queue), registered
// by the module that owns it so this one doesn't have to import it.
const connectSnapshots: (() => unknown)[] = [];
export function registerConnectSnapshot(fn: () => unknown): void {
  connectSnapshots.push(fn);
}

export function broadcast(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

export function hasConnectedClients(): boolean {
  for (const client of clients) {
    if (client.readyState === client.OPEN && client.isAlive !== false) return true;
  }
  return false;
}

function permissionsSnapshot() {
  return {
    type: "permissions",
    items: listRecentPermissions(PERMISSION_SNAPSHOT_WINDOW_MS).map((p) => ({
      toolUseID: p.tool_use_id,
      sessionId: p.session_id,
      projectTag: p.project_tag,
      toolName: p.tool_name,
      status: p.status,
      createdAt: p.created_at,
      questions: p.questions ? JSON.parse(p.questions) : undefined,
      summary: p.summary ? JSON.parse(p.summary) : undefined,
    })),
  };
}

export function broadcastPermissions(): void {
  broadcast(permissionsSnapshot());
}

function historySnapshot() {
  const messages = [];
  for (const session of listActiveSessions()) {
    for (const m of listMessages(session.id)) {
      messages.push({
        direction: m.direction,
        type: m.type,
        content: m.content,
        tag: session.project_tag,
        sessionId: m.session_id,
        projectTag: session.project_tag,
        toolUseID: m.tool_use_id ?? undefined,
        createdAt: m.created_at,
      });
    }
  }
  messages.sort((a, b) => a.createdAt - b.createdAt);
  return { type: "history", messages };
}

function parseInbound(raw: string): InboundMessage | null {
  const parsed = JSON.parse(raw);
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : undefined;
  if (parsed.type === "decision") {
    if (typeof parsed.toolUseID !== "string") return null;
    if (parsed.decision !== "allow" && parsed.decision !== "deny") return null;
    return {
      type: "decision",
      clientId,
      toolUseID: parsed.toolUseID,
      decision: parsed.decision,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      answerInTerminal: parsed.answerInTerminal === true,
    };
  }
  if (parsed.type === "unqueue") {
    if (typeof parsed.queueItemId !== "string") return null;
    return { type: "unqueue", clientId, queueItemId: parsed.queueItemId };
  }
  if (parsed.type === "answer") {
    if (typeof parsed.toolUseID !== "string") return null;
    return { type: "answer", clientId, toolUseID: parsed.toolUseID, answers: parsed.answers };
  }
  if (typeof parsed.content !== "string" || !parsed.content.trim()) return null;
  return {
    type: "chat",
    clientId,
    content: parsed.content.trim(),
    replyTo: typeof parsed.replyTo === "string" ? parsed.replyTo : undefined,
    replyToSession:
      parsed.replyToSession && typeof parsed.replyToSession.sessionId === "string"
        ? {
            sessionId: parsed.replyToSession.sessionId,
            changedMsAgo: Number.isFinite(parsed.replyToSession.changedMsAgo)
              ? parsed.replyToSession.changedMsAgo
              : undefined,
          }
        : undefined,
    openChoice: typeof parsed.openChoice === "string" ? parsed.openChoice : undefined,
  };
}

export function attachWebSocketServer(
  server: Server,
  onMessage: (msg: InboundMessage, reply: Reply) => void,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token || !isValidAuthToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws: TrackedSocket) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    clients.add(ws);
    ws.send(
      JSON.stringify({
        direction: "out",
        type: "system",
        content: "Connected to JARVIS.",
      }),
    );

    // Full resync on every connect: the authoritative status of every recent
    // permission request first — so cards rendered from the backlog never
    // briefly show live buttons from the client's outdated view — then the
    // backlog as one snapshot the client replaces rather than appends to.
    ws.send(JSON.stringify(permissionsSnapshot()));
    ws.send(JSON.stringify(historySnapshot()));
    for (const snapshot of connectSnapshots) ws.send(JSON.stringify(snapshot()));

    const reply: Reply = (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", (raw) => {
      try {
        const msg = parseInbound(raw.toString());
        if (msg) onMessage(msg, reply);
      } catch (err) {
        console.error("Failed to handle WS message:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  return wss;
}
