import crypto from "node:crypto";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { upsertSession, addMessage, getLastMessageContent, getSession, listSessions } from "../db.js";
import { registerPendingPermission, cancelPermission } from "../agent/permissions.js";
import { notify } from "../notifier.js";
import { deriveProjectTag } from "./projectTag.js";
import { readLastAssistantText } from "./transcript.js";

// A session's display name is fixed the first time we see it, so it can't
// drift mid-conversation if a later, unrelated session happens to collide.
function resolveProjectTag(sessionId: string, cwd: string): string {
  const existing = getSession(sessionId);
  if (existing) return existing.project_tag;
  return deriveProjectTag(cwd, listSessions());
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

export async function handlePermissionRequest(body: any, connectionClosed: AbortSignal): Promise<object | null> {
  const sessionId = body.session_id;
  const cwd = body.cwd;
  const toolName = body.tool_name;
  const toolInput = body.tool_input ?? {};
  const projectTag = resolveProjectTag(sessionId, cwd);

  upsertSession(sessionId, projectTag, "waiting_permission", { cwd });

  const toolUseID = crypto.randomUUID();
  const content = `Permission requested: ${toolName}(${JSON.stringify(toolInput)}). Reply YES/NO or give new instructions.`;
  addMessage(sessionId, "out", "permission_request", content, toolUseID);

  const decisionPromise = new Promise<PermissionResult | null>((resolve) => {
    registerPendingPermission(toolUseID, {
      sessionId,
      projectTag,
      toolName,
      input: toolInput,
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
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
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
  return {};
}
