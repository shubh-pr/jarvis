import type { AgentAdapter } from "./types.js";
import { claude } from "./claude/index.js";

export type { AgentAdapter, AgentEvent, Decision } from "./types.js";

const adapters: Record<string, AgentAdapter> = { [claude.id]: claude };

// What a project runs when nothing says otherwise. Rows stored before
// adapters existed have this as their column default.
export const DEFAULT_AGENT = claude.id;

export function getAdapter(id: string): AgentAdapter {
  const adapter = adapters[id];
  if (!adapter) throw new Error(`Unknown agent "${id}" — no adapter is registered for it.`);
  return adapter;
}

// A session's agent is fixed when it's first seen: the adapter that
// reported it, or the project's agent for a session Jarvis launched.
export function adapterFor(rec: { agent?: string | null }): AgentAdapter {
  return getAdapter(rec.agent || DEFAULT_AGENT);
}
