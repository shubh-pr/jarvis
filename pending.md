# Jarvis — Pending Items (as of this session)

## Branch state
- `main`: has PR #2 (live working indicator), PR #3 (sentence routing), PR #4
  (redesign) merged.
- `feat/jarvis-chat`: committed, **not pushed**. Chat-partner persona
  (talks through your Claude login, calls you "Mr. Prakash" from `.env`,
  can only suggest work, nothing sent without a tap). You confirmed you did
  request this feature yourself in an earlier session — push is on hold
  pending your final go-ahead, not because the feature itself is in doubt.
- `fix/reply-target-and-queue`: stacked on `feat/jarvis-chat`, uncommitted.
  Contains the reply-target fix, the restart-safe queue fix, and the
  harness port-collision fix. 218/218 harness checks passing. Live server
  is running this code already (deliberately restarted with nothing
  pending/queued/mid-turn).

## Still needed before committing `fix/reply-target-and-queue`

### Test A — turn still running at restart
1. Terminal: give a project's Claude a slow, no-approval task.
2. From Jarvis, send that project a message while it's running — should
   show "Waiting to send."
3. Tell Claude Code "restart now" (it checks nothing is pending first).
4. Expected: after reconnect, message still shows waiting, you see a
   "Jarvis restarted with N message(s) waiting for …" note, and it
   delivers automatically once the terminal turn finishes.

### Test B — turn ends while server is down
1. Same setup — queue a message against a running turn.
2. Tell Claude Code "stop the server," let the terminal turn finish
   naturally, then "start it."
3. Expected: nothing auto-sends. The reconnect note mentions `send now`.
   Typing `send now <project>` delivers the queued message manually.

**Not yet run — need to actually do these with real terminal sessions and
report results before committing.**

### Notification check
- Tap **Notify** in the app header.
- Confirm whether "Jarvis — test notification" actually reaches your
  phone. Has been flagged as open across several messages without a
  confirmed result either way.

## Decisions already made, just waiting on confirmation of the above
- Reply target now changes only on: tapping a message, opening a project
  (points target at that project), or ✕. Never moves on an incoming
  message. (Confirmed working in browser; ARCHITECTURE.md updated.)
- Queued messages survive a restart safely: they stay queued and marked
  "mid-turn" rather than firing blind; delivery waits for a real Stop
  event (or manual `send now` if that Stop was lost while the server was
  down). This replaces an earlier "send immediately on reconnect" design
  that was a real concurrency hole (could start a second Claude process
  into an already-running session) — caught and fixed before commit.
- Auto-restart is off. Server now runs plain `tsx src/index.ts`, no watch
  process. Restarts are manual and deliberate, and Claude Code will refuse
  to restart while an approval is pending on your phone.

## Once Tests A, B, and the notification check are confirmed good
1. Commit `fix/reply-target-and-queue`.
2. Decide finally on `feat/jarvis-chat` — push it (if you still want the
   chat-partner feature) or move its underlying fixes onto `main` without
   it if you've changed your mind.
3. Open PR(s), merge in the usual order (base fixes before/with chat
   feature, matching how this branch is stacked).

## Longer-term / not urgent
- No second AI agent adapter yet — correctly deferred until a real
  candidate agent exists (per the agent-adapter refactor's standard: an
  agent only gets full control if it can hold a tool call indefinitely
  with no default action).
- Phase 1 (serverless port: Cloudflare Worker + Durable Object + GitHub
  Actions) remains intentionally untouched until Phase 0 has been proven
  stable under real daily use for a real stretch of time — that stretch
  hasn't really happened yet, since this session has mostly been continued
  hardening, not days of ordinary use.