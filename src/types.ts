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
  transcript_path: string | null;
  cwd: string | null;
  created_at: number;
}

export type MessageDirection = "out" | "in";

export type MessageType =
  | "chat"
  | "permission_request"
  | "permission_decision"
  | "completion"
  | "error"
  | "idle_nudge"
  | "prompt"; // a prompt you typed in a terminal session

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

// Claude's AskUserQuestion tool input: real multiple-choice questions that
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
  questions: string | null; // JSON Question[] when this is an AskUserQuestion
  summary: string | null; // JSON RequestSummary: the plain-English card
}

export interface ProjectRecord {
  tag: string;
  cwd: string;
  created_at: number;
  last_used_at: number;
}

export interface PushSubscriptionRecord {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}
