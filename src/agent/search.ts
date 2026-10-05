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

// Projects whose history is about what a message is about, for suggesting
// where an unrouted sentence belongs ("back to the identity RBAC work").
// Only the message's distinctive words count: ones that turn up in the
// history of at most MAX_PROJECTS_PER_WORD projects (and not every project
// with history), like "rbac" or "kong" — never "back", "the" or "work",
// which every project has. How often a word appears overall doesn't matter
// (the topic you're deep in is the one you mention most), but a project is
// only suggested if it matched in at least MIN_MENTIONS messages: a topic
// recurs, a stray "hey" in one message doesn't. Best match first. These are
// suggestions: the caller always asks before acting on them.
const MAX_PROJECTS_PER_WORD = 2;
const MIN_MENTIONS = 2;
const STOP_WORDS = new Set(
  ("the and for with that this from into onto back lets let's look check please can could would should will just about " +
    "again then than what when where which while work working thing stuff project repo some more need want " +
    "run fix add update make test tests build show tell see get use try start open close change done " +
    "hey hello thanks thank jarvis you are how doing good morning evening").split(" "),
);

export function projectsDiscussing(text: string): string[] {
  const projectsIn = db.prepare(
    `SELECT count(DISTINCT s.project_tag) AS n
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ? AND s.cwd IS NOT NULL`,
  );
  const withHistory = (db
    .prepare(`SELECT count(DISTINCT s.project_tag) AS n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.cwd IS NOT NULL`)
    .get() as { n: number }).n;
  const distinctive = [...new Set(words(text))].filter((w) => {
    if (w.length < 3 || STOP_WORDS.has(w)) return false;
    const n = (projectsIn.get(`"${w}"`) as { n: number }).n;
    return n > 0 && n <= MAX_PROJECTS_PER_WORD && n < withHistory;
  });
  if (!distinctive.length) return [];
  const quoted = distinctive.map((w) => `"${w}"`);
  const recurring = (found: Hit[]) => {
    const mentions = new Map<string, number>();
    for (const h of found) mentions.set(h.projectTag, (mentions.get(h.projectTag) ?? 0) + 1);
    return [...mentions.keys()].filter((tag) => mentions.get(tag)! >= MIN_MENTIONS); // best match first, as hits are
  };
  let projects = recurring(hits(quoted.join(" ")));
  if (!projects.length && distinctive.length > 1) projects = recurring(hits(quoted.join(" OR ")));
  return projects;
}
