import { spawn } from "node:child_process";
import type { AgentAdapter, TurnTarget } from "../types.js";
import { readLastAssistantText, readStartFolder } from "./transcript.js";
import { parseQuestions } from "./questions.js";
import { describeRequest } from "./describe.js";
import { installProject } from "./install.js";

// Claude Code. Sessions report in through the hooks installProject writes
// (SessionStart, UserPromptSubmit, PermissionRequest — an http hook that
// holds the tool call until Jarvis answers, which is what meets the
// full-control standard — Stop, and the observe-only activity hooks
// PreToolUse / PostToolUse / PostToolUseFailure). New turns are separate
// `claude --print` processes.
//
// Jarvis's own runs are pinned to the default permission mode, so nothing
// it starts can auto-accept edits or skip prompts, whatever a settings file
// says.
function run(args: string[], t: TurnTarget) {
  const child = spawn("claude", ["--permission-mode", "default", ...args, "--print", t.text], {
    cwd: t.cwd,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}

export const claude: AgentAdapter = {
  id: "claude",
  name: "Claude",
  command: "claude",

  // Jarvis picks the session ID, so the session is known before any hook
  // fires (SessionStart hasn't been seen to fire for Jarvis's own runs).
  launch: (t) => run(["--session-id", t.sessionId], t),
  resume: (t) => run(["--resume", t.sessionId], t),

  parseEvent: (body) => ({
    sessionId: body.session_id,
    cwd: body.cwd,
    toolName: body.tool_name,
    toolInput: body.tool_input ?? {},
    transcriptRef: body.transcript_path,
    prompt: body.prompt,
    toolUseId: typeof body.tool_use_id === "string" ? body.tool_use_id : undefined,
    // Present on hooks fired by a subagent's own tool calls.
    subagent: typeof body.agent_id === "string" ? { id: body.agent_id, type: String(body.agent_type ?? "subagent") } : undefined,
  }),

  // Answers to an AskUserQuestion travel in the tool's input; a plain
  // approval leaves the input as Claude sent it.
  formatDecision: (decision, toolInput) => ({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision:
        decision.behavior === "allow"
          ? decision.answers
            ? { behavior: "allow", updatedInput: { ...toolInput, answers: decision.answers } }
            : { behavior: "allow" }
          : { behavior: "deny", message: decision.message, interrupt: decision.interrupt },
    },
  }),

  lastReply: readLastAssistantText,
  startFolder: readStartFolder,
  parseQuestions,
  describeTool: describeRequest,
  installProject,
};
