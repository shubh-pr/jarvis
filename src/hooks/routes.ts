import crypto from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  upsertSession,
  addMessage,
  getLastMessageContent,
  getSession,
  listSessions,
  listProjects,
  getProjectByCwd,
} from "../db.js";
import { registerPendingPermission, cancelPermission } from "../agent/permissions.js";
import { notify } from "../notifier.js";
import { deriveProjectTag } from "./projectTag.js";
import { readLastAssistantText } from "./transcript.js";
import { onTurnEnded, onTurnActivity } from "../agent/router.js";
import { parseQuestions, questionContent } from "../agent/questions.js";
import { describeRequest, summaryText } from "../agent/describe.js";

// A session's display name is fixed the first time we see it, so it can't
// drift mid-conversation if a later, unrelated session happens to collide.
function resolveProjectTag(sessionId: string, cwd: string): string {
  const existing = getSession(sessionId);
  if (existing) return existing.project_tag;
  // A registered project's tag wins for its own directory — it may have been
  // disambiguated at registration (e.g. "payments-api" for a folder named
  // "api"), and a session there must carry that same tag or "open" wouldn't
  // recognise it as already running.
  const registered = getProjectByCwd(cwd);
  if (registered) return registered.tag;
  const known = [
    ...listSessions(),
    ...listProjects().map((p) => ({ project_tag: p.tag, cwd: p.cwd })),
  ];
  return deriveProjectTag(cwd, known);
}

export async function handleSessionStart(body: any): Promise<object> {
  const sessionId = body.session_id;
  const cwd = body.cwd;
  const projectTag = resolveProjectTag(sessionId, cwd);

  upsertSession(sessionId, projectTag, "running", { cwd });
  const content = `Session started for project "${projectTag}".`;
  addMessage(sessionId, "out", "chat", content);
  await notify({ sessionId, projectTag, type: "chat", content });
  return {};
}

// A prompt was submitted — a turn is starting, in a terminal or anywhere
// else. Marks the session busy so nothing is sent into it until Stop.
export async function handleUserPromptSubmit(body: any): Promise<object> {
  const sessionId = body.session_id;
  const cwd = body.cwd;
  const projectTag = resolveProjectTag(sessionId, cwd);
  const existing = getSession(sessionId);
  upsertSession(sessionId, projectTag, existing?.status === "starting" ? "starting" : "running", { cwd });
  onTurnActivity(sessionId, projectTag);
  return {};
}

export async function handlePermissionRequest(body: any, connectionClosed: AbortSignal): Promise<object | null> {
  const sessionId = body.session_id;
  const cwd = body.cwd;
  const toolName = body.tool_name;
  const toolInput = body.tool_input ?? {};
  const projectTag = resolveProjectTag(sessionId, cwd);

  upsertSession(sessionId, projectTag, "waiting_permission", { cwd });
  onTurnActivity(sessionId, projectTag); // a permission request only ever happens mid-turn

  const toolUseID = crypto.randomUUID();
  const questions = parseQuestions(toolName, toolInput);
  const summary = questions ? undefined : describeRequest(toolName, toolInput, cwd);
  const content = questions ? questionContent(questions) : summaryText(summary!);
  addMessage(sessionId, "out", "permission_request", content, toolUseID);

  const decisionPromise = new Promise<PermissionResult | null>((resolve) => {
    registerPendingPermission(toolUseID, {
      sessionId,
      projectTag,
      toolName,
      input: toolInput,
      questions,
      summary,
      content,
      resolve,
    });
  });
  if (connectionClosed.aborted) cancelPermission(toolUseID);
  else connectionClosed.addEventListener("abort", () => cancelPermission(toolUseID), { once: true });

  await notify({ sessionId, projectTag, type: "permission_request", content, toolUseID });

  const decision = await decisionPromise;
  if (!decision) return null; // cancelled — the caller has already gone away

  if (decision.behavior === "allow") {
    // Answers to an AskUserQuestion travel in the tool's input; a plain
    // approval leaves the input as Claude sent it.
    const answers = (decision.updatedInput as any)?.answers;
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: answers ? { behavior: "allow", updatedInput: decision.updatedInput } : { behavior: "allow" },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: decision.message,
        interrupt: decision.interrupt,
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleStop(body: any): Promise<object> {
  const sessionId = body.session_id;
  const cwd = body.cwd;
  const transcriptPath = body.transcript_path;
  const projectTag = resolveProjectTag(sessionId, cwd);

  // The transcript's final write can lag slightly behind the Stop hook
  // firing, and a resumed session's transcript already ends with the PRIOR
  // turn's assistant text — so "found some text" isn't enough; keep
  // retrying until it's genuinely new, or we give up and fall back.
  // Stop isn't a blocking/gating hook, so a brief retry here is free.
  const previous = getLastMessageContent(sessionId, "completion");
  let text: string | null = null;
  if (transcriptPath) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await sleep(300);
      const candidate = readLastAssistantText(transcriptPath);
      if (candidate && candidate !== previous) {
        text = candidate;
        break;
      }
    }
  }
  const content = text || "Turn ended.";

  // Not terminal: the conversation stays resumable so a follow-up chat
  // message can continue this same session (§3.2).
  upsertSession(sessionId, projectTag, "waiting_input", { cwd, transcriptPath });
  addMessage(sessionId, "out", "completion", content);
  await notify({ sessionId, projectTag, type: "completion", content });
  // A session Jarvis launched is ready once its first turn ends; this sends
  // anything that was queued for it while it was starting.
  onTurnEnded(sessionId);
  return {};
}
