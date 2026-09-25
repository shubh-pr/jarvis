import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  listActiveSessions,
  listSessions,
  getSession,
  upsertSession,
  setSessionStatus,
  listProjects,
  findLaunchableCwd,
  registerProject,
  addMessage,
  editMessage,
  deleteMessage,
  getPermission,
  hasRecentDeadPermission,
} from "../db.js";
import { resolvePermission, listPendingPermissions } from "./permissions.js";
import { validateAnswers, answersFromText, describeAnswers } from "./questions.js";
import { broadcast, registerConnectSnapshot, type InboundMessage, type Reply } from "../wsServer.js";
import { config } from "../config.js";
import type { SessionRecord } from "../types.js";

const LEGACY_TEST_SESSION_ID = "shell-test";

const YES_RE = /^(y|yes|approve|allow|ok|okay|sure|go ahead)$/i;
const NO_RE = /^(n|no|deny|reject|stop|cancel)$/i;
const STATUS_RE = /^(status|what'?s running|list projects?|what.*(projects?|running))\b/i;
const OPEN_RE = /^(open|start|launch)\s+/i;
const SEND_NOW_RE = /^send\s+now\b/i;

// A typed reply can't prove which request the user was looking at. If the
// request it would land on only just arrived, assume they haven't read it
// yet and make them answer again. Button taps carry an explicit toolUseID
// for a card the user saw, so they skip this.
const FRESH_GUARD_MS = 1500;

// How long a stale/cancelled request keeps a bare YES/NO pointed at it
// ("that one's dead") instead of "nothing is waiting".
const DEAD_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

// Retransmits of the same inbound message (reconnect retry, double-tap on a
// flaky socket) get the original ack back instead of being processed twice.
const SEEN_LIMIT = 500;
const seenClientIds = new Map<string, unknown>();

type RefusalReason =
  | "stale"
  | "ambiguous"
  | "fresh"
  | "nothing_pending"
  | "unroutable"
  | "unknown_project"
  | "needs_instruction"
  | "target_ended"
  | "needs_answer";

function say(content: string): void {
  broadcast({ direction: "out", type: "chat", content, tag: "jarvis" });
}

function tell(reply: Reply, content: string, extra: Record<string, unknown> = {}): void {
  reply({ direction: "out", type: "chat", content, tag: "jarvis", ...extra });
}

// `id` is optional: a message about a project that doesn't have a session
// yet (e.g. "open <project>" before SessionStart has fired) still needs its
// projectTag shown, but there's nothing to persist it against yet.
// Returns the stored message's ID, when it was stored.
function echoUser(text: string, session?: { id?: string; projectTag: string }, type: "chat" | "permission_decision" = "chat"): number | undefined {
  const stored = session?.id ? addMessage(session.id, "in", type, text) : undefined;
  broadcast({
    id: stored?.id,
    direction: "in",
    type,
    content: text,
    tag: session?.projectTag ?? "you",
    sessionId: session?.id,
    projectTag: session?.projectTag,
    projectKey: session?.id ? getSession(session.id)?.cwd ?? undefined : undefined,
  });
  return stored?.id;
}

// ---- Turn tracking ----
// A session is busy from the moment a turn starts until its Stop hook: a
// turn Jarvis starts is marked busy the instant the process is spawned; one
// you start in a terminal is marked by its UserPromptSubmit hook (and by a
// permission request, which only ever happens mid-turn). Nothing new is
// ever sent into a busy session — messages for it wait here and go in as
// one turn when it's free, so two `claude` processes never run one session.
//
// Claude Code doesn't send Stop when you interrupt a turn, so a session can
// look busy with nothing running. That can't be told apart from a long
// quiet turn, so Jarvis never assumes: after a quiet spell it says so once,
// and "send now" delivers the waiting messages anyway.
const EXIT_SETTLE_MS = 250;
interface Busy {
  tag: string;
  kind: "launch" | "turn";
  queued: QueuedItem[];
  token: string; // identifies which process's exit may end this turn
  lastActivity: number;
  nudged: boolean;
}
const busy = new Map<string, Busy>();

// A message waiting for a busy session. Each has an ID so you can see it and
// take it back before it sends; the queue here is what actually gets sent.
interface QueuedItem {
  id: string;
  text: string;
  at: number;
  messageId?: number; // your message in the history, kept in step with edits
}
const texts = (e: Busy) => e.queued.map((q) => q.text);

function queueSnapshot() {
  return {
    type: "queue",
    sessions: [...busy.entries()]
      .filter(([, e]) => e.queued.length)
      .map(([sessionId, e]) => ({
        sessionId,
        projectTag: e.tag,
        items: e.queued.map(({ id, text, at, messageId }) => ({ id, text, at, messageId })),
      })),
  };
}

function broadcastQueue(): void {
  broadcast(queueSnapshot());
}
registerConnectSnapshot(queueSnapshot);

function markBusy(sessionId: string, tag: string, kind: Busy["kind"]): string {
  const token = randomUUID();
  const existing = busy.get(sessionId);
  busy.set(sessionId, {
    tag,
    kind,
    queued: existing?.queued ?? [],
    token,
    lastActivity: Date.now(),
    nudged: false,
  });
  return token;
}

// Injects a turn into an existing session. Callers go through deliver(), so
// this only runs when the session is free. Jarvis's own runs are pinned to
// the default permission mode, so nothing it starts can auto-accept edits
// or skip prompts, whatever a settings file says.
function spawnResume(session: SessionRecord, text: string): ChildProcess {
  const token = markBusy(session.id, session.project_tag, "turn");
  const child = spawn("claude", ["--permission-mode", "default", "--resume", session.id, "--print", text], {
    cwd: session.cwd!,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", (err) => {
    say(`Failed to reach "${session.project_tag}": ${err.message}`);
  });
  child.on("exit", (code) => {
    if (code) say(`claude exited with code ${code} while handling your message for "${session.project_tag}".`);
    // Stop is answered before the process can exit, so if this turn is
    // still marked busy it ended without one. The session is free again.
    setTimeout(() => {
      const entry = busy.get(session.id);
      if (!entry || entry.token !== token) return;
      busy.delete(session.id);
      broadcastQueue();
      if (entry.queued.length) {
        say(`"${session.project_tag}"'s turn ended without reporting back; sending your queued message${entry.queued.length > 1 ? "s" : ""} now.`);
        const current = getSession(session.id);
        if (current) spawnResume(current, texts(entry).join("\n\n"));
      }
    }, EXIT_SETTLE_MS);
  });
  return child;
}

// Originates a brand-new session — the one case where JARVIS runs `claude`
// somewhere it wasn't already running, rather than resuming one you started.
// See ARCHITECTURE.md's "open <project>" note for why this is a deliberate
// exception to "never spawns or owns agent sessions itself". Jarvis picks
// the session ID, so the session is registered — and busy — at once.
function spawnFresh(tag: string, cwd: string, instruction: string): string {
  const sessionId = randomUUID();
  upsertSession(sessionId, tag, "starting", { cwd });
  const token = markBusy(sessionId, tag, "launch");
  const child = spawn("claude", ["--permission-mode", "default", "--session-id", sessionId, "--print", instruction], {
    cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", (err) => {
    say(`Failed to launch "${tag}": ${err.message}`);
  });
  child.on("exit", (code) => {
    if (code) say(`claude exited with code ${code} while launching "${tag}".`);
    setTimeout(() => {
      const entry = busy.get(sessionId);
      if (!entry || entry.token !== token) return;
      busy.delete(sessionId);
      broadcastQueue();
      setSessionStatus(sessionId, "error");
      const lost = entry.queued.length
        ? ` Your queued message${entry.queued.length > 1 ? "s weren't" : " wasn't"} sent: ${texts(entry).map((q) => `"${q}"`).join(", ")}.`
        : "";
      say(`"${tag}" exited before finishing its first turn, so that session is closed.${lost} Say "open ${tag} <instruction>" to try again.`);
    }, EXIT_SETTLE_MS);
  });
  return sessionId;
}

// Sends a turn into a session, or queues it if a turn is in progress.
function deliver(session: SessionRecord, text: string, messageId?: number): "sent" | "queued" {
  const entry = busy.get(session.id);
  if (entry) {
    entry.queued.push({ id: randomUUID(), text, at: Date.now(), messageId });
    broadcastQueue();
    say(
      entry.kind === "launch"
        ? `"${session.project_tag}" is still starting — I'll send this as soon as its first turn finishes.`
        : `"${session.project_tag}" is in the middle of a turn — I'll send this as soon as it finishes.`,
    );
    return "queued";
  }
  spawnResume(session, text);
  return "sent";
}

function flush(sessionId: string, entry: Busy): void {
  const session = getSession(sessionId);
  broadcastQueue();
  if (!session || !entry.queued.length) return;
  spawnResume(session, texts(entry).join("\n\n"));
  say(`Sent your queued message${entry.queued.length > 1 ? "s" : ""} to "${entry.tag}".`);
}

// Whether a turn Jarvis itself started is running in this session — its
// UserPromptSubmit carries Jarvis's own text, already recorded.
export function isJarvisTurn(sessionId: string): boolean {
  return busy.has(sessionId);
}

// A turn started outside Jarvis's knowledge (UserPromptSubmit), or activity
// that proves one is running (a permission request).
export function onTurnActivity(sessionId: string, tag: string): void {
  const entry = busy.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
    entry.nudged = false;
    return;
  }
  markBusy(sessionId, tag, "turn");
}

// A turn's Stop hook: the session is free, and anything queued goes in now.
export function onTurnEnded(sessionId: string): void {
  const entry = busy.get(sessionId);
  if (!entry) return;
  busy.delete(sessionId);
  flush(sessionId, entry);
}

// Messages have been waiting on a quiet session for a while: say so, once.
setInterval(() => {
  const pendingSessions = new Set(listPendingPermissions().map((p) => p.sessionId));
  for (const [sessionId, entry] of busy) {
    if (entry.nudged || !entry.queued.length || pendingSessions.has(sessionId)) continue;
    if (Date.now() - entry.lastActivity < config.busyNudgeMs) continue;
    entry.nudged = true;
    const mins = Math.round(config.busyNudgeMs / 60_000);
    say(
      `"${entry.tag}" has shown no activity for ${mins >= 1 ? `${mins} minute${mins === 1 ? "" : "s"}` : "a while"} and ${entry.queued.length} message${entry.queued.length > 1 ? "s are" : " is"} still waiting. ` +
        `A turn interrupted in the terminal doesn't report back, so I can't tell whether it's still working. Say "send now ${entry.tag}" to send ${entry.queued.length > 1 ? "them" : "it"} anyway.`,
    );
  }
}, 5_000).unref();

// Takes one queued message back before it sends. The queue here is the
// source of truth: if the message has already gone in, say so.
function handleUnqueue(msg: Extract<InboundMessage, { type: "unqueue" }>, ack: Ack, refuse: Refuse): void {
  for (const [sessionId, entry] of busy) {
    const i = entry.queued.findIndex((q) => q.id === msg.queueItemId);
    if (i === -1) continue;
    const [removed] = entry.queued.splice(i, 1);
    // Claude never saw it, so it leaves the history too.
    if (removed.messageId) {
      deleteMessage(removed.messageId);
      broadcast({ type: "message_removed", id: removed.messageId });
    }
    broadcastQueue();
    say(`Removed from ${entry.tag}'s queue — it won't be sent: "${removed.text}"`);
    ack(true, { action: "unqueued", sessionId, queueItemId: removed.id });
    return;
  }
  refuse("stale", "That message isn't waiting any more — it was already sent (or removed), so there's nothing to cancel.");
}

// Rewrites a queued message before it sends — the one kind of sent message
// that hasn't been acted on. Anything already in a Claude turn is refused.
function handleEditQueued(msg: Extract<InboundMessage, { type: "edit_queued" }>, ack: Ack, refuse: Refuse): void {
  const text = msg.text.trim();
  if (!text) {
    refuse("needs_instruction", "An edited message can't be empty — use ✕ to remove it instead.");
    return;
  }
  for (const [sessionId, entry] of busy) {
    const item = entry.queued.find((q) => q.id === msg.queueItemId);
    if (!item) continue;
    item.text = text;
    if (item.messageId) {
      editMessage(item.messageId, text);
      broadcast({ type: "message_updated", id: item.messageId, content: text, editedAt: Date.now() });
    }
    broadcastQueue();
    ack(true, { action: "edited", sessionId, queueItemId: item.id });
    return;
  }
  refuse("stale", "That message has already been sent to Claude, so it can't be changed now.");
}

// "send now [project]": deliver a quiet session's waiting messages anyway.
function handleSendNow(text: string, replyToSession: string | undefined, ack: Ack, refuse: Refuse): void {
  const waiting = [...busy.entries()].filter(([, e]) => e.queued.length);
  const mention = findMentionedTag(text.replace(SEND_NOW_RE, ""), waiting.map(([, e]) => e.tag));
  const candidates = mention
    ? waiting.filter(([, e]) => e.tag === mention.tag)
    : replyToSession && busy.get(replyToSession)?.queued.length
      ? waiting.filter(([id]) => id === replyToSession)
      : waiting;
  echoUser(text);
  if (!candidates.length) {
    refuse("nothing_pending", "No messages are waiting to be sent.");
    return;
  }
  if (candidates.length > 1) {
    refuse("ambiguous", `Messages are waiting for ${candidates.map(([, e]) => e.tag).join(", ")}. Say "send now <project>".`);
    return;
  }
  const [sessionId, entry] = candidates[0];
  busy.delete(sessionId);
  flush(sessionId, entry);
  ack(true, { action: "sent_now", sessionId });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds the project named in the text. Longest match wins, so
// "identity (two)" beats "identity". Separators are interchangeable, so
// "auth central" names "auth-central"; hyphens count as part of a name.
function findMentionedTag(text: string, tags: string[]): { tag: string; rest: string } | undefined {
  let best: { tag: string; rest: string } | undefined;
  for (const tag of new Set(tags)) {
    const pattern = tag.split(/[-_\s]+/).map(escapeRegExp).join("[-_\\s]+");
    const re = new RegExp(`(?<![\\w-])${pattern}(?![\\w-])`, "i");
    const m = re.exec(text);
    if (m && (!best || tag.length > best.tag.length)) {
      best = { tag, rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)) };
    }
  }
  if (!best) return undefined;
  return { tag: best.tag, rest: trimRest(best.rest) };
}

function trimRest(rest: string): string {
  return rest.replace(/^[\s,.:;!-]+|[\s,.:;!-]+$/g, "");
}

interface TagMatch {
  tag: string;
  start: number;
  end: number;
}

// Every tag mentioned in the text, for callers that must refuse rather than
// pick when more than one project is named. A match lying entirely inside a
// longer one is dropped ("identity" inside "identity (two)" isn't a second
// mention); two different tags matching the same span — which only happens
// if they normalize alike — are both kept, since that is genuinely ambiguous.
function findAllMentionedTags(text: string, tags: string[]): TagMatch[] {
  const matches: TagMatch[] = [];
  for (const tag of new Set(tags)) {
    const pattern = tag.split(/[-_\s]+/).map(escapeRegExp).join("[-_\\s]+");
    const re = new RegExp(`(?<![\\w-])${pattern}(?![\\w-])`, "gi");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      matches.push({ tag, start: m.index, end: m.index + m[0].length });
    }
  }
  const kept = matches.filter(
    (a) => !matches.some((b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start),
  );
  const seen = new Set<string>();
  return kept.filter((m) => !seen.has(m.tag) && seen.add(m.tag));
}

function prettyPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// A session's state as far as you're concerned, from live sources only: a
// pending request, and the in-memory turn tracking. The stored status is
// never shown — "running" there only means the last thing Jarvis saw was
// mid-turn, and it isn't corrected when a turn ends without a Stop
// (interrupted, denied-and-stopped, or across a Jarvis restart).
function sessionState(s: SessionRecord, pendingBySession: Map<string, { toolName: string }>): { label: string; rank: number } {
  const p = pendingBySession.get(s.id);
  if (p) return { label: `waiting on you: ${p.toolName}`, rank: 0 };
  const b = busy.get(s.id);
  if (b) {
    const waiting = b.queued.length
      ? ` — waiting to send:${b.queued.map((q, i) => `\n      ${i + 1}. "${q.text}"`).join("")}`
      : "";
    return { label: `${b.kind === "launch" ? "starting up, first turn in progress" : "working, turn in progress"}${waiting}`, rank: 1 };
  }
  return { label: "idle, ready for your next instruction", rank: 2 };
}

// One line per project. Sessions accumulate (they're always resumable, so
// none is ever definitively over), so the line shows the one that matters —
// waiting on you, then working, then the newest — and folds older idle ones
// into a count. Two sessions genuinely active at once are both shown.
function statusText(active: SessionRecord[]): string {
  if (active.length === 0) return "No projects are currently active.";
  const pendingBySession = new Map(listPendingPermissions().map((p) => [p.sessionId, p]));
  const byProject = new Map<string, SessionRecord[]>();
  for (const s of active) byProject.set(s.project_tag, [...(byProject.get(s.project_tag) ?? []), s]);

  const lines: string[] = [];
  for (const [tag, sessions] of byProject) {
    const ranked = sessions
      .map((s) => ({ s, ...sessionState(s, pendingBySession) }))
      .sort((a, b) => a.rank - b.rank || b.s.last_event_at - a.s.last_event_at);
    const live = ranked.filter((r) => r.rank < 2);
    const shown = live.length > 1 ? live : [ranked[0]];
    const idleOthers = ranked.length - shown.length;
    const more = idleOthers ? ` (+${idleOthers} older idle session${idleOthers > 1 ? "s" : ""})` : "";
    if (shown.length === 1) {
      lines.push(`• ${tag} — ${shown[0].label}${more}`);
    } else {
      lines.push(`• ${tag} — ${shown.length} sessions active${more}:`);
      for (const r of shown) lines.push(`    – ${r.s.id.slice(0, 8)}: ${r.label}`);
    }
  }
  return `Active projects:\n${lines.join("\n")}`;
}

const STALE_EXPLANATION =
  "That request is no longer waiting — it was already answered, cancelled in the terminal, or lost when JARVIS restarted. Nothing was sent. If claude is still asking, answer it in the terminal.";

export async function handleInbound(msg: InboundMessage, reply: Reply): Promise<void> {
  if (msg.clientId && seenClientIds.has(msg.clientId)) {
    reply(seenClientIds.get(msg.clientId));
    return;
  }
  const ack = (ok: boolean, extra: Record<string, unknown> = {}) => {
    // Acks that name a session also say which project it is, so the phone
    // can switch to that project's history (e.g. after "open identity …").
    const sessionId = typeof extra.sessionId === "string" ? extra.sessionId : undefined;
    const projectKey = sessionId ? getSession(sessionId)?.cwd ?? undefined : undefined;
    const payload = { type: "ack", clientId: msg.clientId, ok, ...extra, ...(projectKey ? { projectKey } : {}) };
    if (msg.clientId) {
      seenClientIds.set(msg.clientId, payload);
      if (seenClientIds.size > SEEN_LIMIT) seenClientIds.delete(seenClientIds.keys().next().value!);
    }
    reply(payload);
  };
  const refuse = (reason: RefusalReason, explanation: string, toolUseID?: string, extra: Record<string, unknown> = {}) => {
    tell(reply, explanation, extra);
    ack(false, { reason, toolUseID, ...extra });
  };

  try {
    if (msg.type === "decision") {
      handleDecision(msg, ack, refuse);
    } else if (msg.type === "answer") {
      handleAnswer(msg, ack, refuse);
    } else if (msg.type === "unqueue") {
      handleUnqueue(msg, ack, refuse);
    } else if (msg.type === "edit_queued") {
      handleEditQueued(msg, ack, refuse);
    } else {
      handleChat(msg, ack, refuse);
    }
  } catch (err) {
    console.error("Failed to handle inbound message:", err);
    ack(false, { reason: "error" });
  }
}

type Ack = (ok: boolean, extra?: Record<string, unknown>) => void;
type Refuse = (reason: RefusalReason, explanation: string, toolUseID?: string, extra?: Record<string, unknown>) => void;

const NEEDS_ANSWER =
  "That's a question, not a yes/no — pick one of its options (or type your own answer). To answer it at the terminal instead, use \"Answer in terminal\" on the card.";

function handleDecision(msg: Extract<InboundMessage, { type: "decision" }>, ack: Ack, refuse: Refuse): void {
  const record = getPermission(msg.toolUseID);
  const question = listPendingPermissions().find((p) => p.toolUseID === msg.toolUseID)?.questions;
  // Approving a question without an answer only moves it to the terminal —
  // allowed, but only when asked for by name, never as a generic Approve.
  if (question && msg.decision === "allow" && !msg.answerInTerminal) {
    refuse("needs_answer", NEEDS_ANSWER, msg.toolUseID);
    return;
  }
  const outcome = question && msg.decision === "deny"
    ? resolvePermission(msg.toolUseID, "deny", "The user dismissed this question from their phone without answering.", false)
    : resolvePermission(msg.toolUseID, msg.decision, msg.message, msg.decision === "deny");
  if (!outcome.ok) {
    refuse("stale", STALE_EXPLANATION, msg.toolUseID);
    return;
  }
  echoUser(
    question
      ? msg.decision === "allow" ? "Answer it in the terminal" : "Dismissed the question"
      : msg.decision === "allow" ? "Approved" : "Denied",
    record && { id: record.session_id, projectTag: record.project_tag },
    "permission_decision",
  );
  ack(true, { action: "resolved", toolUseID: msg.toolUseID, decision: msg.decision });
}

// An answer from the question card.
function handleAnswer(msg: Extract<InboundMessage, { type: "answer" }>, ack: Ack, refuse: Refuse): void {
  const p = listPendingPermissions().find((x) => x.toolUseID === msg.toolUseID);
  if (!p) {
    refuse("stale", STALE_EXPLANATION, msg.toolUseID);
    return;
  }
  if (!p.questions) {
    refuse("needs_answer", "That request isn't a question — use Approve or Deny.", msg.toolUseID);
    return;
  }
  const checked = validateAnswers(p.questions, msg.answers);
  if (!checked.ok) {
    refuse("needs_answer", checked.error, msg.toolUseID);
    return;
  }
  resolvePermission(p.toolUseID, "allow", undefined, undefined, checked.answers);
  echoUser(`Answered: ${describeAnswers(checked.answers)}`, { id: p.sessionId, projectTag: p.projectTag }, "permission_decision");
  ack(true, { action: "answered", toolUseID: p.toolUseID });
}

function handleChat(msg: Extract<InboundMessage, { type: "chat" }>, ack: Ack, refuse: Refuse): void {
  const text = msg.content;
  const active = listActiveSessions().filter((s) => s.id !== LEGACY_TEST_SESSION_ID);

  if (STATUS_RE.test(text)) {
    echoUser(text);
    say(statusText(active));
    ack(true, { action: "status" });
    return;
  }

  // "open <project>" is never a reply to a pending permission, so it's
  // handled before any of that logic — otherwise a request pending on some
  // *other* project could intercept it as ambiguous guidance.
  if (OPEN_RE.test(text)) {
    handleOpen(text, active, ack, refuse);
    return;
  }

  if (SEND_NOW_RE.test(text)) {
    handleSendNow(text, msg.replyToSession?.sessionId, ack, refuse);
    return;
  }

  // Answering a "which project?" list. Checked after a fresh "open" (which
  // simply replaces the list) but before anything else, so the answer can't
  // be taken as free text for the reply target or a pending request.
  if (msg.openChoice) {
    handleOpenChoice(msg.openChoice, text, active, ack, refuse);
    return;
  }

  const pending = listPendingPermissions();
  const mention = findMentionedTag(text, [
    ...active.map((s) => s.project_tag),
    ...pending.map((p) => p.projectTag),
  ]);
  const verb = mention ? mention.rest : text;
  const intent = YES_RE.test(verb) ? "allow" : NO_RE.test(verb) ? "deny" : "guidance";

  // --- The composer's reply target, when nothing more explicit applies ---
  // It stands in for naming the project, but only for free text: it never
  // chooses which request a YES/NO answers, and a project named in the
  // message always wins over it.
  let anchor: SessionRecord | undefined;
  if (msg.replyToSession && !mention && intent === "guidance") {
    const s = getSession(msg.replyToSession.sessionId);
    if (!s || s.status === "done" || s.status === "error") {
      const tag = s?.project_tag;
      refuse(
        "target_ended",
        tag
          ? `The ${tag} session you were replying to has ended — nothing was sent. Say "open ${tag} <instruction>" to start a new one.`
          : "The session you were replying to no longer exists — nothing was sent. Name the project you mean.",
      );
      return;
    }
    const changedMsAgo = msg.replyToSession.changedMsAgo;
    if (changedMsAgo === undefined || changedMsAgo < FRESH_GUARD_MS) {
      refuse(
        "fresh",
        `Your reply target just switched to ${s.project_tag}. Check that's who you meant, then send again.`,
      );
      return;
    }
    anchor = s;
  }
  const scopeTag = mention?.tag ?? anchor?.project_tag;

  // --- Which pending request (if any) is this reply about? ---
  let target: (typeof pending)[number] | undefined;
  const replyToRecord = msg.replyTo ? getPermission(msg.replyTo) : undefined;
  const replyToApplies = msg.replyTo && (!scopeTag || replyToRecord?.project_tag === scopeTag);

  if (replyToApplies) {
    target = pending.find((p) => p.toolUseID === msg.replyTo);
    if (!target) {
      refuse("stale", STALE_EXPLANATION, msg.replyTo);
      return;
    }
  } else {
    const candidates = scopeTag ? pending.filter((p) => p.projectTag === scopeTag) : pending;
    if (candidates.length > 1) {
      const projects = [...new Set(candidates.map((p) => p.projectTag))];
      refuse(
        "ambiguous",
        projects.length > 1
          ? `Multiple projects are waiting on you: ${projects.join(", ")}. Say which one you mean, or use the buttons.`
          : `${projects[0]} has ${candidates.length} requests waiting. Use the buttons on the one you mean.`,
      );
      return;
    }
    target = candidates[0];
  }

  if (target) {
    if (Date.now() - target.requestedAt < FRESH_GUARD_MS) {
      refuse(
        "fresh",
        `A new request from ${target.projectTag} (${target.toolName}) just arrived. Check it, then reply again.`,
        target.toolUseID,
      );
      return;
    }
    // A typed reply to a question is its answer: an option number or label,
    // or free text. A bare yes/no isn't one.
    if (target.questions) {
      const parsed = intent === "guidance" ? answersFromText(target.questions, text) : { ok: false as const, error: NEEDS_ANSWER };
      if (!parsed.ok) {
        refuse("needs_answer", parsed.error, target.toolUseID);
        return;
      }
      resolvePermission(target.toolUseID, "allow", undefined, undefined, parsed.answers);
      echoUser(`Answered: ${describeAnswers(parsed.answers)}`, { id: target.sessionId, projectTag: target.projectTag }, "permission_decision");
      ack(true, { action: "answered", toolUseID: target.toolUseID });
      return;
    }
    echoUser(text, { id: target.sessionId, projectTag: target.projectTag }, "permission_decision");
    if (intent === "allow") {
      resolvePermission(target.toolUseID, "allow");
    } else if (intent === "deny") {
      resolvePermission(target.toolUseID, "deny", undefined, true);
    } else {
      // Free-text guidance: deny this specific tool call, let the model
      // incorporate the guidance and decide how to proceed.
      resolvePermission(target.toolUseID, "deny", text, false);
    }
    ack(true, { action: "resolved", toolUseID: target.toolUseID, decision: intent === "allow" ? "allow" : "deny" });
    return;
  }

  // --- Nothing pending to answer. A YES/NO is never a new instruction. ---
  if (intent !== "guidance") {
    if (hasRecentDeadPermission(DEAD_REQUEST_WINDOW_MS)) {
      refuse("stale", STALE_EXPLANATION);
    } else {
      refuse("nothing_pending", mention ? `Nothing from ${mention.tag} is waiting for approval.` : "Nothing is waiting for approval.");
    }
    return;
  }

  if (active.length === 0) {
    echoUser(text);
    refuse("unroutable", "No projects are currently active. Start a claude session in a watched project first.");
    return;
  }

  // Sessions never retire yet, so one project can have several "active"
  // sessions; what matters is whether the choice of *project* is ambiguous.
  // `active` is newest-first, so this picks that project's latest session.
  const activeProjects = new Set(active.map((s) => s.project_tag));
  const session = mention
    ? active.find((s) => s.project_tag === mention.tag)
    : anchor
      ? anchor
      : activeProjects.size === 1
        ? active[0]
        : undefined;
  if (!session) {
    echoUser(text);
    const projects = [...new Set(active.map((s) => s.project_tag))].join(", ");
    refuse("unroutable", `Which project? Active: ${projects}.`);
    return;
  }

  if (!session.cwd) {
    echoUser(text);
    refuse("unroutable", `Can't reach "${session.project_tag}" — missing working directory for that session.`);
    return;
  }

  const messageId = echoUser(text, { id: session.id, projectTag: session.project_tag });
  const outcome = deliver(session, text, messageId);
  ack(true, { action: outcome === "queued" ? "queued" : "instructed", sessionId: session.id });
}

function knownProjectTags(): string[] {
  return [...new Set([...listProjects().map((p) => p.tag), ...listSessions().map((s) => s.project_tag)])];
}

// Resolves which single project an "open" names, or explains why it can't.
// Unlike reply routing, this never picks between candidates: naming two
// projects, or a folder name several registered projects share, is refused
// with the candidates listed. `rest` is the text with the project name(s)
// taken out — the instruction.
type OpenTarget =
  | { kind: "one"; tag: string; rest: string }
  | { kind: "ambiguous"; candidates: { tag: string; cwd?: string }[]; rest: string }
  | { kind: "none" };

function resolveOpenTarget(afterVerb: string, known: string[]): OpenTarget {
  const cwdOf = (tag: string) => findLaunchableCwd(tag);
  const restWithout = (spans: TagMatch[]) => {
    let out = afterVerb;
    for (const m of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + out.slice(m.end);
    return trimRest(out.replace(/\s+(and|or)\s+/gi, " ").replace(/\s{2,}/g, " "));
  };

  const matches = findAllMentionedTags(afterVerb, known);
  if (matches.length === 1) return { kind: "one", tag: matches[0].tag, rest: restWithout(matches) };
  if (matches.length > 1) {
    return { kind: "ambiguous", candidates: matches.map((m) => ({ tag: m.tag, cwd: cwdOf(m.tag) })), rest: restWithout(matches) };
  }

  // No tag named outright — try the folder name. A project may have been
  // disambiguated at registration ("payments-api", "api (NOBLEABLE-BE)"),
  // but "api" is still what you'd naturally type.
  const byFolder = new Map<string, string[]>();
  for (const p of listProjects()) {
    const folder = path.basename(p.cwd);
    if (folder === p.tag) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), p.tag]);
  }
  const folderMatches = findAllMentionedTags(afterVerb, [...byFolder.keys()]);
  if (folderMatches.length === 0) return { kind: "none" };
  const tagsForMatches = [...new Set(folderMatches.flatMap((m) => byFolder.get(m.tag)!))];
  if (folderMatches.length === 1 && tagsForMatches.length === 1) {
    return { kind: "one", tag: tagsForMatches[0], rest: restWithout(folderMatches) };
  }
  return { kind: "ambiguous", candidates: tagsForMatches.map((tag) => ({ tag, cwd: cwdOf(tag) })), rest: restWithout(folderMatches) };
}

// An ambiguous "open" leaves an answerable list behind. The reply that
// answers it carries the list's id (the composer shows it's in choosing
// mode), so completing the open is explicit — never inferred from "the last
// thing Jarvis said was a question". Only the newest list is answerable.
const OPEN_CHOICE_TTL_MS = 10 * 60_000;
const openChoices = new Map<string, { candidates: string[]; instruction: string; createdAt: number }>();

function offerOpenChoice(candidates: { tag: string; cwd?: string }[], instruction: string, refuse: Refuse, lead: string): void {
  openChoices.clear();
  const choiceId = randomUUID();
  openChoices.set(choiceId, { candidates: candidates.map((c) => c.tag), instruction, createdAt: Date.now() });
  const lines = candidates.map((c, i) => `${i + 1}. ${c.tag}${c.cwd ? ` — ${prettyPath(c.cwd)}` : ""}`);
  refuse("ambiguous", `${lead} Reply with a number or tap one:\n${lines.join("\n")}`, undefined, {
    choiceId,
    choices: candidates.map((c) => ({ tag: c.tag, detail: c.cwd ? prettyPath(c.cwd) : undefined })),
  });
}

// "open <project>" or "open <project> <instruction>".
function handleOpen(text: string, active: SessionRecord[], ack: Ack, refuse: Refuse): void {
  const afterVerb = text.replace(OPEN_RE, "").trim();
  const known = knownProjectTags();
  const target = resolveOpenTarget(afterVerb, known);

  if (target.kind === "none") {
    echoUser(text);
    const list = known.length ? known.join(", ") : "none yet — run `npm run watch-project <path>` first";
    refuse("unknown_project", `Don't know that project. Known: ${list}.`);
    return;
  }
  if (target.kind === "ambiguous") {
    echoUser(text);
    offerOpenChoice(target.candidates, cleanInstruction(target.rest), refuse, "That matches more than one project.");
    return;
  }
  openProject(target.tag, cleanInstruction(target.rest), text, active, ack, refuse);
}

// A reply answering an open-choice list: a number ("2", "2 check the logs"),
// a tapped option, or the option's full name. Anything typed after the pick
// replaces the original instruction. A reply that doesn't pick exactly one
// option gets the list again; it never falls through to other routing.
function handleOpenChoice(choiceId: string, text: string, active: SessionRecord[], ack: Ack, refuse: Refuse): void {
  const choice = openChoices.get(choiceId);
  if (!choice || Date.now() - choice.createdAt > OPEN_CHOICE_TTL_MS) {
    openChoices.delete(choiceId);
    echoUser(text);
    refuse("stale", `That list was already answered or has expired — nothing was sent. Say "open <project>" again.`);
    return;
  }

  let picked: string | undefined;
  let rest = "";
  const numbered = /^#?(\d+)(?:[.):]|\s|$)\s*([\s\S]*)$/.exec(text.trim());
  if (numbered) {
    picked = choice.candidates[Number(numbered[1]) - 1];
    rest = numbered[2];
  } else {
    const matches = findAllMentionedTags(text, choice.candidates);
    if (matches.length === 1) {
      picked = matches[0].tag;
      rest = trimRest(text.slice(0, matches[0].start) + text.slice(matches[0].end));
    }
  }

  const candidates = choice.candidates.map((tag) => ({ tag, cwd: findLaunchableCwd(tag) }));
  if (!picked) {
    echoUser(text);
    offerOpenChoice(candidates, choice.instruction, refuse, "That didn't pick exactly one of these.");
    return;
  }
  openChoices.delete(choiceId);
  openProject(picked, cleanInstruction(rest) || choice.instruction, text, active, ack, refuse);
}

function cleanInstruction(rest: string): string {
  return rest.replace(/^(to|and)\s+/i, "").trim();
}

// Opens one resolved project: routes to its running session if it has one,
// otherwise launches a new session there. Launching always requires an
// instruction; there's no default prompt to guess at what it should do.
function openProject(tag: string, instruction: string, text: string, active: SessionRecord[], ack: Ack, refuse: Refuse): void {
  const existingSession = active.find((s) => s.project_tag === tag);

  // A session that's still starting counts as open: it's never launched twice,
  // and a message for a busy session waits for its turn to end.
  if (existingSession) {
    const messageId = echoUser(text, { id: existingSession.id, projectTag: tag });
    if (!instruction) {
      const b = busy.get(existingSession.id);
      const stillStarting = b?.kind === "launch";
      say(
        stillStarting
          ? `"${tag}" is still starting — it'll take messages once its first turn finishes.`
          : b
            ? `"${tag}" is open, with a turn in progress.`
            : `"${tag}" is already open.`,
      );
      ack(true, { action: stillStarting ? "starting" : "already_open", sessionId: existingSession.id });
      return;
    }
    const outcome = deliver(existingSession, instruction, messageId);
    ack(true, { action: outcome === "queued" ? "queued" : "instructed", sessionId: existingSession.id });
    return;
  }

  if (!instruction) {
    echoUser(text, { projectTag: tag });
    refuse("needs_instruction", `Say what you want "${tag}" to do, e.g. "open ${tag} check for lint errors".`);
    return;
  }

  const cwd = findLaunchableCwd(tag);
  if (!cwd) {
    echoUser(text, { projectTag: tag });
    refuse("unknown_project", `"${tag}" isn't watched yet — run \`npm run watch-project <path>\` for it first.`);
    return;
  }

  registerProject(tag, cwd); // bumps last_used_at; self-heals if only known via an old session
  const sessionId = spawnFresh(tag, cwd, instruction);
  echoUser(text, { id: sessionId, projectTag: tag });
  ack(true, { action: "launching", projectTag: tag, sessionId });
}
