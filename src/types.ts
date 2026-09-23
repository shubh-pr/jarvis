export type SessionStatus =
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
  | "idle_nudge";

export interface MessageRecord {
  id: number;
  session_id: string;
  direction: MessageDirection;
  type: MessageType;
  content: string;
  created_at: number;
  tool_use_id: string | null;
}

export type PermissionStatus = "pending" | "allowed" | "denied" | "stale" | "cancelled";

export interface PermissionRecord {
  tool_use_id: string;
  session_id: string;
  project_tag: string;
  tool_name: string;
  content: string;
  status: PermissionStatus;
  created_at: number;
  resolved_at: number | null;
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
