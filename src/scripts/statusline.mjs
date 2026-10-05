#!/usr/bin/env node
// Claude Code status line. Prints plan usage ("5h 23% · 7d 41%") and
// forwards just the rate limits to Jarvis, so the phone shows the same bars
// as /usage (src/usage.ts). Nothing else from Claude Code's input — paths,
// transcript, cost — leaves this script.
//
// Install (global ~/.claude/settings.json):
//   "statusLine": { "type": "command", "command": "node <repo>/src/scripts/statusline.mjs" }
//
// Plain JavaScript, no tsx: it runs on every status-line refresh, so it
// starts fast. If Jarvis is down or slow, the line still prints and the
// script exits within REPORT_TIMEOUT_MS.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_TIMEOUT_MS = 500;

function readEnv() {
  try {
    const env = {};
    for (const line of fs.readFileSync(path.join(REPO, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

function percent(w) {
  return w && Number.isFinite(w.used_percentage) ? `${Math.round(w.used_percentage)}%` : undefined;
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
let data = {};
try {
  data = JSON.parse(input);
} catch {}

const limits = data.rate_limits;
const parts = [["5h", percent(limits?.five_hour)], ["7d", percent(limits?.seven_day)]]
  .filter(([, p]) => p)
  .map(([label, p]) => `${label} ${p}`);
process.stdout.write(parts.length ? parts.join(" · ") : (data.model?.display_name ?? ""));

if (limits) {
  const env = readEnv();
  const port = process.env.JARVIS_PORT ?? env.PORT ?? "8787";
  const secret = process.env.HOOKS_SECRET ?? env.HOOKS_SECRET;
  if (secret) {
    await fetch(`http://localhost:${port}/api/hooks/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ rate_limits: { five_hour: limits.five_hour, seven_day: limits.seven_day } }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    }).catch(() => {});
  }
}
