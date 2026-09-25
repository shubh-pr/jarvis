import db from "../db.js";

// Per-project conversation history. A project is identified by its full
// path — the session's starting folder — never by its display name, so two
// repos both called "identity" never share history.
//
// Within a project, history is grouped into blocks of continuous work: a new
// block starts when the project has been quiet for BLOCK_GAP_MS. Blocks are
// worked out from message timestamps when read, not stored, and a block that
// runs past midnight stays whole; its date is a label and a filter, not a
// folder. Claude session IDs aren't the unit: one session can be resumed days
// later, and two terminals can work on a project at once.

export const BLOCK_GAP_MS = 2 * 60 * 60 * 1000;

export interface ProjectHistory {
  key: string; // the project's full path
  tag: string;
  registered: boolean;
  lastActivity: number | null;
  messageCount: number;
}

export interface HistoryMessage {
  id: number;
  sessionId: string;
  projectKey: string;
  projectTag: string;
  direction: string;
  type: string;
  content: string;
  toolUseID?: string;
  createdAt: number;
}

export interface HistoryBlock {
  start: number;
  end: number;
  count: number;
  title: string;
  sessionIds: string[];
}

export function listProjectHistories(): ProjectHistory[] {
  const rows = db
    .prepare(
      `SELECT s.cwd AS key,
              COALESCE(p.tag, (SELECT s2.project_tag FROM sessions s2 WHERE s2.cwd = s.cwd ORDER BY s2.last_event_at DESC LIMIT 1)) AS tag,
              p.tag IS NOT NULL AS registered,
              MAX(m.created_at) AS lastActivity,
              COUNT(m.id) AS messageCount
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         LEFT JOIN projects p ON p.cwd = s.cwd
        WHERE s.cwd IS NOT NULL
        GROUP BY s.cwd`,
    )
    .all() as { key: string; tag: string; registered: number; lastActivity: number | null; messageCount: number }[];
  const seen = new Set(rows.map((r) => r.key));
  const unused = (db.prepare(`SELECT tag, cwd FROM projects`).all() as { tag: string; cwd: string }[])
    .filter((p) => !seen.has(p.cwd))
    .map((p) => ({ key: p.cwd, tag: p.tag, registered: 1, lastActivity: null, messageCount: 0 }));
  return [...rows, ...unused]
    .map((r) => ({ ...r, registered: !!r.registered }))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.tag.localeCompare(b.tag));
}

export function projectMessages(key: string, from = 0, to = Number.MAX_SAFE_INTEGER): HistoryMessage[] {
  return (
    db
      .prepare(
        `SELECT m.id, m.session_id AS sessionId, s.cwd AS projectKey, s.project_tag AS projectTag,
                m.direction, m.type, m.content, m.tool_use_id AS toolUseID, m.created_at AS createdAt
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE s.cwd = ? AND m.created_at BETWEEN ? AND ?
          ORDER BY m.created_at, m.id`,
      )
      .all(key, from, to) as (HistoryMessage & { toolUseID: string | null })[]
  ).map((m) => ({ ...m, toolUseID: m.toolUseID ?? undefined }));
}

function firstLine(text: string, max = 70): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(flat);
  return firstLine(m ? m[1] : flat);
}

// A block's title, from what's already there: the first thing you asked
// (in the PWA or a terminal), else the first request's plain-English
// headline, else Claude's first sentence.
function blockTitle(messages: HistoryMessage[]): string {
  const asked = messages.find((m) => m.direction === "in" && (m.type === "chat" || m.type === "prompt"));
  if (asked) return firstLine(asked.content);
  const request = messages.find((m) => m.type === "permission_request" && m.toolUseID);
  if (request) {
    const row = db.prepare(`SELECT summary, tool_name FROM permissions WHERE tool_use_id = ?`).get(request.toolUseID) as
      | { summary: string | null; tool_name: string }
      | undefined;
    const title = row?.summary ? (JSON.parse(row.summary).title as string) : undefined;
    return firstLine(title ?? request.content);
  }
  const reply = messages.find((m) => m.type === "completion");
  if (reply) return firstSentence(reply.content);
  return "Work session";
}

// Blocks overlapping [from, to], newest first.
export function projectBlocks(key: string, from = 0, to = Number.MAX_SAFE_INTEGER): HistoryBlock[] {
  const all = projectMessages(key);
  const blocks: HistoryMessage[][] = [];
  for (const m of all) {
    const current = blocks[blocks.length - 1];
    if (current && m.createdAt - current[current.length - 1].createdAt <= BLOCK_GAP_MS) current.push(m);
    else blocks.push([m]);
  }
  return blocks
    .map((b) => ({
      start: b[0].createdAt,
      end: b[b.length - 1].createdAt,
      count: b.length,
      title: blockTitle(b),
      sessionIds: [...new Set(b.map((m) => m.sessionId))],
    }))
    .filter((b) => b.end >= from && b.start <= to)
    .reverse();
}
