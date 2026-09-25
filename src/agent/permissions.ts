import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { setSessionStatus, insertPermission, finishPermission, getPermission } from "../db.js";
import { notify } from "../notifier.js";
import { broadcastPermissions } from "../wsServer.js";
import type { Question } from "../types.js";
import type { Answers } from "./questions.js";
import type { RequestSummary } from "./describe.js";

const IDLE_NUDGE_MS = 120_000;

interface PendingPermission {
  sessionId: string;
  projectTag: string;
  toolName: string;
  input: Record<string, unknown>;
  questions?: Question[]; // set for AskUserQuestion: needs an answer, not a yes/no
  summary?: RequestSummary; // the plain-English gist shown on the card
  requestedAt: number;
  resolve: (result: PermissionResult | null) => void;
  nudgeTimer: ReturnType<typeof setInterval>;
}

// Live hook calls that can still be answered. Every request stays here until
// it's explicitly answered or its hook connection goes away — nothing is ever
// resolved on the user's behalf (§0: no default action).
const pending = new Map<string, PendingPermission>();

export type ResolveOutcome =
  | { ok: true }
  | { ok: false; reason: "stale" | "unknown" };

export function registerPendingPermission(
  toolUseID: string,
  entry: Omit<PendingPermission, "requestedAt" | "nudgeTimer"> & { content: string },
): void {
  const requestedAt = Date.now();
  insertPermission({
    tool_use_id: toolUseID,
    session_id: entry.sessionId,
    project_tag: entry.projectTag,
    tool_name: entry.toolName,
    content: entry.content,
    created_at: requestedAt,
    questions: entry.questions ? JSON.stringify(entry.questions) : null,
    summary: entry.summary ? JSON.stringify(entry.summary) : null,
  });

  const nudgeTimer = setInterval(() => {
    notify({
      sessionId: entry.sessionId,
      projectTag: entry.projectTag,
      type: "idle_nudge",
      content: entry.questions
        ? `Claude is still waiting for your answer: ${entry.questions[0].question}`
        : `Still waiting on you: ${entry.summary?.title ?? entry.toolName}`,
      toolUseID,
    });
  }, IDLE_NUDGE_MS);
  pending.set(toolUseID, {
    sessionId: entry.sessionId,
    projectTag: entry.projectTag,
    toolName: entry.toolName,
    input: entry.input,
    questions: entry.questions,
    resolve: entry.resolve,
    requestedAt,
    nudgeTimer,
  });
  broadcastPermissions();
}

// `answers` completes an AskUserQuestion: it's allowed with the answers in
// its input, which is how Claude receives them.
export function resolvePermission(
  toolUseID: string,
  decision: "allow" | "deny",
  message?: string,
  interrupt?: boolean,
  answers?: Answers,
): ResolveOutcome {
  const p = pending.get(toolUseID);
  if (!p) return { ok: false, reason: getPermission(toolUseID) ? "stale" : "unknown" };
  clearInterval(p.nudgeTimer);
  pending.delete(toolUseID);
  finishPermission(toolUseID, decision === "deny" ? "denied" : answers ? "answered" : "allowed");
  setSessionStatus(p.sessionId, "running");
  if (decision === "allow") {
    p.resolve({ behavior: "allow", updatedInput: answers ? { ...p.input, answers } : p.input });
  } else {
    p.resolve({
      behavior: "deny",
      message: message ?? "Denied by user.",
      interrupt,
    });
  }
  broadcastPermissions();
  return { ok: true };
}

// The hook's HTTP connection closed before we answered (Esc in the terminal,
// claude exited, answered locally). Nobody is listening for a decision any
// more, so drop it rather than letting it capture later replies.
export function cancelPermission(toolUseID: string): void {
  const p = pending.get(toolUseID);
  if (!p) return;
  clearInterval(p.nudgeTimer);
  pending.delete(toolUseID);
  finishPermission(toolUseID, "cancelled");
  p.resolve(null);
  broadcastPermissions();
}

export function listPendingPermissions() {
  return [...pending.entries()].map(([toolUseID, p]) => ({
    toolUseID,
    sessionId: p.sessionId,
    projectTag: p.projectTag,
    toolName: p.toolName,
    input: p.input,
    questions: p.questions,
    requestedAt: p.requestedAt,
  }));
}
