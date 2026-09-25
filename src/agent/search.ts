import db from "../db.js";
import { projectBlocks, type HistoryBlock } from "./history.js";

// Search across everything said in every project: your messages and
// terminal prompts, Claude's replies, permission requests (headline and
// exact command), and questions.
//
// - Words, not meaning: FTS5 with stemming ("implementing" finds
//   "implementation"), not synonyms ("role-based access" won't find "RBAC").
// - All words must match, and the last word matches as a prefix so results
//   firm up as you type. When that finds fewer than PARTIAL_BELOW
//   conversations, conversations matching only some of the words are listed
//   separately as partial matches.
// - One result per conversation (block of work): its best-matching message,
//   with the match in context, plus how many other messages in it matched.
// - Ranked by relevance (bm25 of the best match), recency only breaking ties.

const PARTIAL_BELOW = 5;
const MAX_RESULTS = 30;
const MAX_HITS = 1000;

// Snippet highlight markers: control characters that can't appear in a
// query match, split on by the client to highlight safely.
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

export interface SearchResult {
  projectKey: string;
  projectTag: string;
  block: Pick<HistoryBlock, "start" | "end" | "title" | "count">;
  messageId: number;
  at: number;
  snippet: string;
  otherMatches: number;
  score: number;
}

// The words of whatever was typed, each quoted so nothing typed can act as
// FTS5 syntax ("AND", "(", "*", quotes…).
function words(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => w.toLowerCase());
}

function ftsQuery(terms: string[], mode: "all" | "any"): string {
  const quoted = terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`);
  return quoted.join(mode === "all" ? " " : " OR ");
}

interface Hit {
  id: number;
  projectKey: string;
  projectTag: string;
  at: number;
  score: number;
  snippet: string;
}

function hits(query: string, projectKey?: string): Hit[] {
  return db
    .prepare(
      `SELECT m.id, s.cwd AS projectKey, s.project_tag AS projectTag, m.created_at AS at,
              bm25(messages_fts) AS score,
              snippet(messages_fts, 0, ?, ?, '…', 14) AS snippet
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ? AND s.cwd IS NOT NULL ${projectKey ? "AND s.cwd = ?" : ""}
        ORDER BY score
        LIMIT ${MAX_HITS}`,
    )
    .all(MARK_START, MARK_END, query, ...(projectKey ? [projectKey] : [])) as Hit[];
}

function groupIntoConversations(found: Hit[]): SearchResult[] {
  const blocksByProject = new Map<string, HistoryBlock[]>();
  const results = new Map<string, SearchResult>();
  for (const h of found) {
    let blocks = blocksByProject.get(h.projectKey);
    if (!blocks) blocksByProject.set(h.projectKey, (blocks = projectBlocks(h.projectKey)));
    const block = blocks.find((b) => b.start <= h.at && h.at <= b.end);
    if (!block) continue;
    const key = `${h.projectKey}\u0000${block.start}`;
    const existing = results.get(key);
    if (existing) {
      existing.otherMatches++;
      continue; // hits arrive best-first, so the first one per block is its best
    }
    results.set(key, {
      projectKey: h.projectKey,
      projectTag: h.projectTag,
      block: { start: block.start, end: block.end, title: block.title, count: block.count },
      messageId: h.id,
      at: h.at,
      snippet: h.snippet.replace(/\s+/g, " ").trim(),
      otherMatches: 0,
      score: h.score,
    });
  }
  return [...results.values()].sort((a, b) => a.score - b.score || b.at - a.at);
}

export function searchHistory(text: string, projectKey?: string): { results: SearchResult[]; partial: SearchResult[] } {
  const terms = words(text);
  if (!terms.length) return { results: [], partial: [] };
  const results = groupIntoConversations(hits(ftsQuery(terms, "all"), projectKey)).slice(0, MAX_RESULTS);
  if (results.length >= PARTIAL_BELOW || terms.length < 2) return { results, partial: [] };
  const seen = new Set(results.map((r) => `${r.projectKey}\u0000${r.block.start}`));
  const partial = groupIntoConversations(hits(ftsQuery(terms, "any"), projectKey))
    .filter((r) => !seen.has(`${r.projectKey}\u0000${r.block.start}`))
    .slice(0, MAX_RESULTS);
  return { results, partial };
}
