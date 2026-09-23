import path from "node:path";
import type { SessionRecord } from "../types.js";

// Derives a human-friendly project name from a session's working directory,
// disambiguating against any other known session whose folder shares the
// same basename but is actually a different directory (e.g. two projects
// both named "identity" under different parents).
export function deriveProjectTag(cwd: string, knownSessions: SessionRecord[] = []): string {
  const base = path.basename(cwd) || cwd;
  const collision = knownSessions.find(
    (s) => s.project_tag === base && s.cwd && s.cwd !== cwd,
  );
  if (!collision) return base;

  const parent = path.basename(path.dirname(cwd));
  return `${base} (${parent})`;
}
