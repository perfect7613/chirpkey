import { Chirp, PROTOCOLS, STATUS_LABEL, api } from "/chirp.js";

const $ = (id) => document.getElementById(id);
const chirp = new Chirp();
const actions = new Map();
let call = null;
let config = null;
let pendingChirps = [];
let playing = Promise.resolve();

function pill(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${kind || ""}`;
}

const MODE_KEY = "chirpkey.mode";
function mode() { return $("mode").value; }

async function loadConfig() {
  config = await api("/api/config");
  const saved = (() => { try { return localStorage.getItem(MODE_KEY); } catch { return null; } })();
  for (const [value, label] of Object.entries(PROTOCOLS)) $("mode").add(new Option(label, value));
  $("mode").value = saved && PROTOCOLS[saved] ? saved : config.chirpProtocol;
  $("mode").onchange = () => { try { localStorage.setItem(MODE_KEY, mode()); } catch {} };

  for (const t of config.targets) $("t-target").add(new Option(`${t.id}${t.configured ? "" : " (simulated)"}`, t.id));
  if (!config.testMode) $("test-card").classList.add("hidden");

  const phoneUrl = `${config.publicUrl || location.origin}/phone`;
  $("phone-url").textContent = phoneUrl;
  if (window.QRCode) new QRCode($("qr"), { text: phoneUrl, width: 120, height: 120 });
  else $("qr").classList.add("hidden");

  const notes = [];
  if (!config.bolnaConfigured) notes.push("Bolna isn't configured: set <code>BOLNA_API_KEY</code> and <code>BOLNA_AGENT_ID</code> in <code>.env</code>, then run <code>npm run setup-agent</code>. You can still test chirps below.");
  if (!config.publicUrl && /localhost|127\.0\.0\.1/.test(location.host)) notes.push("Phones need HTTPS for the microphone. Run <code>ngrok http 3000</code> and set <code>PUBLIC_URL</code> so the QR code points there.");
  if (notes.length) { $("setup-banner").innerHTML = notes.join("<br>"); $("setup-banner").classList.remove("hidden"); }
  pill("pill-verified", config.phraseRequired ? "Not verified" : "No phrase set", config.phraseRequired ? "" : "warn");
}

function render() {
  const list = [...actions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const feed = $("feed");
  feed.innerHTML = "";
  if (!list.length) { feed.innerHTML = '<li class="empty">No requests yet.</li>'; return; }
  for (const a of list) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = a.action;
    const status = document.createElement("span");
    status.className = `status ${a.status}`;
    status.textContent = STATUS_LABEL[a.status] || a.status;
    const meta = document.createElement("div");
    meta.className = "meta";
    const bits = [`${a.target}`, `#${a.id}`];
    if (a.approvedVia) bits.push(`approved via ${a.approvedVia.replace("_", " ")}`);
    meta.textContent = bits.join(" · ") + (a.result?.summary ? ` — ${a.result.summary}` : "");
    li.append(title, status, meta);
    if (a.status === "awaiting_approval") {
      const replay = document.createElement("button");
      replay.textContent = "Replay chirp";
      replay.className = "small";
      replay.style.gridColumn = "1 / -1";
      replay.style.justifySelf = "start";
      replay.onclick = () => api(`/api/actions/${a.id}/replay`, {}).catch((e) => alert(e.message));
      li.append(replay);
    }
    feed.append(li);
  }
}

// Plays queued request chirps one at a time. Needs a prior click to unlock audio.
function queueChirp(payload) {
  if (!chirp.instance) {
    pendingChirps.push(payload);
    $("setup-banner").innerHTML = "A request chirp is waiting. <b>Click anywhere</b> to enable audio.";
    $("setup-banner").classList.remove("hidden");
    return;
  }
  playing = playing.then(async () => {
    // Mute our side of the call while chirping so the agent doesn't transcribe the tones.
    const inCall = call && call.getState() === "active";
    if (inCall) call.setMuted(true);
    pill("pill-mic", "Chirping…", "warn");
    try {
      await chirp.send(payload, mode(), { repeat: 2, volume: 60 });
    } finally {
      if (inCall) call.setMuted(false);
      pill("pill-mic", chirp.listening ? "Laptop ear: on" : "Laptop ear: off", chirp.listening ? "ok" : "");
    }
  }).catch((e) => console.error("chirp send failed", e));
}

document.addEventListener("click", async () => {
  if (!pendingChirps.length) return;
  await enableAudio();
  const queued = pendingChirps.splice(0);
  $("setup-banner").classList.add("hidden");
  queued.forEach(queueChirp);
});

async function enableAudio() {
  await chirp.init();
  if (!chirp.listening) {
    try {
      await chirp.listen(onHeard, (lvl) => { $("mic-level").style.width = `${Math.min(100, lvl * 300)}%`; });
      pill("pill-mic", "Laptop ear: on", "ok");
    } catch (e) {
      pill("pill-mic", "Laptop ear: blocked", "bad");
      console.warn("mic listener failed", e);
    }
  }
}

let lastHeard = "";
async function onHeard(text) {
  if (!text.startsWith("A") || text === lastHeard) return; // ignore our own request chirps
  lastHeard = text;
  try {
    await api("/api/chirp/heard", { payload: text });
  } catch (e) {
    console.warn("approval chirp rejected", e.message);
  }
}

function connectEvents() {
  const es = new EventSource("/api/events?role=console");
  es.addEventListener("open", () => pill("pill-server", "Server: live", "ok"));
  es.addEventListener("error", () => pill("pill-server", "Server: reconnecting", "warn"));
  es.addEventListener("hello", (e) => {
    const data = JSON.parse(e.data);
    actions.clear();
    data.actions.forEach((a) => actions.set(a.id, a));
    render();
  });
  es.addEventListener("action", (e) => {
    const a = JSON.parse(e.data);
    actions.set(a.id, a);
    render();
  });
  es.addEventListener("chirp", (e) => queueChirp(JSON.parse(e.data).payload));
  es.addEventListener("bolna_event", (e) => {
    const ev = JSON.parse(e.data);
    const list = $("events");
    if (list.querySelector(".empty")) list.innerHTML = "";
    const li = document.createElement("li");
    li.textContent = `${new Date(ev.at).toLocaleTimeString()}  ${ev.event}  →  ${ev.status === 202 ? "agent speaking" : `HTTP ${ev.status}`}`;
    list.prepend(li);
  });
  es.addEventListener("call", () => scheduleCalls());
  es.addEventListener("session", (e) => {
    const { verified } = JSON.parse(e.data);
    if (config?.phraseRequired) pill("pill-verified", verified ? "Verified" : "Not verified", verified ? "ok" : "");
  });
}

async function toggleCall() {
  const btn = $("btn-call");
  if (call && !["idle", "ended"].includes(call.getState())) {
    await call.stop();
    return;
  }
  btn.disabled = true;
  await enableAudio();
  call = new window.BolnaWebCall({ sessionUrl: `/api/bolna-session?mode=${$("agent-mode").value}` });
  call.on("state-change", (s) => {
    pill("pill-call", `Call: ${s}`, s === "active" ? "ok" : s === "ended" ? "" : "warn");
    btn.textContent = ["connecting", "ringing", "active"].includes(s) ? "End call" : "Start web call";
    btn.className = ["connecting", "ringing", "active"].includes(s) ? "danger big" : "primary big";
    btn.disabled = false;
  });
  call.on("volume-level", (lvl) => { $("agent-level").style.width = `${Math.min(100, lvl * 100)}%`; });
  call.on("call-end", () => { $("agent-level").style.width = "0"; });
  call.on("error", (e) => {
    btn.disabled = false;
    const hint = e.code === "at_capacity" && e.scope === "not_enabled"
      ? " Web calls aren't enabled on this Bolna account yet; ask Bolna support."
      : e.code === "mint_failed" ? " Check the server log and your .env." : "";
    pill("pill-call", `Call: ${e.code}`, "bad");
    $("setup-banner").innerHTML = `${e.message}${hint}`;
    $("setup-banner").classList.remove("hidden");
  });
  try { await call.start(); } catch { /* surfaced via the error event */ }
}

$("btn-call").onclick = toggleCall;
$("t-send").onclick = async () => {
  await enableAudio();
  try {
    await api("/api/test/request", { target: $("t-target").value, action: $("t-action").value, details: $("t-details").value });
  } catch (e) { alert(e.message); }
};

// ---------- call reports ----------
function flattenExtracted(x, out = []) {
  if (!x || typeof x !== "object") return out;
  for (const [k, v] of Object.entries(x)) {
    if (v && typeof v === "object" && ("objective" in v || "subjective" in v)) {
      const val = v.objective || v.subjective;
      if (val && k !== "Call Summary") out.push([k, String(val)]);
    } else if (v && typeof v === "object") flattenExtracted(v, out);
  }
  return out;
}
async function loadCalls() {
  const list = $("calls");
  try {
    const rows = await api("/api/calls");
    list.innerHTML = "";
    if (!rows.length) { list.innerHTML = '<li class="empty">No calls yet.</li>'; return; }
    for (const c of rows.slice(0, 8)) {
      const li = document.createElement("li");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = `${c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : ""} · ${c.duration ? Math.round(c.duration) + "s" : "—"}${c.agentId === config.graphAgentId ? "" : ""}`;
      const st = document.createElement("span");
      st.className = `status ${c.status === "completed" ? "done" : ""}`;
      st.textContent = c.status || "";
      const meta = document.createElement("div");
      meta.className = "meta";
      const facts = flattenExtracted(c.extracted).map(([k, v]) => `${k}: ${v}`).join(" · ");
      meta.textContent = [c.summary, facts].filter(Boolean).join("  —  ") || "Summary pending (Bolna processes it after the call).";
      li.append(title, st, meta);
      list.append(li);
    }
  } catch (e) {
    list.innerHTML = `<li class="empty">${e.message}</li>`;
  }
}
let callsTimer = null;
function scheduleCalls() { clearTimeout(callsTimer); callsTimer = setTimeout(loadCalls, 800); }
$("btn-calls").onclick = loadCalls;

// ---------- phone calls through the Bolna number ----------
try { $("my-phone").value = localStorage.getItem("chirpkey.myphone") || ""; } catch {}
$("btn-call-me").onclick = async () => {
  await enableAudio(); // the laptop still plays and hears the chirps during a phone call
  const to = $("my-phone").value.trim();
  try { localStorage.setItem("chirpkey.myphone", to); } catch {}
  $("btn-call-me").disabled = true;
  try {
    await api("/api/call-me", { to });
    pill("pill-call", "Call: dialing your phone", "warn");
  } catch (e) {
    $("setup-banner").textContent = `Call failed: ${e.message}`;
    $("setup-banner").classList.remove("hidden");
  } finally {
    setTimeout(() => ($("btn-call-me").disabled = false), 4000);
  }
};

loadConfig().then(() => {
  if (!config.graphAvailable) { $("agent-mode").value = "classic"; $("agent-mode").disabled = true; }
  connectEvents();
  loadCalls();
}).catch((e) => pill("pill-server", `Server: ${e.message}`, "bad"));
