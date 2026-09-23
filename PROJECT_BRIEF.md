# Project: Jarvis — Serverless Agent Orchestrator (Phase 1: Text)

## 0. Phase 0 — Local prototype (in progress, validate before porting)

Before building the serverless architecture in §2–§10, a local prototype is being built first to de-risk the notification/approval UX against a real `claude` terminal session. This phase is deliberate, not a drift from the plan — it answers "does this loop actually feel good to use" before the harder serverless plumbing goes in.

**Current shape**: a single always-running Node process on the home machine, using Claude Code's `PermissionRequest` / `Stop` / `SessionStart` hooks to observe sessions started manually in a terminal (`.claude/settings.local.json` per project, pointed at the local server). Permission requests block with no timeout until answered. The same passcode-gated PWA (WebSocket + Web Push fallback) from §3.3 is the front end, and replies are routed to the right project via `claude --resume <id> --print "<text>"`.

**What Phase 0 should prove out before moving to Phase 1 (serverless):**

- The approval/decision-point UX is fast and unambiguous on a phone (push → open app → see exactly what's being asked → reply).
- Multi-project routing (picking the right session from a reply) works reliably.
- The "hold indefinitely, no default action" behavior is trustworthy in practice — no accidental timeouts, no lost requests.

**What carries forward as-is to Phase 1:**

- The PWA (passcode gate, chat UI, WebSocket, Web Push/VAPID) — this is architecture-agnostic and shouldn't need rework.
- The push/notify layer's event shapes (permission request, turn complete, error) — reuse the same message schema so the PWA doesn't need to change when the backend does.

**What changes when porting to Phase 1 (serverless):**

- The single Node process becomes Jarvis (Cloudflare Worker + Durable Object) — no longer always-running compute, event-driven instead.
- `claude --resume --print` against a live local process is replaced by triggering a GitHub Actions run that resumes from a saved checkpoint, per §2–§3.2.
- The branch policy (§9: `main` protected, auto-PR, CI gate) has no equivalent in Phase 0 — it only applies once GitHub Actions is doing the actual code changes. Don't try to backport it into the local prototype; it's not relevant until Phase 1.
- Session/project identity model may need to shift from "cwd-derived tag" to "task-id" once tasks are triggered remotely rather than tied to a terminal's working directory.

---

Build a zero-cost, fully serverless orchestrator ("Jarvis") that lets me invoke coding work from my phone and have it executed on-demand, with Jarvis acting as the brain that:

- Receives my instructions (from a phone-installed PWA).
- Triggers an on-demand "worker" run that checks out the relevant repo and executes the task using Claude Code / the Agent SDK.
- Tracks task state and checkpoints progress, since the worker itself is short-lived and cannot sit idle waiting on me.
- Notifies me (push notification + chat) when the worker hits a decision point (needs my approval) or finishes.
- On my reply, resumes the task from its last checkpoint via a fresh worker run.
- Never auto-approves or auto-denies anything — always holds for my explicit input, but _holding_ means "state saved, nothing running," not "a process left open."

**Phase 1 scope is TEXT ONLY.** Voice is Phase 2 — don't build it now, but keep the design open to it (see §7).

## 2. Architecture

```
Phone (PWA)
   │  instruction / reply
   ▼
Jarvis — Cloudflare Worker + Durable Object   ← the brain, always reachable, free tier
   │  session state, decision-point tracking, push notifications
   │  triggers on new instruction / on my reply
   ▼
GitHub Actions workflow                        ← the worker, on-demand, free tier
   │  checks out repo, resumes/starts Claude Agent SDK session,
   │  runs until it hits a decision point or finishes, saves checkpoint,
   │  calls back to Jarvis with result, then the run ENDS (no idle billing)
   ▼
Jarvis receives callback → updates state → notifies phone → repeat
```

### Why this shape, specifically

- **Jarvis must be always-reachable but does almost no compute** — Cloudflare Workers + Durable Objects fits exactly this: a Durable Object per active task holds state cheaply and responds to events, comfortably inside the free tier.
- **The worker must NOT idle-wait for my approval** — serverless compute (GitHub Actions minutes) costs money/quota the longer a job runs, and jobs have hard time limits anyway. So instead of one long-lived process pausing mid-task, each run does one bounded unit of work, checkpoints its state, and exits completely the moment it needs me. A brand-new run picks the checkpoint back up once I reply. This means "holding indefinitely" is implemented as _zero running compute while waiting_, not a stalled process — which is also why this is actually cheaper than the earlier local-machine design, not just simpler.
- **GitHub Actions is the worker** because it already sits on the repo (no separate checkout/auth plumbing), is free for this volume of usage, can be triggered by Jarvis via a simple API call (`workflow_dispatch` or `repository_dispatch` with the instruction as input), and its final step can call Jarvis back directly — no extra infra needed for status reporting.

## 3. Components

### 3.1 Jarvis (Cloudflare Worker + Durable Object)

- One Durable Object instance per active task/session — holds: task id, repo, current checkpoint reference, status (`running` / `waiting_decision` / `waiting_instruction` / `done` / `error`), conversation/event log.
- HTTP endpoints:
  - Receives instructions from the PWA → triggers a GitHub Actions run via the GitHub API.
  - Receives callbacks from GitHub Actions (decision point reached / task finished / error) → updates state → pushes a notification + chat message to the PWA.
  - Receives my replies from the PWA → resolves target session → triggers a new GitHub Actions run with the checkpoint + my reply as input.
- Auth: shared secret between Jarvis and GitHub Actions (stored as a GitHub Actions secret and a Worker secret) so callbacks can't be spoofed. Separate login/passcode gate for the PWA itself.

### 3.2 Worker (GitHub Actions workflow)

- Triggered via `workflow_dispatch`/`repository_dispatch`, receiving: repo, task instruction (or checkpoint + reply, on resume).
- Steps: checkout → restore checkpoint if resuming → run Claude Agent SDK against the repo → on hitting a permission/decision point or finishing, write an updated checkpoint (as a workflow artifact or a small state blob passed back to Jarvis) → POST result to Jarvis's callback endpoint → job ends.
- Secrets needed in GitHub Actions: `ANTHROPIC_API_KEY`, repo access token (for checkout/commit/push — a scoped fine-grained PAT or the default `GITHUB_TOKEN` if permissions suffice), and the shared callback secret for Jarvis.

### 3.3 PWA (phone front end) — unchanged from before

- Installable chat-style app, WebSocket to Jarvis for live updates, Web Push (VAPID) for notifications when closed, session list view for multiple concurrent tasks.

## 4. Functional requirements

### 4.1 Outbound (Jarvis → me)

- Decision point reached (e.g. tool wants to run something, or a merge/push is pending) → push + chat message describing exactly what's being asked and how to reply, tagged with task/repo, e.g. `[invoice-app] Wants to run \`npm install\` and push to main. Reply YES/NO/instructions.`
- Task finished → summary of what changed (diff summary / commit link).
- Error → what failed, current checkpoint, safe to resume or not.

### 4.2 Inbound (me → Jarvis)

- Free text from the PWA is resolved to a specific session (session list makes this unambiguous rather than relying on tags).
- Jarvis translates my reply into either a decision (allow/deny/modify) or a new instruction, attaches it to the saved checkpoint, and fires a new GitHub Actions run.

### 4.3 Checkpointing

- Must be resumable by a completely fresh process with no memory of the previous run — the Agent SDK's session resume (by session id) plus a small explicit state blob (what's been done, what's pending, repo/branch) covers this. Store the state blob in the Durable Object, not just relying on the SDK transcript, so Jarvis can show me a readable status without re-running anything.

## 5. Out of scope for Phase 1

- Voice (Phase 2).
- Multi-user support (single operator).
- Agents other than Claude Code (generalize later).
- Tasks that genuinely need a long, uninterrupted-by-design compute run beyond GitHub Actions' hosted job limits (6 hrs) — flag this if it comes up; the fallback is Cloud Run Jobs, still serverless, no hard timeout.

## 6. Build order (please follow this sequence and check in after each milestone)

1. **Cloudflare setup**: create a Worker + Durable Object project (free tier), get a basic HTTP endpoint live and reachable.
2. **GitHub Actions skeleton**: a workflow in the target repo that can be manually triggered (`workflow_dispatch`), checks out the repo, and does nothing else yet — confirm trigger + checkout works before adding agent logic.
3. **Wire the trigger**: Jarvis can call the GitHub API to start that workflow with parameters (repo, instruction). Confirm a real run kicks off from a Jarvis-side test call.
4. **Wire the callback**: workflow's last step POSTs a hardcoded "done" payload to Jarvis's callback endpoint, authenticated with the shared secret. Confirm Jarvis receives and stores it.
5. **PWA shell**: installable chat UI + WebSocket to Jarvis + Web Push subscribe flow + login gate. Send a test push end-to-end.
6. **Claude Agent SDK in the workflow**: run a trivial real task in the GitHub Actions job, capture a `PermissionRequest`-equivalent decision point, checkpoint state, and report it back to Jarvis instead of resolving it automatically.
7. **Full decision-point loop**: Jarvis notifies me via push/chat on a real decision point → I reply from the PWA → Jarvis triggers a resume run with my reply → task continues.
8. **Session list + multi-task routing** in the PWA.
9. **End-to-end test**: give Jarvis a real small coding task from my phone, approve a decision point from the PWA (phone only, no laptop involved at all), confirm the change lands in the repo and I get a completion notice.

## 7. Forward-compatibility note (Phase 2, don't build now)

Keep the PWA/push channel as one adapter behind a common interface (`sendUpdate`, `onIncoming`) in Jarvis, so a future voice channel can register as a second adapter without touching the orchestration core in §3.1–3.2.

## 8. Decisions (resolved)

- **No home machine, no always-on personal server** — Jarvis itself is serverless (Cloudflare Workers + Durable Objects); the actual agent execution is on-demand serverless too (GitHub Actions).
- **"Hold indefinitely" is implemented as zero running compute while waiting** — checkpoint + exit, not a paused process.
- **GitHub Actions secrets** will hold the Anthropic API key and repo access token — confirmed acceptable.
- **No Twilio, no Railway, no paid hosting anywhere in the stack.**

## 9. Branch policy (resolved)

- **Fully automated, no manual PR-approval gate** — the worker commits, pushes, and (where a task calls for it) merges without waiting on me for routine changes. "Decision points" in §4.1 are for things genuinely ambiguous or risky (e.g. an unexpected destructive command, an unclear instruction), not for rubber-stamping every commit.
- **`main` is never touched directly by the worker.** Every task runs on its own branch, e.g. `jarvis/<task-id>-<short-desc>`, created fresh off `main` at task start.
- Two layers of enforcement, not just one:
  - **Token scope**: the worker's GitHub token/PAT should be scoped so it _cannot_ push to `main` at all — fine-grained PAT with push access limited to non-`main` refs, or a branch-restricted deploy key. Do not rely on "the workflow just won't try to" as the only safeguard.
  - **Repo-side branch protection rule** on `main` (require PRs, no direct pushes) as a second, independent backstop — set this in GitHub repo settings regardless of what the token can do, so a bug in the workflow can't accidentally push to `main`.
- The worker auto-opens a PR from its task branch into `main` once a task completes, for visibility/audit trail, but does **not** auto-merge that PR — merging into `main` stays a separate, manual action I take in GitHub itself, outside the Jarvis loop. This keeps "automated" (no per-commit approval needed to get work done) and "main protected" (nothing lands in production history without me looking at it) both true at once.

## 10. Decisions (resolved, cont.)

- **Auto-opened PRs into `main` must trigger the existing CI/test suite** before I review them — the PR should be validated (or show failing checks) by the time I look at it, not just a raw diff. If the repo doesn't already have a CI workflow, flag this back to me rather than skipping it silently, since "automated" changes landing untested is exactly the risk the branch policy is meant to guard against.
