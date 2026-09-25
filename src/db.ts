import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config.js";
import type {
  MessageDirection,
  MessageRecord,
  MessageType,
  PermissionRecord,
  PermissionStatus,
  ProjectRecord,
  PushSubscriptionRecord,
  SessionRecord,
  SessionStatus,
} from "./types.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// watch-project.ts opens this same file from a separate short-lived process
// while the server is running; WAL handles concurrent access, but give a
// writer a moment to retry instead of failing immediately on contention.
db.pragma("busy_timeout = 5000");

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

  -- Projects JARVIS is allowed to launch a fresh session into, registered by
  -- "npm run watch-project <path>" at the moment it wires up that project's
  -- hooks — before any session has ever run there. This is what makes
  -- "open <project>" possible: JARVIS needs a cwd to spawn into, and until
  -- now the only cwd's it ever knew about came from a session that had
  -- already started manually.
  CREATE TABLE IF NOT EXISTS projects (
    tag TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
`);

// Full-text search over everything said in every project (agent/search.ts).
// An FTS5 index kept in step with the messages table by triggers; the
// porter tokenizer stems words, so "implementing" finds "implementation".
// Built from existing history the first time it's created.
const hadSearchIndex = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'`).get() !== undefined;
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);
if (!hadSearchIndex) db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);

if (!(db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).some((c) => c.name === "edited_at")) {
  db.exec(`ALTER TABLE messages ADD COLUMN edited_at INTEGER`);
}

const permissionColumns = db.prepare(`PRAGMA table_info(permissions)`).all() as { name: string }[];
if (!permissionColumns.some((c) => c.name === "questions")) {
  db.exec(`ALTER TABLE permissions ADD COLUMN questions TEXT`);
}
if (!permissionColumns.some((c) => c.name === "summary")) {
  db.exec(`ALTER TABLE permissions ADD COLUMN summary TEXT`);
}

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
       -- A session's folder is where it started, fixed at first sight. The cwd
       -- in later hook calls is wherever Claude's shell has cd'd to since.
       cwd = COALESCE(cwd, @cwd)`,
  ).run({ id, projectTag, status, now, transcriptPath, cwd });
  return getSession(id) as SessionRecord;
}

// The "first turn in progress" state lives in memory; after a restart it's
// gone, so a session left marked starting is just an ordinary running one.
export function clearStartingSessions(): number {
  return db.prepare(`UPDATE sessions SET status = 'running' WHERE status = 'starting'`).run().changes;
}

// Resets any session's stored folder that disagrees with its transcript,
// which records the folder the session was started in (the first entry's
// cwd). Sessions stored before folders were fixed at first sight may have
// drifted to wherever Claude last cd'd. Returns the sessions corrected.
export function repairSessionFolders(): { id: string; from: string | null; to: string }[] {
  const rows = db.prepare(`SELECT id, cwd, transcript_path FROM sessions WHERE transcript_path IS NOT NULL`).all() as
    { id: string; cwd: string | null; transcript_path: string }[];
  const fixed: { id: string; from: string | null; to: string }[] = [];
  for (const r of rows) {
    let first: string | undefined;
    try {
      const fd = fs.openSync(r.transcript_path, "r");
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      first = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString("utf8", 0, n))?.[1];
    } catch {
      continue;
    }
    if (first && first !== r.cwd) {
      db.prepare(`UPDATE sessions SET cwd = ? WHERE id = ?`).run(first, r.id);
      fixed.push({ id: r.id, from: r.cwd, to: first });
    }
  }
  return fixed;
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

// Only for a queued message you edit before it's sent (the history then
// matches what Claude receives). Sent messages are never changed.
export function editMessage(id: number, content: string): void {
  db.prepare(`UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`).run(content, Date.now(), id);
}

// Only for a queued message you remove before it's sent: Claude never saw it.
export function deleteMessage(id: number): void {
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
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

export function insertPermission(
  p: Omit<PermissionRecord, "status" | "resolved_at" | "questions" | "summary"> & { questions?: string | null; summary?: string | null },
): void {
  db.prepare(
    `INSERT INTO permissions (tool_use_id, session_id, project_tag, tool_name, content, status, created_at, questions, summary)
     VALUES (@tool_use_id, @session_id, @project_tag, @tool_name, @content, 'pending', @created_at, @questions, @summary)`,
  ).run({ ...p, questions: p.questions ?? null, summary: p.summary ?? null });
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

export function registerProject(tag: string, cwd: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (tag, cwd, created_at, last_used_at)
     VALUES (@tag, @cwd, @now, @now)
     ON CONFLICT(tag) DO UPDATE SET cwd = @cwd, last_used_at = @now`,
  ).run({ tag, cwd, now });
}

export function getProject(tag: string): ProjectRecord | undefined {
  return db.prepare(`SELECT * FROM projects WHERE tag = ?`).get(tag) as ProjectRecord | undefined;
}

export function getProjectByCwd(cwd: string): ProjectRecord | undefined {
  return db.prepare(`SELECT * FROM projects WHERE cwd = ?`).get(cwd) as ProjectRecord | undefined;
}

export function listProjects(): ProjectRecord[] {
  return db.prepare(`SELECT * FROM projects ORDER BY tag`).all() as ProjectRecord[];
}

// A project's launchable cwd: the registry if it's been watched, else the
// most recent session that ever ran there (covers projects set up before
// this feature existed, without requiring them to be re-watched).
export function findLaunchableCwd(tag: string): string | undefined {
  const registered = getProject(tag);
  if (registered) return registered.cwd;
  const row = db
    .prepare(
      `SELECT cwd FROM sessions WHERE project_tag = ? AND cwd IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .get(tag) as { cwd: string } | undefined;
  return row?.cwd;
}

export default db;
