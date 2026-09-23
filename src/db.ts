import Database from "better-sqlite3";
import { config } from "./config.js";
import type {
  MessageDirection,
  MessageRecord,
  MessageType,
  PermissionRecord,
  PermissionStatus,
  PushSubscriptionRecord,
  SessionRecord,
  SessionStatus,
} from "./types.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_tag TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    last_event_at INTEGER NOT NULL,
    transcript_path TEXT,
    cwd TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  -- Durable record of every permission request. The blocked hook call itself
  -- lives only in memory, so this is what lets a restarted server tell the
  -- phone "that request is dead" instead of forgetting it existed.
  CREATE TABLE IF NOT EXISTS permissions (
    tool_use_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_tag TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_permissions_status ON permissions(status);
`);

const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
if (!messageColumns.some((c) => c.name === "tool_use_id")) {
  db.exec(`ALTER TABLE messages ADD COLUMN tool_use_id TEXT`);
}

export function upsertSession(
  id: string,
  projectTag: string,
  status: SessionStatus,
  opts: { transcriptPath?: string | null; cwd?: string | null } = {},
): SessionRecord {
  const now = Date.now();
  const transcriptPath = opts.transcriptPath ?? null;
  const cwd = opts.cwd ?? null;
  db.prepare(
    `INSERT INTO sessions (id, project_tag, status, last_event_at, transcript_path, cwd, created_at)
     VALUES (@id, @projectTag, @status, @now, @transcriptPath, @cwd, @now)
     ON CONFLICT(id) DO UPDATE SET
       status = @status,
       last_event_at = @now,
       transcript_path = COALESCE(@transcriptPath, transcript_path),
       cwd = COALESCE(@cwd, cwd)`,
  ).run({ id, projectTag, status, now, transcriptPath, cwd });
  return getSession(id) as SessionRecord;
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  db.prepare(
    `UPDATE sessions SET status = ?, last_event_at = ? WHERE id = ?`,
  ).run(status, Date.now(), id);
}

export function getSession(id: string): SessionRecord | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | SessionRecord
    | undefined;
}

export function listSessions(): SessionRecord[] {
  return db
    .prepare(`SELECT * FROM sessions ORDER BY last_event_at DESC`)
    .all() as SessionRecord[];
}

export function listActiveSessions(): SessionRecord[] {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE status NOT IN ('done', 'error') ORDER BY last_event_at DESC`,
    )
    .all() as SessionRecord[];
}

export function addMessage(
  sessionId: string,
  direction: MessageDirection,
  type: MessageType,
  content: string,
  toolUseId: string | null = null,
): MessageRecord {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO messages (session_id, direction, type, content, created_at, tool_use_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, direction, type, content, now, toolUseId);
  return {
    id: Number(result.lastInsertRowid),
    session_id: sessionId,
    direction,
    type,
    content,
    created_at: now,
    tool_use_id: toolUseId,
  };
}

export function getLastMessageContent(
  sessionId: string,
  type: MessageType,
): string | undefined {
  const row = db
    .prepare(
      `SELECT content FROM messages WHERE session_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId, type) as { content: string } | undefined;
  return row?.content;
}

export function listMessages(sessionId: string, limit = 200): MessageRecord[] {
  return db
    .prepare(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
    .all(sessionId, limit) as MessageRecord[];
}

export function addPushSubscription(
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(endpoint, p256dh, auth, Date.now());
}

export function removePushSubscription(endpoint: string): void {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function listPushSubscriptions(): PushSubscriptionRecord[] {
  return db.prepare(`SELECT * FROM push_subscriptions`).all() as PushSubscriptionRecord[];
}

export function createAuthToken(token: string): void {
  db.prepare(`INSERT INTO auth_tokens (token, created_at) VALUES (?, ?)`).run(
    token,
    Date.now(),
  );
}

export function isValidAuthToken(token: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM auth_tokens WHERE token = ?`).get(token) !==
    undefined
  );
}

export function insertPermission(p: Omit<PermissionRecord, "status" | "resolved_at">): void {
  db.prepare(
    `INSERT INTO permissions (tool_use_id, session_id, project_tag, tool_name, content, status, created_at)
     VALUES (@tool_use_id, @session_id, @project_tag, @tool_name, @content, 'pending', @created_at)`,
  ).run(p);
}

// Only moves a request out of 'pending' — a terminal status is never
// overwritten, so a late duplicate can't flip an answered request.
export function finishPermission(toolUseId: string, status: Exclude<PermissionStatus, "pending">): boolean {
  const result = db
    .prepare(
      `UPDATE permissions SET status = ?, resolved_at = ? WHERE tool_use_id = ? AND status = 'pending'`,
    )
    .run(status, Date.now(), toolUseId);
  return result.changes > 0;
}

export function getPermission(toolUseId: string): PermissionRecord | undefined {
  return db.prepare(`SELECT * FROM permissions WHERE tool_use_id = ?`).get(toolUseId) as
    | PermissionRecord
    | undefined;
}

// Anything still 'pending' at startup belonged to a previous process whose
// hook connections died with it.
export function markPendingPermissionsStale(): number {
  return db
    .prepare(`UPDATE permissions SET status = 'stale', resolved_at = ? WHERE status = 'pending'`)
    .run(Date.now()).changes;
}

export function listRecentPermissions(sinceMs: number): PermissionRecord[] {
  return db
    .prepare(
      `SELECT * FROM permissions WHERE status = 'pending' OR created_at >= ? ORDER BY created_at ASC`,
    )
    .all(Date.now() - sinceMs) as PermissionRecord[];
}

export function hasRecentDeadPermission(sinceMs: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM permissions WHERE status IN ('stale', 'cancelled') AND resolved_at >= ? LIMIT 1`,
      )
      .get(Date.now() - sinceMs) !== undefined
  );
}

export default db;
