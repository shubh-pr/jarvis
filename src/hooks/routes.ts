import crypto from "node:crypto";
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
import { onTurnEnded, onTurnActivity, isJarvisTurn } from "../agent/router.js";
import { questionContent } from "../agent/questions.js";
import { summaryText } from "../agent/describe.js";
import type { AgentAdapter, Decision } from "../agent/adapters/index.js";

// Every handler takes the adapter for the agent that reported the event (the
// hook URLs a project was set up with decide which), and reads the event
// only through it.

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

export async function handleSessionStart(adapter: AgentAdapter, body: any): Promise<object> {
  const { sessionId, cwd } = adapter.parseEvent(body);
  const projectTag = resolveProjectTag(sessionId, cwd);

  upsertSession(sessionId, projectTag, "running", { cwd, agent: adapter.id });
  const content = `Session started for project "${projectTag}".`;
  addMessage(sessionId, "out", "chat", content);
  await notify({ sessionId, projectTag, type: "chat", content });
  return {};
}

// A prompt was submitted — a turn is starting, in a terminal or anywhere
// else. Marks the session busy so nothing is sent into it until Stop.
export async function handleUserPromptSubmit(adapter: AgentAdapter, body: any): Promise<object> {
  const { sessionId, cwd, prompt } = adapter.parseEvent(body);
  const projectTag = resolveProjectTag(sessionId, cwd);
  const existing = getSession(sessionId);
  // A prompt typed in a terminal is part of the project's history. One Jarvis
  // sent is already recorded as your message, so it isn't stored twice.
  const typedInTerminal = !isJarvisTurn(sessionId) && typeof prompt === "string" && prompt.trim();
  upsertSession(sessionId, projectTag, existing?.status === "starting" ? "starting" : "running", { cwd, agent: adapter.id });
  onTurnActivity(sessionId, projectTag);
  if (typedInTerminal) {
    addMessage(sessionId, "in", "prompt", prompt.trim());
    await notify({ sessionId, projectTag, type: "prompt", content: prompt.trim() });
  }
  return {};
}

export async function handlePermissionRequest(
  adapter: AgentAdapter,
  body: any,
  connectionClosed: AbortSignal,
): Promise<object | null> {
  const event = adapter.parseEvent(body);
  const { sessionId, cwd } = event;
  const toolName = event.toolName!;
  const toolInput = event.toolInput ?? {};
  const projectTag = resolveProjectTag(sessionId, cwd);

  upsertSession(sessionId, projectTag, "waiting_permission", { cwd, agent: adapter.id });
  onTurnActivity(sessionId, projectTag); // a permission request only ever happens mid-turn

  const toolUseID = crypto.randomUUID();
  const questions = adapter.parseQuestions(toolName, toolInput);
  const summary = questions ? undefined : adapter.describeTool(toolName, toolInput, cwd);
  const content = questions ? questionContent(questions, adapter.name) : summaryText(summary!);
  addMessage(sessionId, "out", "permission_request", content, toolUseID);

  const decisionPromise = new Promise<Decision | null>((resolve) => {
    registerPendingPermission(toolUseID, {
      agentName: adapter.name,
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
  return adapter.formatDecision(decision, toolInput);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleStop(adapter: AgentAdapter, body: any): Promise<object> {
  const { sessionId, cwd, transcriptRef: transcriptPath } = adapter.parseEvent(body);
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
      const candidate = adapter.lastReply(transcriptPath);
      if (candidate && candidate !== previous) {
        text = candidate;
        break;
      }
    }
  }
  const content = text || "Turn ended.";

  // Not terminal: the conversation stays resumable so a follow-up chat
  // message can continue this same session (§3.2).
  upsertSession(sessionId, projectTag, "waiting_input", { cwd, transcriptPath, agent: adapter.id });
  addMessage(sessionId, "out", "completion", content);
  await notify({ sessionId, projectTag, type: "completion", content });
  // A session Jarvis launched is ready once its first turn ends; this sends
  // anything that was queued for it while it was starting.
  onTurnEnded(sessionId, text ?? undefined);
  return {};
}
