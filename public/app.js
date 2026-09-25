const TOKEN_KEY = "jarvis_token";

const loginScreen = document.getElementById("login-screen");
const chatScreen = document.getElementById("chat-screen");
const passcodeInput = document.getElementById("passcode-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const connStatus = document.getElementById("conn-status");
const messagesEl = document.getElementById("messages");
const msgInput = document.getElementById("msg-input");
const sendBtn = document.getElementById("send-btn");
const enablePushBtn = document.getElementById("enable-push-btn");
const queuePanel = document.getElementById("queue-panel");
const homeView = document.getElementById("home-view");
const projectView = document.getElementById("project-view");
const projectList = document.getElementById("project-list");
const homeFeed = document.getElementById("home-feed");
const waitingStrip = document.getElementById("waiting-strip");
const historyPanel = document.getElementById("history-panel");
const historyFilters = document.getElementById("history-filters");
const blockList = document.getElementById("block-list");
const viewingBar = document.getElementById("viewing-bar");
const backBtn = document.getElementById("back-btn");
const historyBtn = document.getElementById("history-btn");
const viewTitle = document.getElementById("view-title");
const viewSub = document.getElementById("view-sub");
const micBtn = document.getElementById("mic-btn");
const micNote = document.getElementById("mic-note");
const searchBtn = document.getElementById("search-btn");
const searchPanel = document.getElementById("search-panel");
const searchInput = document.getElementById("search-input");
const searchScope = document.getElementById("search-scope");
const searchResults = document.getElementById("search-results");
const replyTargetEl = document.getElementById("reply-target");
const replyTargetLabel = document.getElementById("reply-target-label");
const replyTargetClear = document.getElementById("reply-target-clear");

let ws = null;
let reconnectDelay = 1000;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function showChat() {
  loginScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
}

function showLogin(message) {
  chatScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginError.textContent = message || "";
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

// toolUseID -> { status, projectTag, toolName, createdAt } from the server's
// authoritative "permissions" snapshot. Cards read their state from here.
const permissions = new Map();
const permissionCards = new Map();

const STATUS_LABELS = {
  answered: "Answered",
  allowed: "Approved",
  denied: "Denied",
  cancelled: "Cancelled — no longer waiting",
  stale: "Stale — JARVIS restarted; answer in the terminal if still asked",
};

function newClientId() {
  // crypto.randomUUID needs a secure context, which a LAN http:// URL isn't.
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendInbound(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ ...msg, clientId: newClientId() }));
  return true;
}

function pendingIds() {
  return [...permissions.entries()].filter(([, p]) => p.status === "pending").map(([id]) => id);
}

function renderCardState(toolUseID) {
  const card = permissionCards.get(toolUseID);
  if (!card) return;
  const status = permissions.get(toolUseID)?.status;
  const isPending = status === "pending";
  card.actions.classList.toggle("hidden", !isPending);
  card.status.textContent = isPending ? "" : STATUS_LABELS[status] || "No longer waiting";
  card.status.classList.toggle("hidden", isPending);
  card.el.classList.toggle("resolved", !isPending);
}

// New cards shift the list (auto-scroll), so a thumb already on its way to
// an older card's button can land on the new one. Buttons on a freshly
// rendered card stay inert briefly so every tap is on something already seen.
const CARD_ARM_MS = 1200;

function buildPermissionCard(div, toolUseID) {
  const actions = document.createElement("div");
  actions.className = "perm-actions";
  for (const [decision, label] of [["allow", "Approve"], ["deny", "Deny"]]) {
    const btn = document.createElement("button");
    btn.className = `perm-btn ${decision}`;
    btn.textContent = label;
    btn.disabled = true;
    btn.addEventListener("click", () => {
      // The decision names this card's request explicitly, so it can only
      // ever apply to what's on screen — never to a newer request.
      if (sendInbound({ type: "decision", toolUseID, decision })) {
        actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      }
    });
    actions.appendChild(btn);
  }
  const status = document.createElement("div");
  status.className = "perm-status hidden";
  div.appendChild(actions);
  div.appendChild(status);
  permissionCards.set(toolUseID, { el: div, actions, status });
  renderCardState(toolUseID);
  setTimeout(() => {
    if (permissionCards.get(toolUseID)?.actions !== actions) return;
    if (permissions.get(toolUseID)?.status !== "pending") return;
    actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }, CARD_ARM_MS);
}

// A question from Claude (its AskUserQuestion tool) needs an answer, not an
// approval: approving it unanswered only moves it to the terminal. So its
// card shows the real question and options, and sends the chosen answer.
function buildQuestionCard(div, toolUseID, questions) {
  const actions = document.createElement("div");
  actions.className = "question-card";
  const chosen = questions.map(() => new Set());
  const sendBtn = document.createElement("button");
  let armed = false;
  const refresh = () => {
    sendBtn.disabled = !armed || chosen.some((c) => c.size === 0);
  };

  questions.forEach((q, qi) => {
    const block = document.createElement("div");
    block.className = "question-block";
    if (q.header) {
      const chip = document.createElement("span");
      chip.className = "question-header";
      chip.textContent = q.header;
      block.appendChild(chip);
    }
    const text = document.createElement("div");
    text.className = "question-text";
    text.textContent = q.question + (q.multiSelect ? " (pick any)" : "");
    block.appendChild(text);
    const optionButtons = [];
    q.options.forEach((o) => {
      const btn = document.createElement("button");
      btn.className = "question-option";
      btn.disabled = true;
      const label = document.createElement("span");
      label.className = "question-option-label";
      label.textContent = o.label;
      btn.appendChild(label);
      if (o.description) {
        const desc = document.createElement("span");
        desc.className = "question-option-desc";
        desc.textContent = o.description;
        btn.appendChild(desc);
      }
      btn.addEventListener("click", () => {
        if (q.multiSelect) {
          chosen[qi].has(o.label) ? chosen[qi].delete(o.label) : chosen[qi].add(o.label);
        } else {
          chosen[qi] = new Set([o.label]);
        }
        optionButtons.forEach((b, i) => b.classList.toggle("chosen", chosen[qi].has(q.options[i].label)));
        refresh();
      });
      optionButtons.push(btn);
      block.appendChild(btn);
    });
    actions.appendChild(block);
  });

  sendBtn.className = "question-send";
  sendBtn.textContent = "Send answer";
  sendBtn.disabled = true;
  sendBtn.addEventListener("click", () => {
    const answers = {};
    questions.forEach((q, qi) => {
      const picked = [...chosen[qi]];
      answers[q.question] = q.multiSelect ? picked : picked[0];
    });
    if (sendInbound({ type: "answer", toolUseID, answers })) {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    }
  });
  actions.appendChild(sendBtn);

  if (questions.length === 1) {
    const hint = document.createElement("div");
    hint.className = "question-hint";
    hint.textContent = "Or type your own answer below.";
    actions.appendChild(hint);
  }
  const alt = document.createElement("div");
  alt.className = "question-alt";
  for (const [label, msg] of [
    ["Answer in terminal instead", { type: "decision", toolUseID, decision: "allow", answerInTerminal: true }],
    ["Dismiss", { type: "decision", toolUseID, decision: "deny" }],
  ]) {
    const btn = document.createElement("button");
    btn.className = "question-alt-btn";
    btn.textContent = label;
    btn.disabled = true;
    btn.addEventListener("click", () => {
      if (sendInbound(msg)) actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    });
    alt.appendChild(btn);
  }
  actions.appendChild(alt);

  const status = document.createElement("div");
  status.className = "perm-status hidden";
  div.appendChild(actions);
  div.appendChild(status);
  permissionCards.set(toolUseID, { el: div, actions, status });
  renderCardState(toolUseID);
  setTimeout(() => {
    if (permissionCards.get(toolUseID)?.actions !== actions) return;
    if (permissions.get(toolUseID)?.status !== "pending") return;
    armed = true;
    actions.querySelectorAll(".question-option, .question-alt-btn").forEach((b) => (b.disabled = false));
    refresh();
  }, CARD_ARM_MS);
}

// Which session an unaddressed message goes to, shown above the composer so
// it's never a guess: it follows the newest project message on screen, a tap
// on any message moves it there, and ✕ clears it. `changedAt` is sent along
// (as an age) so the server can refuse a send made just after it switched.
let replyTarget = null;

// While a "which project?" list from Jarvis is open, the composer answers it
// instead: the next message carries the list's id so the server completes
// that open rather than treating the reply as free text. ✕ leaves this mode.
let openChoice = null;
let choiceButtonGroups = [];

function setOpenChoice(choiceId, count) {
  openChoice = { choiceId, count };
  renderReplyTarget();
}

function endOpenChoice() {
  openChoice = null;
  choiceButtonGroups.forEach((g) => g.querySelectorAll("button").forEach((b) => (b.disabled = true)));
  choiceButtonGroups = [];
  renderReplyTarget();
}

function buildChoiceButtons(div, choiceId, choices) {
  choiceButtonGroups.forEach((g) => g.querySelectorAll("button").forEach((b) => (b.disabled = true)));
  const group = document.createElement("div");
  group.className = "choice-actions";
  choices.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = `${i + 1}. ${c.tag}`;
    btn.addEventListener("click", () => {
      if (sendInbound({ type: "chat", content: String(i + 1), openChoice: choiceId })) endOpenChoice();
    });
    group.appendChild(btn);
  });
  div.appendChild(group);
  choiceButtonGroups = [group];
  setOpenChoice(choiceId, choices.length);
}

function setReplyTarget(sessionId, projectTag) {
  if (replyTarget && replyTarget.sessionId === sessionId) return;
  replyTarget = { sessionId, projectTag, changedAt: Date.now() };
  renderReplyTarget();
}

function renderReplyTarget() {
  replyTargetEl.classList.toggle("hidden", !replyTarget && !openChoice);
  replyTargetEl.classList.toggle("choosing", !!openChoice);
  replyTargetLabel.textContent = openChoice
    ? `Choosing which project to open — reply 1–${openChoice.count}`
    : replyTarget
      ? `Replying to ${replyTarget.projectTag}`
      : "";
}

replyTargetClear.addEventListener("click", () => {
  if (openChoice) {
    endOpenChoice();
    return;
  }
  replyTarget = null;
  renderReplyTarget();
});

// What a permission request wants to do, at a glance: the gist (Claude's own
// description of the command), Jarvis's tags from reading the actual
// command, and the exact command — one line, tap to see it all.
const RISKY_TAGS = new Set(["deletes files", "pushes to a remote", "changes git history", "installs packages", "goes online"]);
function renderSummary(div, summary) {
  const title = document.createElement("div");
  title.className = "perm-title";
  title.textContent = summary.title;
  div.appendChild(title);
  if (summary.tags?.length) {
    const tags = document.createElement("div");
    tags.className = "perm-tags";
    for (const t of summary.tags) {
      const chip = document.createElement("span");
      chip.className = `perm-tag${RISKY_TAGS.has(t) ? " risky" : ""}`;
      chip.textContent = t;
      tags.appendChild(chip);
    }
    div.appendChild(tags);
  }
  if (summary.detail) {
    const detail = document.createElement("div");
    detail.className = "perm-detail";
    detail.textContent = summary.detail;
    detail.title = "Tap to show the full command";
    detail.addEventListener("click", (e) => {
      e.stopPropagation();
      detail.classList.toggle("expanded");
    });
    div.appendChild(detail);
  }
}

function appendMessage({ id, direction, type, content, tag, projectTag, toolUseID, sessionId, choiceId, choices, createdAt, editedAt }, container = messagesEl) {
  const div = document.createElement("div");
  if (id) div.dataset.id = String(id);
  const cls = type === "system" ? "system" : direction === "in" ? "in" : "out";
  div.className = `msg ${cls}`;
  // Every message is always between exactly two parties, You and Jarvis —
  // never a project name or device on its own. The project a message
  // concerns (if any) is shown after the arrow as context, not as the sender.
  const who = type === "prompt" ? "You, in the terminal" : "You";
  const label =
    cls === "in" ? (projectTag ? `${who} → ${projectTag}` : who) : cls === "out" ? (projectTag ? `Jarvis → ${projectTag}` : "Jarvis") : null;
  if (label && cls !== "system") {
    const tagEl = document.createElement("span");
    tagEl.className = "msg-tag";
    tagEl.textContent = `${label} · ${clock(createdAt ?? Date.now())}`;
    div.appendChild(tagEl);
  }
  const questions = type === "permission_request" && toolUseID ? permissions.get(toolUseID)?.questions : undefined;
  const summary = type === "permission_request" && toolUseID ? permissions.get(toolUseID)?.summary : undefined;
  // Cards show their request structured — the question, or the plain-English
  // gist — instead of the raw text.
  if (summary) renderSummary(div, summary);
  else if (!questions) {
    const text = document.createElement("span");
    text.className = "msg-text";
    text.textContent = content;
    div.appendChild(text);
  }
  if (editedAt) div.classList.add("edited");
  if (cls === "in" && type === "chat") {
    div.classList.add("mine");
    if (!id) div.classList.add("not-stored");
  }
  if (type === "permission_request" && toolUseID) {
    div.classList.add("perm");
    if (questions) buildQuestionCard(div, toolUseID, questions);
    else buildPermissionCard(div, toolUseID);
  }
  if (choiceId && Array.isArray(choices)) buildChoiceButtons(div, choiceId, choices);
  if (sessionId && projectTag) {
    div.classList.add("targetable");
    div.addEventListener("click", (e) => {
      if (e.target.closest(".perm-actions")) return; // an Approve/Deny tap isn't a retarget
      setReplyTarget(sessionId, projectTag);
    });
    setReplyTarget(sessionId, projectTag);
  }
  container.appendChild(div);
  if (div.classList.contains("mine")) renderMessageState(div);
  container.scrollTop = container.scrollHeight;
}

// ---- Your messages: their state, and editing ones not sent yet ----
// Only a queued message — waiting for a busy session — hasn't been acted on,
// so only it can be edited or removed. One already sent is in a Claude turn
// and stays as it was; one that was refused was never stored.
const queuedByMessage = new Map(); // history message id -> queue item

function renderMessageState(div) {
  div.querySelector(".msg-state")?.remove();
  const state = document.createElement("div");
  state.className = "msg-state";
  const item = div.dataset.id ? queuedByMessage.get(Number(div.dataset.id)) : undefined;
  if (div.classList.contains("not-stored")) {
    state.textContent = "Not sent to Claude";
  } else if (item) {
    state.append("Waiting to send · ");
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startEdit(div, item);
    });
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (sendInbound({ type: "unqueue", queueItemId: item.id })) removeBtn.disabled = true;
    });
    state.append(editBtn, " · ", removeBtn);
  } else {
    state.textContent = "Sent to Claude";
  }
  div.appendChild(state);
}

function renderAllMessageStates() {
  for (const div of messagesEl.querySelectorAll(".msg.mine")) {
    if (!div.querySelector(".msg-editor")) renderMessageState(div);
  }
}

function startEdit(div, item) {
  const textEl = div.querySelector(".msg-text");
  div.querySelector(".msg-state")?.remove();
  const editor = document.createElement("div");
  editor.className = "msg-editor";
  const area = document.createElement("textarea");
  area.value = item.text;
  area.rows = Math.min(6, Math.max(2, Math.ceil(item.text.length / 36)));
  const save = document.createElement("button");
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  const done = () => {
    editor.remove();
    textEl.classList.remove("hidden");
    renderMessageState(div);
  };
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    done();
  });
  save.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = area.value.trim();
    if (!text || !sendInbound({ type: "edit_queued", queueItemId: item.id, text })) return;
    done();
  });
  area.addEventListener("click", (e) => e.stopPropagation());
  editor.append(area, save, cancel);
  textEl.classList.add("hidden");
  div.appendChild(editor);
  area.focus();
}

// Messages waiting for a busy session, straight from the server's queue —
// exactly what will be sent when the session is free. ✕ takes one back.
function renderQueue(sessions) {
  queuedByMessage.clear();
  for (const s of sessions) for (const item of s.items) if (item.messageId) queuedByMessage.set(item.messageId, item);
  renderAllMessageStates();
  queuePanel.replaceChildren();
  queuePanel.classList.toggle("hidden", !sessions.length);
  for (const s of sessions) {
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = `Waiting to send to ${s.projectTag} — goes in when its turn ends`;
    queuePanel.appendChild(title);
    for (const item of s.items) {
      const row = document.createElement("div");
      row.className = "queue-item";
      const text = document.createElement("span");
      text.className = "queue-text";
      text.textContent = item.text;
      const remove = document.createElement("button");
      remove.className = "queue-remove";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", "Remove from queue");
      remove.addEventListener("click", () => {
        if (sendInbound({ type: "unqueue", queueItemId: item.id })) remove.disabled = true;
      });
      const edit = document.createElement("button");
      edit.className = "queue-edit";
      edit.textContent = "✎";
      edit.setAttribute("aria-label", "Edit before it sends");
      edit.addEventListener("click", () => {
        const bubble = item.messageId && messagesEl.querySelector(`[data-id="${item.messageId}"]`);
        if (bubble) {
          startEdit(bubble, item);
          bubble.scrollIntoView({ block: "center" });
          return;
        }
        const next = window.prompt("Edit before it sends:", item.text);
        if (next && next.trim()) sendInbound({ type: "edit_queued", queueItemId: item.id, text: next.trim() });
      });
      row.append(text, edit, remove);
      queuePanel.appendChild(row);
    }
  }
}

// ---- Per-project history ----
// A project is its full path (projectKey), never its display name. Home is
// the list of projects; opening one shows its latest block of work, live;
// History browses earlier blocks by date. Anything waiting on you, from
// any project, stays in the strip at the top of every screen.
let projects = new Map();
let currentProject = null; // projectKey, or null on the home screen
let viewingLive = true; // viewing the latest block (new messages append)
const unread = new Map(); // projectKey -> count of messages that arrived elsewhere
const home = "~";

async function api(pathAndQuery) {
  const res = await fetch(pathAndQuery, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function ago(ms) {
  if (!ms) return "not used yet";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return dayLabel(ms);
}

function prettyPath(key) {
  const m = /^\/Users\/[^/]+(\/.*)$/.exec(key);
  return m ? `${home}${m[1]}` : key;
}

function pendingByProject() {
  const counts = new Map();
  for (const p of permissions.values()) {
    if (p.status === "pending" && p.projectKey) counts.set(p.projectKey, (counts.get(p.projectKey) ?? 0) + 1);
  }
  return counts;
}

async function loadProjects() {
  const { projects: list } = await api("/api/projects");
  projects = new Map(list.map((p) => [p.key, p]));
  if (!currentProject) renderHome();
  renderWaiting();
}

function projectRow(p, pending) {
  const row = document.createElement("button");
  row.className = "project-row";
  const main = document.createElement("div");
  main.className = "project-main";
  const name = document.createElement("div");
  name.className = "project-name";
  name.textContent = p.tag;
  const where = document.createElement("div");
  where.className = "project-path";
  where.textContent = prettyPath(p.key);
  main.append(name, where);
  const side = document.createElement("div");
  side.className = "project-side";
  const when = document.createElement("div");
  when.className = "project-when";
  when.textContent = ago(p.lastActivity);
  side.appendChild(when);
  const badges = document.createElement("div");
  if (pending) badges.append(badge(`${pending} waiting`, "waiting"));
  if (unread.get(p.key)) badges.append(badge(`${unread.get(p.key)} new`, "new"));
  side.appendChild(badges);
  row.append(main, side);
  row.addEventListener("click", () => openProject(p.key));
  return row;
}

function badge(text, kind) {
  const b = document.createElement("span");
  b.className = `badge ${kind}`;
  b.textContent = text;
  return b;
}

function renderHome() {
  projectList.replaceChildren();
  const pending = pendingByProject();
  const list = [...projects.values()];
  const used = list.filter((p) => p.messageCount > 0 || pending.get(p.key));
  const unusedList = list.filter((p) => !used.includes(p));
  const heading = document.createElement("div");
  heading.className = "list-heading";
  heading.textContent = used.length ? "Projects" : "No conversations yet — say \"open <project> <instruction>\" to start one.";
  projectList.appendChild(heading);
  for (const p of used) projectList.appendChild(projectRow(p, pending.get(p.key)));
  if (unusedList.length) {
    const more = document.createElement("details");
    more.className = "unused-projects";
    const summary = document.createElement("summary");
    summary.textContent = `Registered, not used yet (${unusedList.length})`;
    more.appendChild(summary);
    for (const p of unusedList) more.appendChild(projectRow(p, 0));
    projectList.appendChild(more);
  }
}

function renderWaiting() {
  waitingStrip.replaceChildren();
  const elsewhere = [...pendingByProject()].filter(([key]) => key !== currentProject || !viewingLive);
  waitingStrip.classList.toggle("hidden", !elsewhere.length);
  for (const [key, n] of elsewhere) {
    const btn = document.createElement("button");
    btn.className = "waiting-item";
    const tag = projects.get(key)?.tag ?? prettyPath(key);
    btn.textContent = `${tag} is waiting on you${n > 1 ? ` (${n})` : ""} ›`;
    btn.addEventListener("click", () => openProject(key));
    waitingStrip.appendChild(btn);
  }
  if (!currentProject) renderHome();
}

function showHome() {
  currentProject = null;
  viewingLive = true;
  replyTarget = null;
  renderReplyTarget();
  homeView.classList.remove("hidden");
  projectView.classList.add("hidden");
  backBtn.classList.add("hidden");
  historyBtn.classList.add("hidden");
  historyPanel.classList.add("hidden");
  viewTitle.textContent = "JARVIS";
  viewSub.classList.add("hidden");
  history.replaceState(null, "", "/");
  loadProjects().catch(() => {});
}

// Opens a project: its latest block of work, live — or, given a block from
// History or a search result, that block, optionally scrolled to one message.
async function openProject(key, block, focusMessageId) {
  currentProject = key;
  const p = projects.get(key);
  homeView.classList.add("hidden");
  projectView.classList.remove("hidden");
  backBtn.classList.remove("hidden");
  historyBtn.classList.remove("hidden");
  historyPanel.classList.add("hidden");
  viewTitle.textContent = p?.tag ?? "Project";
  viewSub.textContent = prettyPath(key);
  viewSub.classList.remove("hidden");
  history.replaceState(null, "", `/?project=${encodeURIComponent(key)}`);
  unread.delete(key);

  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const { blocks } = await api(`/api/projects/blocks?key=${encodeURIComponent(key)}`);
  const latest = blocks[0];
  viewingLive = !block || (latest && block.start === latest.start);
  if (viewingLive && latest) from = latest.start;
  if (!viewingLive) ({ start: from, end: to } = block);
  const { messages } = await api(`/api/projects/messages?key=${encodeURIComponent(key)}&from=${from}&to=${to}`);
  if (currentProject !== key) return; // switched away while loading
  messagesEl.replaceChildren();
  permissionCards.clear();
  replyTarget = null;
  for (const m of messages) appendMessage({ ...m, tag: m.projectTag });
  if (!viewingLive) replyTarget = null; // an old block isn't where a reply goes
  renderReplyTarget();
  renderViewingBar(viewingLive ? latest : block, viewingLive);
  renderWaiting();
  if (focusMessageId) {
    const el = messagesEl.querySelector(`[data-id="${focusMessageId}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("found");
      setTimeout(() => el.classList.remove("found"), 2500);
    }
  }
}

// ---- Search across all history ----
// Words, not meaning. One result per conversation, best match first, with
// the match highlighted in context; tapping one opens that conversation at
// that message. Scope to the open project, or search everything.
let searchScopeKey = null; // null = all projects
let searchSeq = 0;
let searchTimer = null;

function openSearch() {
  searchPanel.classList.remove("hidden");
  historyPanel.classList.add("hidden");
  searchScopeKey = null;
  renderSearchScope();
  searchInput.focus();
  runSearch();
}

function closeSearch() {
  searchPanel.classList.add("hidden");
}

function renderSearchScope() {
  searchScope.replaceChildren();
  const options = [["All projects", null]];
  if (currentProject) options.push([`Only ${projects.get(currentProject)?.tag ?? "this project"}`, currentProject]);
  if (options.length < 2) return;
  for (const [label, key] of options) {
    const chip = document.createElement("button");
    chip.className = `filter-chip${key === searchScopeKey ? " active" : ""}`;
    chip.textContent = label;
    chip.addEventListener("click", () => {
      searchScopeKey = key;
      renderSearchScope();
      runSearch();
    });
    searchScope.appendChild(chip);
  }
}

function highlighted(snippet) {
  const span = document.createElement("span");
  const parts = snippet.split(/(\u0002[^\u0003]*\u0003)/);
  for (const part of parts) {
    if (part.startsWith("\u0002")) {
      const mark = document.createElement("mark");
      mark.textContent = part.slice(1, -1);
      span.appendChild(mark);
    } else if (part) {
      span.appendChild(document.createTextNode(part));
    }
  }
  return span;
}

function resultRow(r) {
  const row = document.createElement("button");
  row.className = "search-result";
  const head = document.createElement("div");
  head.className = "search-result-head";
  const tag = document.createElement("span");
  tag.className = "search-result-project";
  tag.textContent = r.projectTag;
  const when = document.createElement("span");
  when.className = "search-result-when";
  when.textContent = `${dayLabel(r.at)} ${clock(r.at)}`;
  head.append(tag, when);
  const where = document.createElement("div");
  where.className = "project-path";
  where.textContent = prettyPath(r.projectKey);
  const title = document.createElement("div");
  title.className = "search-result-title";
  title.textContent = r.block.title;
  const snip = document.createElement("div");
  snip.className = "search-result-snippet";
  snip.appendChild(highlighted(r.snippet));
  // The title only adds something when it isn't the matching message itself.
  const plain = (t) => t.replace(/[\u0002\u0003…]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const titleIsSnippet = plain(r.snippet).startsWith(plain(r.block.title).slice(0, 40));
  row.append(head, where, ...(titleIsSnippet ? [] : [title]), snip);
  if (r.otherMatches) {
    const more = document.createElement("div");
    more.className = "search-result-more";
    more.textContent = `+${r.otherMatches} more match${r.otherMatches > 1 ? "es" : ""} in this conversation`;
    row.appendChild(more);
  }
  row.addEventListener("click", () => {
    closeSearch();
    loadProjects()
      .catch(() => {})
      .then(() => openProject(r.projectKey, r.block, r.messageId));
  });
  return row;
}

async function runSearch() {
  const q = searchInput.value.trim();
  const seq = ++searchSeq;
  if (!q) {
    searchResults.replaceChildren();
    return;
  }
  const scope = searchScopeKey ? `&key=${encodeURIComponent(searchScopeKey)}` : "";
  const { results, partial } = await api(`/api/search?q=${encodeURIComponent(q)}${scope}`);
  if (seq !== searchSeq) return; // a newer search has started
  searchResults.replaceChildren();
  if (!results.length && !partial.length) {
    const none = document.createElement("div");
    none.className = "list-heading";
    none.textContent = "No conversations mention that.";
    searchResults.appendChild(none);
  }
  for (const r of results) searchResults.appendChild(resultRow(r));
  if (partial.length) {
    const h = document.createElement("div");
    h.className = "day-heading";
    h.textContent = results.length ? "Partial matches — some of your words" : "No conversation has all your words — partial matches";
    searchResults.appendChild(h);
    for (const r of partial) searchResults.appendChild(resultRow(r));
  }
}

searchBtn.addEventListener("click", () => {
  if (searchPanel.classList.contains("hidden")) openSearch();
  else closeSearch();
});
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch().catch(() => {}), 250);
});

function renderViewingBar(block, live) {
  viewingBar.replaceChildren();
  if (!block) {
    viewingBar.classList.add("hidden");
    return;
  }
  viewingBar.classList.remove("hidden");
  viewingBar.classList.toggle("old", !live);
  const text = document.createElement("span");
  text.textContent = live
    ? `Latest · since ${dayLabel(block.start)} ${clock(block.start)}`
    : `${dayLabel(block.start)} · ${clock(block.start)}–${clock(block.end)} · ${block.title}`;
  viewingBar.appendChild(text);
  if (!live) {
    const back = document.createElement("button");
    back.textContent = "Back to latest";
    back.addEventListener("click", () => openProject(currentProject));
    viewingBar.appendChild(back);
  }
}

// History: this project's blocks of work, newest first, grouped by day,
// filterable by date.
const FILTERS = [
  ["All", () => [0, Number.MAX_SAFE_INTEGER]],
  ["Today", () => [startOfDay(0), Number.MAX_SAFE_INTEGER]],
  ["Yesterday", () => [startOfDay(1), startOfDay(0) - 1]],
  ["Last 7 days", () => [startOfDay(6), Number.MAX_SAFE_INTEGER]],
];
let activeFilter = "All";

function startOfDay(daysAgo) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
}

async function showHistory(range = FILTERS[0][1](), label = "All") {
  activeFilter = label;
  historyPanel.classList.remove("hidden");
  historyFilters.replaceChildren();
  for (const [name, fn] of FILTERS) {
    const chip = document.createElement("button");
    chip.className = `filter-chip${name === activeFilter ? " active" : ""}`;
    chip.textContent = name;
    chip.addEventListener("click", () => showHistory(fn(), name));
    historyFilters.appendChild(chip);
  }
  const picker = document.createElement("input");
  picker.type = "date";
  picker.className = "filter-date";
  picker.addEventListener("change", () => {
    if (!picker.value) return;
    const [y, m, d] = picker.value.split("-").map(Number);
    const start = new Date(y, m - 1, d).getTime();
    showHistory([start, start + 86400000 - 1], picker.value);
  });
  historyFilters.appendChild(picker);

  const key = currentProject;
  const { blocks } = await api(`/api/projects/blocks?key=${encodeURIComponent(key)}&from=${range[0]}&to=${range[1]}`);
  if (currentProject !== key) return;
  blockList.replaceChildren();
  if (!blocks.length) {
    const none = document.createElement("div");
    none.className = "list-heading";
    none.textContent = "Nothing in this period.";
    blockList.appendChild(none);
  }
  let lastDay = "";
  for (const b of blocks) {
    const day = dayLabel(b.start);
    if (day !== lastDay) {
      const h = document.createElement("div");
      h.className = "day-heading";
      h.textContent = day;
      blockList.appendChild(h);
      lastDay = day;
    }
    const row = document.createElement("button");
    row.className = "block-row";
    const title = document.createElement("div");
    title.className = "block-title";
    title.textContent = b.title;
    const meta = document.createElement("div");
    meta.className = "block-meta";
    const until = dayLabel(b.end) !== day ? `${dayLabel(b.end)} ${clock(b.end)}` : clock(b.end);
    meta.textContent = `${clock(b.start)} – ${until} · ${b.count} message${b.count === 1 ? "" : "s"}`;
    row.append(title, meta);
    row.addEventListener("click", () => openProject(key, b));
    blockList.appendChild(row);
  }
}

backBtn.addEventListener("click", showHome);
historyBtn.addEventListener("click", () => {
  if (historyPanel.classList.contains("hidden")) showHistory();
  else historyPanel.classList.add("hidden");
});

const NAVIGATING_ACTIONS = new Set(["launching", "instructed", "queued", "already_open", "starting", "sent_now"]);

function handleServerMessage(msg) {
  if (msg.type === "queue") {
    renderQueue(msg.sessions);
    return;
  }
  if (msg.type === "message_updated") {
    const div = messagesEl.querySelector(`[data-id="${msg.id}"]`);
    const textEl = div?.querySelector(".msg-text");
    if (textEl) textEl.textContent = msg.content;
    div?.classList.add("edited");
    return;
  }
  if (msg.type === "message_removed") {
    messagesEl.querySelector(`[data-id="${msg.id}"]`)?.remove();
    return;
  }
  if (msg.type === "permissions") {
    permissions.clear();
    for (const item of msg.items) permissions.set(item.toolUseID, item);
    for (const id of permissionCards.keys()) renderCardState(id);
    renderWaiting();
    return;
  }
  if (msg.type === "ack") {
    // Refusals arrive with their own explanatory chat message; a refused
    // button tap just needs its buttons back if the request is still live.
    if (!msg.ok && msg.toolUseID) {
      const card = permissionCards.get(msg.toolUseID);
      card?.actions.querySelectorAll("button").forEach((b) => (b.disabled = false));
      renderCardState(msg.toolUseID);
    }
    // "open identity …" (or a reply that went to another project) takes you
    // to that project's history.
    if (msg.ok && msg.projectKey && NAVIGATING_ACTIONS.has(msg.action) && msg.projectKey !== currentProject) {
      loadProjects().then(() => openProject(msg.projectKey)).catch(() => {});
    }
    return;
  }
  // Project messages go to their own project; Jarvis's replies and notes
  // appear wherever you are.
  const key = msg.projectKey;
  if (key) {
    const p = projects.get(key);
    if (p) {
      p.lastActivity = Date.now();
      p.messageCount = (p.messageCount ?? 0) + 1;
    } else {
      loadProjects().catch(() => {});
    }
    if (currentProject === key && viewingLive) appendMessage(msg);
    else {
      unread.set(key, (unread.get(key) ?? 0) + 1);
      if (!currentProject) renderHome();
    }
    return;
  }
  appendMessage(msg, currentProject ? messagesEl : homeFeed);
}

async function login(passcode) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Login failed");
  }
  const { token } = await res.json();
  setToken(token);
  connect();
}

function connect() {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }

  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    showChat();
    connStatus.textContent = "connected";
    connStatus.className = "connected";
    connStatus.title = "Connected";
    reconnectDelay = 1000;
    // Reconnecting keeps you where you were; a notification's link
    // (?project=…) opens that project.
    const linked = new URLSearchParams(location.search).get("project");
    loadProjects()
      .then(() => {
        const target = currentProject ?? linked;
        if (target) openProject(target);
        else showHome();
      })
      .catch(() => {});
  };

  ws.onmessage = (event) => {
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch {
      appendMessage({ direction: "out", type: "system", content: event.data });
    }
  };

  ws.onclose = (event) => {
    connStatus.textContent = "disconnected";
    connStatus.className = "disconnected";
    connStatus.title = "Disconnected — reconnecting";
    if (event.code === 4401) {
      clearToken();
      showLogin("Session expired, please log in again.");
      return;
    }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

loginBtn.addEventListener("click", async () => {
  if (loginBtn.disabled) return;
  const passcode = passcodeInput.value.trim();
  if (!passcode) return;
  loginBtn.disabled = true;
  loginBtn.textContent = "Unlocking…";
  loginError.textContent = "";
  try {
    await login(passcode);
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Unlock";
  }
});

passcodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;
  // Only pin a typed reply to a request when exactly one is on screen;
  // with several, the server must make the user say which one.
  const pending = pendingIds();
  const replyTo = pending.length === 1 ? pending[0] : undefined;
  if (openChoice) {
    if (sendInbound({ type: "chat", content: text, openChoice: openChoice.choiceId })) {
      msgInput.value = "";
      endOpenChoice();
    }
    return;
  }
  const replyToSession = replyTarget
    ? { sessionId: replyTarget.sessionId, changedMsAgo: Date.now() - replyTarget.changedAt }
    : undefined;
  if (sendInbound({ type: "chat", content: text, replyTo, replyToSession })) msgInput.value = "";
}

sendBtn.addEventListener("click", sendMessage);

// ---- Voice input ----
// The browser's own speech recognition fills the message box for you to
// review; it never sends. Where the browser lacks it or refuses, say so
// plainly — including the error it gave — rather than failing silently.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_ERRORS = {
  "not-allowed": "Microphone access was refused. Allow it for this site in your browser settings, then try again.",
  "service-not-allowed": "This browser won't run speech recognition here (common in iPhone home-screen apps). Use the 🎤 key on your keyboard instead.",
  "no-speech": "Didn't hear anything — tap the mic and speak.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition couldn't reach the browser's speech service. Check your connection, or use your keyboard's dictation.",
  "language-not-supported": "Speech recognition doesn't support this language here.",
};
let recognizer = null;
let micNoteTimer = null;

function showMicNote(text) {
  micNote.textContent = text;
  micNote.classList.remove("hidden");
  clearTimeout(micNoteTimer);
  micNoteTimer = setTimeout(() => micNote.classList.add("hidden"), 8000);
}

micBtn.addEventListener("click", () => {
  if (!Recognition) {
    showMicNote("Voice input isn't available in this browser. On iPhone, use the 🎤 key on your keyboard instead — it works in this box too.");
    return;
  }
  if (recognizer) {
    recognizer.stop();
    return;
  }
  const r = new Recognition();
  recognizer = r;
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = false;
  const before = msgInput.value ? `${msgInput.value.trimEnd()} ` : "";
  r.onresult = (e) => {
    let heard = "";
    for (const result of e.results) heard += result[0].transcript;
    msgInput.value = before + heard; // into the box only — sending is always your tap
  };
  r.onerror = (e) => {
    if (e.error !== "aborted") showMicNote(MIC_ERRORS[e.error] ?? `Voice input stopped (${e.error}).`);
  };
  r.onend = () => {
    recognizer = null;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-label", "Speak instead of typing");
    msgInput.focus();
  };
  try {
    r.start();
    micBtn.classList.add("listening");
    micBtn.setAttribute("aria-label", "Stop listening");
    showMicNote("Listening… tap the mic again to stop. Nothing sends until you tap Send.");
  } catch (err) {
    recognizer = null;
    showMicNote(`Voice input couldn't start (${err.message}).`);
  }
});
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function updatePushButtonVisibility() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    enablePushBtn.classList.add("hidden");
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  enablePushBtn.classList.toggle("hidden", !!existing || Notification.permission === "denied");
}

async function enablePush() {
  const token = getToken();
  if (!token) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      loginError.textContent = "";
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const keyRes = await fetch("/api/push/vapid-public-key", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { key } = await keyRes.json();
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(subscription.toJSON()),
    });
    enablePushBtn.classList.add("hidden");
  } catch (err) {
    console.error("Push subscribe failed", err);
  }
}

enablePushBtn.addEventListener("click", enablePush);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.error("SW registration failed", err);
  });
  navigator.serviceWorker.ready.then(updatePushButtonVisibility).catch(() => {});
}

if (getToken()) {
  connect();
} else {
  showLogin();
}
