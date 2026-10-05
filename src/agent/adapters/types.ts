import type { ChildProcess } from "node:child_process";
import type { Question } from "../../types.js";
import type { Answers } from "../questions.js";
import type { RequestSummary } from "../describe.js";

// Everything Jarvis needs from a coding agent, in one place. The router,
// the approval cards, history, search and the PWA only ever talk to an
// agent through this interface; nothing outside an adapter's own folder
// knows its command line, its event payloads or its transcript format.
//
// The standard every adapter must meet to get full control (launch, resume,
// approve/deny from the phone) — see ARCHITECTURE.md, "Agent adapters":
// the agent must be able to hold a tool call open until you answer, with no
// time limit and no default action. An agent that can't is observe-only, or
// isn't supported.
//
// Reporting live activity (which tool is running) is optional. An agent that
// doesn't report it gets the working indicator's timer without the action
// line. Activity is observe-only, always: whatever carries it must never be
// able to answer for you — see "Observe-only hooks" in ARCHITECTURE.md.

// What you decided on a held request, in Jarvis's own terms. Each adapter
// turns it into whatever its agent expects back.
export type Decision =
  | { behavior: "allow"; answers?: Answers }
  | { behavior: "deny"; message: string; interrupt?: boolean };

// One event reported by an agent (session start, prompt submitted,
// permission request, tool activity, turn end), in Jarvis's own terms.
export interface AgentEvent {
  sessionId: string;
  cwd: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // Activity events: the agent's own ID for the tool call (pairs a start
  // with its finish), and the subagent that made it, if one did.
  toolUseId?: string;
  subagent?: { id: string; type: string };
  // Where the agent keeps the session's transcript, if it has one; stored
  // as sessions.transcript_path and only ever read back by the same adapter.
  transcriptRef?: string | null;
  prompt?: string;
}

export interface TurnTarget {
  sessionId: string;
  cwd: string;
  text: string;
}

export interface InstallOptions {
  jarvisPort: string;
  hooksSecret: string;
  withPermissions: boolean;
  // Folders outside the repo that reading shouldn't prompt for.
  readDirs: string[];
}

export interface AgentAdapter {
  // Stored in sessions.agent / projects.agent. Never change it once used.
  id: string;
  // How the agent is named in messages ("Claude is asking: …").
  name: string;
  // The executable, as named in messages ("claude exited with code 1").
  command: string;

  // Starts a brand-new session with the given ID, or a new turn in an
  // existing one. The process runs detached; the caller watches its exit.
  launch(t: TurnTarget): ChildProcess;
  resume(t: TurnTarget): ChildProcess;

  parseEvent(body: any): AgentEvent;
  // The hook response that carries a decision back to the waiting agent.
  formatDecision(decision: Decision, toolInput: Record<string, unknown>): object;

  // The text of the last reply, or null if it can't be read (yet).
  lastReply(transcriptRef: string): string | null;
  // The folder the session was started in, according to its transcript.
  startFolder(transcriptRef: string): string | undefined;

  // A held request that's really a multiple-choice question, if it is one.
  parseQuestions(toolName: string, input: any): Question[] | undefined;
  // A held request in plain English, for the card.
  describeTool(toolName: string, input: any, cwd: string): RequestSummary;

  // Points the agent's own config in this repo at Jarvis. Returns the
  // number of default permission rules added.
  installProject(projectPath: string, opts: InstallOptions): number;
}
