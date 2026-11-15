import { Chirp, PROTOCOLS, STATUS_LABEL, api } from "/chirp.js";

const $ = (id) => document.getElementById(id);
const chirp = new Chirp();
let current = null; // { action, approveChirp, proof }
let networkTimer = null;
const MODE_KEY = "chirpkey.phone.mode";

function show(view) {
  for (const v of ["v-start", "v-request", "v-result"]) $(v).classList.toggle("hidden", v !== view);
}
function pill(text, kind) { $("pill").textContent = text; $("pill").className = `pill ${kind || ""}`; }

async function init() {
  const cfg = await api("/api/config").catch(() => ({ chirpProtocol: "GGWAVE_PROTOCOL_ULTRASOUND_FASTEST" }));
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch {}
  for (const [value, label] of Object.entries(PROTOCOLS)) $("mode").add(new Option(label, value));
  $("mode").value = saved && PROTOCOLS[saved] ? saved : cfg.chirpProtocol;
  $("mode").onchange = () => { try { localStorage.setItem(MODE_KEY, $("mode").value); } catch {} };
  if (!window.isSecureContext) $("hint").textContent = "This page needs HTTPS for the microphone. Open the ngrok URL.";
  connectEvents();
}

function connectEvents() {
  const es = new EventSource("/api/events?role=phone");
  es.addEventListener("action", (e) => {
    const a = JSON.parse(e.data);
    if (!current || a.id !== current.action.id) return;
    current.action = a;
    if (a.status !== "awaiting_approval") showResult(a);
  });
}

async function startListening() {
  $("btn-listen").disabled = true;
  try {
    await chirp.listen(onHeard, (lvl) => {
      $("orb").style.transform = `scale(${1 + Math.min(0.5, lvl * 2)})`;
    });
    pill("Listening", "ok");
    $("btn-listen").textContent = "Listening for the laptop…";
  } catch (e) {
    pill("Mic blocked", "bad");
    $("hint").textContent = `Microphone error: ${e.message}`;
    $("btn-listen").disabled = false;
  }
}

let busy = false;
async function onHeard(text) {
  if (!text.startsWith("R") || busy || (current && current.proof === text)) return; // ignore our own approval chirps
  busy = true;
  try {
    const { action, approveChirp } = await api("/api/chirp/resolve", { payload: text });
    current = { action, approveChirp, proof: text };
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    if (action.status !== "awaiting_approval") return showResult(action);
    $("r-target").textContent = action.target.replace("_", " ");
    $("r-action").textContent = action.action;
    $("r-details").textContent = action.details || "";
    $("r-id").textContent = `Request #${action.id} · signed`;
    $("r-status").textContent = "";
    $("btn-network").classList.add("hidden");
    $("btn-approve").disabled = false;
    $("btn-deny").disabled = false;
    pill("Request received", "warn");
    show("v-request");
  } catch (e) {
    console.warn("resolve failed", e.message);
  } finally {
    busy = false;
  }
}

async function approve() {
  if (!current) return;
  $("btn-approve").disabled = true;
  $("btn-deny").disabled = true;
  $("r-status").textContent = "Sending approval chirp to the laptop…";
  pill("Chirping", "warn");
  try {
    await chirp.send(current.approveChirp, $("mode").value, { repeat: 2, volume: 60 });
  } catch (e) {
    $("r-status").textContent = `Could not play audio: ${e.message}`;
  }
  $("r-status").textContent = "Waiting for the laptop to confirm…";
  clearTimeout(networkTimer);
  networkTimer = setTimeout(() => {
    if (current?.action.status === "awaiting_approval") $("btn-network").classList.remove("hidden");
  }, 3500);
}

async function decide(decision) {
  if (!current) return;
  try {
    const { action } = await api(`/api/actions/${current.action.id}/decision`, { decision, proof: current.proof });
    current.action = action;
    showResult(action);
  } catch (e) {
    $("r-status").textContent = e.message;
  }
}

function showResult(a) {
  clearTimeout(networkTimer);
  const good = ["approved", "dispatched", "done"].includes(a.status);
  $("res-icon").textContent = a.status === "done" ? "✓" : good ? "↗" : "✕";
  $("res-icon").style.color = good ? "var(--ok)" : "var(--bad)";
  $("res-title").textContent = `${STATUS_LABEL[a.status] || a.status}: ${a.action}`;
  $("res-text").textContent = a.result?.summary || (a.approvedVia ? `Approved via ${a.approvedVia.replace("_", " ")}.` : "");
  pill(STATUS_LABEL[a.status] || a.status, good ? "ok" : "bad");
  show("v-result");
}

$("btn-listen").onclick = startListening;
$("btn-approve").onclick = approve;
$("btn-deny").onclick = () => decide("deny");
$("btn-network").onclick = () => decide("approve");
$("btn-back").onclick = () => { current = null; pill(chirp.listening ? "Listening" : "Idle", chirp.listening ? "ok" : ""); show("v-start"); };

init();
