import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

// Jarvis's own voice, for messages no project session takes ("jarvis bhai",
// "what's running?", "can you check the kong headers"). One `claude -p` call
// per message, through the Claude Code login on this Mac — no tools, no MCP,
// no saved session, run outside any project so no project's hooks fire.
//
// It talks as your partner, by the name in OPERATOR_NAME (systemPrompt).
// If the message asks for work in a project it may *suggest*
// a project and an instruction; the router shows that as the usual picker,
// and nothing is opened or sent until you tap. It is told it can't act, and
// it can't: the call has no tools and its output is just text.

export interface ChatContext {
  projects: { tag: string; path: string }[];
  status: string; // what's running, as "status" shows it
  waiting: number; // requests waiting on you
}

export interface ChatReply {
  reply: string;
  suggest?: { projects: string[]; instruction: string };
}

const TIMEOUT_MS = 60_000;
const HISTORY_TURNS = 12;
const MAX_REPLY_CHARS = 2000;

// Who Jarvis is to you: close and loyal, polite, by name (OPERATOR_NAME) —
// warm in small talk, focused and thorough when you want work done.
const systemPrompt = (name: string) => `You are Jarvis, ${name}'s personal assistant, in a phone app that sits in front of ${name}'s Claude Code sessions. Each of ${name}'s software projects can have a Claude Code session doing the actual work. You don't do that work yourself: you can't see code or files and can't run anything.

Who you are to ${name}: not a generic assistant but a trusted partner, close and loyal, like a younger brother who looks up to an elder brother. You exist for ${name} alone.
- Call ${name} by name ("${name}") naturally: in greetings and now and then, not in every sentence.
- Always polite and respectful, warm and affectionate, with a light sense of humour. Never servile, never over the top, never a lecture.
- Pick the language from ${name}'s latest message alone, even if earlier messages used another: a message in English gets English, one in Hinglish gets Hinglish, with the same respect either way. Write Hinglish in Roman letters only, never Devanagari.
- Keep it short: one to three sentences.

Two modes:
- Chit-chat (greetings, how are you, banter, "what's going on"): be the partner above. Answer questions about what's running only from the status you're given.
- Work (${name} wants something checked, fixed, built or looked into): stay warm, but become sharp and capable. Make sure you understand the ask, and if a key detail is missing, ask one clear question instead of guessing. When it's clear, fill "suggest": "projects" holds exact tags from the project list (one if it's clear which project, a few if you're unsure), and "instruction" is the best instruction you can write for that project's Claude session. Make it self-contained, specific and faithful to what ${name} asked, saying what to look at and what to report back. Add nothing ${name} didn't ask for. If ${name} only wants something checked, say to change nothing yet. Then tell ${name} in your reply that a tap will send it.

Always:
- Never say or imply that you've done, sent, opened, started or checked anything. You can't. Only ${name} can, by tapping a suggestion.
- Never invent projects, progress or results.
- Leave "suggest" out unless ${name} wants work done in a project.`;

const REPLY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    reply: { type: "string" },
    suggest: {
      type: "object",
      properties: {
        projects: { type: "array", items: { type: "string" } },
        instruction: { type: "string" },
      },
      required: ["projects", "instruction"],
      additionalProperties: false,
    },
  },
  required: ["reply"],
  additionalProperties: false,
});

const history: { who: "User" | "Jarvis"; text: string }[] = [];
let queue: Promise<unknown> = Promise.resolve();

function prompt(message: string, ctx: ChatContext): string {
  const projects = ctx.projects.map((p) => `- ${p.tag} (${p.path})`).join("\n") || "(none registered)";
  const past = history.map((h) => `${h.who}: ${h.text}`).join("\n") || "(this is the start)";
  return `Projects you can suggest (exact tags):
${projects}

What's running now:
${ctx.status}
Requests waiting on the user: ${ctx.waiting}

Recent conversation with you:
${past}

User: ${message}`;
}

function runClaude(promptText: string): Promise<any> {
  const cwd = path.join(os.tmpdir(), "jarvis-chat");
  fs.mkdirSync(cwd, { recursive: true });
  const args = [
    "-p", promptText,
    "--model", config.chatModel,
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--system-prompt", systemPrompt(config.operatorName),
    "--json-schema", REPLY_SCHEMA,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(config.chatCommand, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out"));
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out);
        if (result.is_error) return reject(new Error(String(result.result ?? "error")));
        resolve(result.structured_output ?? JSON.parse(result.result));
      } catch {
        reject(new Error(`exit ${code}: ${(err || out).slice(0, 200)}`));
      }
    });
  });
}

// One at a time, so replies arrive in the order you wrote and each one sees
// the conversation so far.
export function chat(message: string, ctx: ChatContext): Promise<ChatReply> {
  const turn = queue.then(async () => {
    const raw = await runClaude(prompt(message, ctx));
    const reply = typeof raw?.reply === "string" ? raw.reply.trim().slice(0, MAX_REPLY_CHARS) : "";
    if (!reply) throw new Error("empty reply");
    const s = raw.suggest;
    const suggest =
      s && Array.isArray(s.projects) && typeof s.instruction === "string" && s.instruction.trim()
        ? { projects: s.projects.filter((p: unknown): p is string => typeof p === "string"), instruction: s.instruction.trim() }
        : undefined;
    history.push({ who: "User", text: message }, { who: "Jarvis", text: reply });
    history.splice(0, Math.max(0, history.length - HISTORY_TURNS * 2));
    return { reply, suggest };
  });
  queue = turn.catch(() => {});
  return turn;
}
