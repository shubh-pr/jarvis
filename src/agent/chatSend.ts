import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { broadcast, registerConnectSnapshot } from "../wsServer.js";

// Send a one-line summary of a change to a colleague on Google Chat, as you.
// The agreed rules (PROJECT_BRIEF.md §0, 2026-09-25):
// - Recipients come only from contacts.json, which you maintain: exact name
//   match, no guessing, and only @kronovate.com addresses — a permanent
//   restriction, deliberately not configurable.
// - The project's own Claude session drafts the line; you see it on a card,
//   can edit it, and only tapping Send sends. Once sent it's final.
// - A failed send is shown and never retried on its own; when the outcome
//   is unknown (a timeout), you're told to check Chat before sending again.

export const ALLOWED_DOMAIN = "kronovate.com";
const EMAIL_RE = new RegExp(`^[a-z0-9._%+-]+@${ALLOWED_DOMAIN.replace(".", "\\.")}$`);

export interface Contact {
  name: string; // what you type: "send it to Rohan"
  fullName: string;
  email: string;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

// Read on every use, so edits to the file apply at once. Any problem refuses
// the whole file rather than half-loading it.
export function loadContacts(): Result<{ contacts: Contact[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(config.contactsPath, "utf8"));
  } catch (err: any) {
    return {
      ok: false,
      error:
        err?.code === "ENOENT"
          ? `No contacts yet — add them to ${config.contactsPath} as [{"name": "Rohan", "fullName": "Rohan Sharma", "email": "rohan@${ALLOWED_DOMAIN}"}].`
          : `contacts.json couldn't be read (${err.message}), so nothing can be sent until it's fixed.`,
    };
  }
  if (!Array.isArray(raw)) return { ok: false, error: "contacts.json should be a list of contacts." };
  const contacts: Contact[] = [];
  const seen = new Set<string>();
  for (const c of raw as any[]) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    const email = typeof c?.email === "string" ? c.email.trim().toLowerCase() : "";
    if (!name) return { ok: false, error: "A contact in contacts.json has no name." };
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: `"${name}" has the address "${c?.email}". Only @${ALLOWED_DOMAIN} addresses are allowed, so contacts.json is refused until that's fixed.` };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `contacts.json has two contacts named "${name}". Names must be unique, so it's refused until that's fixed.` };
    seen.add(key);
    contacts.push({ name, fullName: typeof c.fullName === "string" && c.fullName.trim() ? c.fullName.trim() : name, email });
  }
  return { ok: true, contacts };
}

// Exact name only (ignoring case): a near-miss is refused, never guessed.
export function findContact(name: string): Result<{ contact: Contact }> {
  const loaded = loadContacts();
  if (!loaded.ok) return loaded;
  const contact = loaded.contacts.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  if (contact) return { ok: true, contact };
  const names = loaded.contacts.map((c) => c.name).join(", ") || "none yet";
  return { ok: false, error: `No contact called "${name.trim()}". Your contacts: ${names}.` };
}

// ---- Drafts: the card's state lives here, on the server ----

export type DraftStatus = "drafting" | "ready" | "sending" | "sent" | "failed" | "cancelled";

export interface Draft {
  id: string;
  sessionId: string;
  projectKey: string;
  projectTag: string;
  to: Contact;
  status: DraftStatus;
  text: string;
  error?: string;
  outcomeUnknown?: boolean;
  createdAt: number;
  sentAt?: number;
}

const DRAFT_KEEP_MS = 24 * 60 * 60 * 1000;
const drafts = new Map<string, Draft>();

export const DRAFT_PROMPT =
  "In one line (under 200 characters), summarize the change you just made in this project, written for a colleague. Reply with only that line — no preamble, quotes or formatting.";

function publicDraft(d: Draft) {
  return { ...d };
}

function broadcastDraft(d: Draft): void {
  broadcast({ type: "draft", draft: publicDraft(d) });
}

registerConnectSnapshot(() => ({
  type: "drafts",
  drafts: [...drafts.values()].filter((d) => Date.now() - d.createdAt < DRAFT_KEEP_MS).map(publicDraft),
}));

export function createDraft(input: Pick<Draft, "sessionId" | "projectKey" | "projectTag" | "to">): Draft {
  const d: Draft = { ...input, id: randomUUID(), status: "drafting", text: "", createdAt: Date.now() };
  drafts.set(d.id, d);
  broadcastDraft(d);
  return d;
}

export function getDraft(id: string): Draft | undefined {
  return drafts.get(id);
}

export function updateDraft(d: Draft, changes: Partial<Draft>): void {
  Object.assign(d, changes);
  broadcastDraft(d);
}

// Claude's reply, as a single line fit to send.
export function cleanDraftText(reply: string): string {
  const line = reply.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/^(summary|here'?s (a|the) summary)\s*[:\-–—]\s*/i, "")
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ---- Google Chat ----
// As you (your OAuth token), into your DM with the person: spaces.setup
// returns the existing DM (or creates it), then messages.create sends.

function accessToken(): string | undefined {
  try {
    const t = JSON.parse(fs.readFileSync(config.googleTokenPath, "utf8"));
    return typeof t?.access_token === "string" && t.access_token ? t.access_token : undefined;
  } catch {
    return undefined;
  }
}

export type SendOutcome = { ok: true } | { ok: false; error: string; outcomeUnknown: boolean };

async function chatCall(path: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${config.googleChatApiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.googleChatTimeoutMs),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export async function sendToChat(email: string, text: string): Promise<SendOutcome> {
  const token = accessToken();
  if (!token) {
    return { ok: false, outcomeUnknown: false, error: "Google Chat isn't connected yet (waiting on the Workspace setup and your one-time sign-in). Nothing was sent." };
  }
  let space: string;
  try {
    const setup = await chatCall("/v1/spaces:setup", token, {
      space: { spaceType: "DIRECT_MESSAGE", singleUserBotDm: false },
      memberships: [{ member: { name: `users/${email}`, type: "HUMAN" } }],
    });
    if (setup.status >= 300 || typeof setup.json?.name !== "string") {
      return { ok: false, outcomeUnknown: false, error: `Google Chat couldn't open your DM with ${email} (${setup.status}${setup.json?.error?.message ? `: ${setup.json.error.message}` : ""}). Nothing was sent.` };
    }
    space = setup.json.name;
  } catch (err: any) {
    // Opening the DM sends nothing, so a failure here is definitely unsent.
    return { ok: false, outcomeUnknown: false, error: `Couldn't reach Google Chat (${err?.name === "TimeoutError" ? "timed out" : err?.message ?? err}). Nothing was sent.` };
  }
  try {
    const sent = await chatCall(`/v1/${space}/messages`, token, { text });
    if (sent.status >= 300) {
      return { ok: false, outcomeUnknown: false, error: `Google Chat refused the message (${sent.status}${sent.json?.error?.message ? `: ${sent.json.error.message}` : ""}). Nothing was sent.` };
    }
    return { ok: true };
  } catch (err: any) {
    // The request may have reached Google before the connection failed.
    return {
      ok: false,
      outcomeUnknown: true,
      error: `The send ${err?.name === "TimeoutError" ? "timed out" : `failed (${err?.message ?? err})`} before Google confirmed it, so it may or may not have gone through. Check your chat with the recipient before sending again.`,
    };
  }
}
