import { spawn } from "node:child_process";
import { listActiveSessions, addMessage, getPermission, hasRecentDeadPermission } from "../db.js";
import { resolvePermission, listPendingPermissions } from "./permissions.js";
import { broadcast, type InboundMessage, type Reply } from "../wsServer.js";
import type { SessionRecord } from "../types.js";

const LEGACY_TEST_SESSION_ID = "shell-test";

const YES_RE = /^(y|yes|approve|allow|ok|okay|sure|go ahead)$/i;
const NO_RE = /^(n|no|deny|reject|stop|cancel)$/i;
const STATUS_RE = /^(status|what'?s running|list projects?|what.*(projects?|running))\b/i;

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

type RefusalReason = "stale" | "ambiguous" | "fresh" | "nothing_pending" | "unroutable";

function say(content: string): void {
  broadcast({ direction: "out", type: "chat", content, tag: "jarvis" });
}

function tell(reply: Reply, content: string): void {
  reply({ direction: "out", type: "chat", content, tag: "jarvis" });
}

function echoUser(text: string, session?: { id: string; projectTag: string }, type: "chat" | "permission_decision" = "chat"): void {
  if (session) addMessage(session.id, "in", type, text);
  broadcast({
    direction: "in",
    type,
    content: text,
    tag: session?.projectTag ?? "you",
    sessionId: session?.id,
    projectTag: session?.projectTag,
  });
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
  return { tag: best.tag, rest: best.rest.replace(/^[\s,.:;!-]+|[\s,.:;!-]+$/g, "") };
}

function statusText(active: SessionRecord[]): string {
  if (active.length === 0) return "No projects are currently active.";
  const pendingBySession = new Map(listPendingPermissions().map((p) => [p.sessionId, p]));
  const lines = active.map((s) => {
    const p = pendingBySession.get(s.id);
    if (p) return `• ${s.project_tag} — waiting on you: ${p.toolName}`;
    if (s.status === "waiting_input") return `• ${s.project_tag} — idle, ready for your next instruction`;
    return `• ${s.project_tag} — ${s.status}`;
  });
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
    const payload = { type: "ack", clientId: msg.clientId, ok, ...extra };
    if (msg.clientId) {
      seenClientIds.set(msg.clientId, payload);
      if (seenClientIds.size > SEEN_LIMIT) seenClientIds.delete(seenClientIds.keys().next().value!);
    }
    reply(payload);
  };
  const refuse = (reason: RefusalReason, explanation: string, toolUseID?: string) => {
    tell(reply, explanation);
    ack(false, { reason, toolUseID });
  };

  try {
    if (msg.type === "decision") {
      handleDecision(msg, ack, refuse);
    } else {
      handleChat(msg, ack, refuse);
    }
  } catch (err) {
    console.error("Failed to handle inbound message:", err);
    ack(false, { reason: "error" });
  }
}

type Ack = (ok: boolean, extra?: Record<string, unknown>) => void;
type Refuse = (reason: RefusalReason, explanation: string, toolUseID?: string) => void;

function handleDecision(msg: Extract<InboundMessage, { type: "decision" }>, ack: Ack, refuse: Refuse): void {
  const record = getPermission(msg.toolUseID);
  const outcome = resolvePermission(msg.toolUseID, msg.decision, msg.message, msg.decision === "deny");
  if (!outcome.ok) {
    refuse("stale", STALE_EXPLANATION, msg.toolUseID);
    return;
  }
  echoUser(
    msg.decision === "allow" ? "Approved" : "Denied",
    record && { id: record.session_id, projectTag: record.project_tag },
    "permission_decision",
  );
  ack(true, { action: "resolved", toolUseID: msg.toolUseID, decision: msg.decision });
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

  const pending = listPendingPermissions();
  const mention = findMentionedTag(text, [
    ...active.map((s) => s.project_tag),
    ...pending.map((p) => p.projectTag),
  ]);
  const verb = mention ? mention.rest : text;
  const intent = YES_RE.test(verb) ? "allow" : NO_RE.test(verb) ? "deny" : "guidance";

  // --- Which pending request (if any) is this reply about? ---
  let target: (typeof pending)[number] | undefined;
  const replyToRecord = msg.replyTo ? getPermission(msg.replyTo) : undefined;
  const replyToApplies = msg.replyTo && (!mention || replyToRecord?.project_tag === mention.tag);

  if (replyToApplies) {
    target = pending.find((p) => p.toolUseID === msg.replyTo);
    if (!target) {
      refuse("stale", STALE_EXPLANATION, msg.replyTo);
      return;
    }
  } else {
    const candidates = mention ? pending.filter((p) => p.projectTag === mention.tag) : pending;
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

  echoUser(text, { id: session.id, projectTag: session.project_tag });

  // The project's own hooks (PermissionRequest/Stop) handle everything from
  // here — this just injects the next turn into that session's history.
  const child = spawn("claude", ["--resume", session.id, "--print", text], {
    cwd: session.cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", (err) => {
    say(`Failed to reach "${session.project_tag}": ${err.message}`);
  });
  child.on("exit", (code) => {
    if (code) say(`claude exited with code ${code} while handling your message for "${session.project_tag}".`);
  });
  ack(true, { action: "instructed", sessionId: session.id });
}
