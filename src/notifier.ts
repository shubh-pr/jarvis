import { broadcast, hasConnectedClients } from "./wsServer.js";
import { broadcastPush } from "./push.js";
import type { MessageType } from "./types.js";

export interface NotifyEvent {
  sessionId: string;
  projectTag: string;
  type: MessageType;
  content: string;
  toolUseID?: string;
}

// Anything that needs a decision is always pushed: "some client is
// connected" doesn't mean the phone is — it may be a laptop tab, or a phone
// socket that died without closing and hasn't been reaped yet.
const ALWAYS_PUSH = new Set<MessageType>(["permission_request", "idle_nudge", "error"]);

const PUSH_TITLES: Partial<Record<MessageType, string>> = {
  permission_request: "JARVIS — permission needed",
  completion: "JARVIS — task complete",
  error: "JARVIS — error",
  idle_nudge: "JARVIS — still waiting",
};

// Push services reject payloads over ~4KB, and an Edit/Write tool input can
// easily exceed that — the full text is in the app, the push just has to arrive.
const PUSH_BODY_MAX = 600;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export async function notify(event: NotifyEvent): Promise<void> {
  broadcast({
    direction: "out",
    type: event.type,
    content: event.content,
    tag: event.projectTag,
    sessionId: event.sessionId,
    projectTag: event.projectTag,
    toolUseID: event.toolUseID,
  });

  const pushTitle = PUSH_TITLES[event.type];
  if (pushTitle && (ALWAYS_PUSH.has(event.type) || !hasConnectedClients())) {
    await broadcastPush({
      title: pushTitle,
      body: truncate(`[${event.projectTag}] ${event.content}`, PUSH_BODY_MAX),
      sessionId: event.sessionId,
      url: "/",
    });
  }
}
