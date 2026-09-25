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

function appendMessage({ direction, type, content, tag, projectTag, toolUseID, sessionId, choiceId, choices }) {
  const div = document.createElement("div");
  const cls = type === "system" ? "system" : direction === "in" ? "in" : "out";
  div.className = `msg ${cls}`;
  // Every message is always between exactly two parties, You and Jarvis —
  // never a project name or device on its own. The project a message
  // concerns (if any) is shown after the arrow as context, not as the sender.
  const label =
    cls === "in" ? (projectTag ? `You → ${projectTag}` : "You") : cls === "out" ? (projectTag ? `Jarvis → ${projectTag}` : "Jarvis") : null;
  if (label && cls !== "system") {
    const tagEl = document.createElement("span");
    tagEl.className = "msg-tag";
    tagEl.textContent = label;
    div.appendChild(tagEl);
  }
  const questions = type === "permission_request" && toolUseID ? permissions.get(toolUseID)?.questions : undefined;
  const summary = type === "permission_request" && toolUseID ? permissions.get(toolUseID)?.summary : undefined;
  // Cards show their request structured — the question, or the plain-English
  // gist — instead of the raw text.
  if (summary) renderSummary(div, summary);
  else if (!questions) div.appendChild(document.createTextNode(content));
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
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Messages waiting for a busy session, straight from the server's queue —
// exactly what will be sent when the session is free. ✕ takes one back.
function renderQueue(sessions) {
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
      row.append(text, remove);
      queuePanel.appendChild(row);
    }
  }
}

function handleServerMessage(msg) {
  if (msg.type === "queue") {
    renderQueue(msg.sessions);
    return;
  }
  if (msg.type === "history") {
    messagesEl.replaceChildren();
    permissionCards.clear();
    replyTarget = null;
    openChoice = null;
    choiceButtonGroups = [];
    msg.messages.forEach(appendMessage);
    renderReplyTarget();
    return;
  }
  if (msg.type === "permissions") {
    permissions.clear();
    for (const item of msg.items) permissions.set(item.toolUseID, item);
    for (const id of permissionCards.keys()) renderCardState(id);
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
    return;
  }
  appendMessage(msg);
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
    reconnectDelay = 1000;
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
