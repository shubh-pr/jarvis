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

function appendMessage({ direction, type, content, tag, projectTag, toolUseID }) {
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
  div.appendChild(document.createTextNode(content));
  if (type === "permission_request" && toolUseID) {
    div.classList.add("perm");
    buildPermissionCard(div, toolUseID);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleServerMessage(msg) {
  if (msg.type === "history") {
    messagesEl.replaceChildren();
    permissionCards.clear();
    msg.messages.forEach(appendMessage);
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
  if (sendInbound({ type: "chat", content: text, replyTo })) msgInput.value = "";
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
