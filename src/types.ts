export type SessionStatus =
  | "starting"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "idle"
  | "done"
  | "error";

export interface SessionRecord {
  id: string;
  project_tag: string;
  status: SessionStatus;
  last_event_at: number;
  transcript_path: string | null; // the agent's own transcript reference
  cwd: string | null;
  created_at: number;
  agent: string; // which adapter runs it (agent/adapters), fixed at first sight
}

export type MessageDirection = "out" | "in";

export type MessageType =
  | "chat"
  | "permission_request"
  | "permission_decision"
  | "completion"
  | "error"
  | "idle_nudge"
  | "prompt" // a prompt you typed in a terminal session
  | "sent_external"; // a summary you sent to a colleague (e.g. on Google Chat)

export interface MessageRecord {
  id: number;
  session_id: string;
  direction: MessageDirection;
  type: MessageType;
  content: string;
  created_at: number;
  tool_use_id: string | null;
}

export type PermissionStatus = "pending" | "allowed" | "answered" | "denied" | "stale" | "cancelled";

// A multiple-choice question an agent asks (for Claude, its AskUserQuestion
// tool, read by agent/adapters/claude/questions.ts): real questions that
// need an answer, not a yes/no on whether a command may run.
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PermissionRecord {
  tool_use_id: string;
  session_id: string;
  project_tag: string;
  tool_name: string;
  content: string;
  status: PermissionStatus;
  created_at: number;
  resolved_at: number | null;
  questions: string | null; // JSON Question[] when the request is a question
  summary: string | null; // JSON RequestSummary: the plain-English card
}

export interface ProjectRecord {
  tag: string;
  cwd: string;
  created_at: number;
  last_used_at: number;
  agent: string; // what "open <project>" launches; each session keeps its own
}

export interface PushSubscriptionRecord {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}
