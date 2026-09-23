# JARVIS

A self-hosted notification/remote-control layer for your own independently-running `claude` terminal sessions. It observes and remote-controls sessions you start yourself — it never spawns or owns agent sessions itself.

## Backend (`src/`, Node + TypeScript, `better-sqlite3`, `ws`, `web-push`)

- **`index.ts`** — single HTTP server exposing: passcode login (`/api/login`), web-push subscribe/unsubscribe/test, three hook endpoints, and `/api/agent/resolve` for approving/denying permissions from the UI. Also upgrades to a WebSocket for live chat.
- **`hooks/routes.ts`** — handlers for Claude Code's `SessionStart`, `PermissionRequest`, and `Stop` hooks. `PermissionRequest` blocks (server timeout disabled) until you reply; `Stop` re-reads the session's transcript to pull out the assistant's last message as a "turn complete" notification.
- **`agent/permissions.ts`** — in-memory registry of pending permission requests, one per project (a new request supersedes a stale one), with a 2-minute idle nudge if you haven't answered.
- **`agent/router.ts`** — parses inbound chat replies: `status` lists active projects, YES/NO/free-text resolves a pending permission, and any other text is injected into the right idle project via `claude --resume <id> --print "<text>"` (matched by project name mention, or the sole active project).
- **`notifier.ts` / `push.ts`** — broadcasts events over WebSocket to connected clients, falling back to a real push notification (VAPID keys) only when nobody's connected.
- **`db.ts`** — SQLite schema: `sessions`, `messages`, `push_subscriptions`, `auth_tokens`.
- **`hooks/projectTag.ts`** — derives a stable per-session project name from its cwd.
- **`scripts/watch-project.ts`** — CLI (`npm run watch-project <path>`) that writes the three hooks into a target project's `.claude/settings.local.json`, pointed at your local JARVIS server with a shared `HOOKS_SECRET`.

## Frontend (`public/`)

A small installable PWA (manifest + service worker + icons) — `index.html` / `app.js` / `styles.css` — a passcode-gated chat UI over the WebSocket, showing messages per project and letting you approve/deny/reply to permission prompts from your phone or browser.

## In short

You run `claude` normally in each project's terminal. JARVIS's hooks report session starts, permission requests, and turn completions to a chat-style UI, and you can approve tool calls or send follow-up instructions back — all from a single control panel instead of babysitting each terminal.
