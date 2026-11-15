// ChirpKey server: Bolna web-call session minting, Bolna function tools,
// chirp-signed approvals, and action dispatch (Grok Bot and other webhooks).
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, listTargets } from "./lib/executors.js";
import { phraseMatches } from "./lib/phrase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3000);
const SIGNING_SECRET = env.CHIRP_SIGNING_SECRET || crypto.randomBytes(16).toString("hex");
const TOOLS_TOKEN = env.TOOLS_TOKEN || "";
const CALLBACK_TOKEN = env.CALLBACK_TOKEN || TOOLS_TOKEN;
const SECRET_PHRASE = env.SECRET_PHRASE || "";
const OWNER_NAME = env.OWNER_NAME || "";
const ALLOW_TEST = env.NODE_ENV !== "production";
const STATUS_WAIT_MS = Number(env.STATUS_WAIT_MS || 6000);

if (!env.CHIRP_SIGNING_SECRET) console.warn("[warn] CHIRP_SIGNING_SECRET not set; using a random one for this run.");
if (!TOOLS_TOKEN) console.warn("[warn] TOOLS_TOKEN not set; /tools/* endpoints are unauthenticated.");
if (!SECRET_PHRASE) console.warn("[warn] SECRET_PHRASE not set; identity check is skipped.");

// ---------- state (in memory; one owner, one call at a time) ----------
const actions = new Map(); // id -> action
// approval: "gibberlink" = phone approves by chirp; "voice" = the spoken yes on the call is enough.
const session = { verified: !SECRET_PHRASE, attempts: 0, startedAt: null, runId: null, mode: "classic", phone: false, approval: "gibberlink" };
function resetSession(mode, phone) {
  Object.assign(session, {
    verified: !SECRET_PHRASE, attempts: 0, startedAt: new Date().toISOString(), mode, phone, approval: "gibberlink",
  });
  broadcast("session", { verified: session.verified, mode, phone, approval: session.approval });
}
const calls = new Map(); // Bolna execution id -> call report
const sseClients = new Set();

function publicUrl(req) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, "");
  return `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`;
}

// ---------- chirp payloads: "R" (request) / "A" (approve) + 5-char id + 6-hex signature ----------
const sign = (kind, id) => crypto.createHmac("sha256", SIGNING_SECRET).update(kind + id).digest("hex").slice(0, 6);
const makePayload = (kind, id) => `${kind}${id}${sign(kind, id)}`;
function parsePayload(text) {
  const m = /^([RA])([0-9a-z]{5})([0-9a-f]{6})$/.exec(String(text || "").trim().toLowerCase().replace(/^([ra])/, (c) => c.toUpperCase()));
  if (!m) return null;
  const [, kind, id, sig] = m;
  const expected = sign(kind, id);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { kind, id };
}
const newId = () => {
  let id;
  do id = crypto.randomInt(0, 36 ** 5).toString(36).padStart(5, "0");
  while (actions.has(id));
  return id;
};

// ---------- SSE ----------
function broadcast(event, data, role) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) if (!role || c.role === role) c.res.write(msg);
}
const view = (a) => ({
  id: a.id, target: a.target, action: a.action, details: a.details, status: a.status,
  approvedVia: a.approvedVia || null, result: a.result || null, createdAt: a.createdAt, updatedAt: a.updatedAt,
});
// ---------- Bolna live events (graph agent) ----------
const TARGET_NAMES = { grok_bot: "Grok Bot", claude_code: "Claude Code", codex: "Codex", gpu: "the GPU runner" };
const STATUS_EVENTS = { approved: "action_approved", done: "action_done", failed: "action_failed", denied: "action_denied" };
async function fireEvent(event, properties) {
  if (session.mode !== "graph" || !session.runId || !env.BOLNA_API_KEY) return;
  try {
    const r = await fetch(`https://api.bolna.ai/v1/call/${session.runId}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ event, properties }),
      signal: AbortSignal.timeout(5000),
    });
    const text = (await r.text()).slice(0, 200);
    console.log(`[event] ${event} -> ${r.status} ${text}`);
    broadcast("bolna_event", { event, status: r.status, at: new Date().toISOString() });
  } catch (err) {
    console.warn(`[event] ${event} failed: ${err.message}`);
  }
}

function setStatus(a, status, extra = {}) {
  const changed = a.status !== status;
  Object.assign(a, extra, { status, updatedAt: new Date().toISOString() });
  broadcast("action", view(a));
  for (const w of a.waiters.splice(0)) w();
  console.log(`[action ${a.id}] ${status}${extra.result ? " - " + JSON.stringify(extra.result) : ""}`);
  // In voice mode the agent already said "approved", so skip that announcement.
  if (changed && STATUS_EVENTS[status] && !(status === "approved" && a.approvedVia === "voice")) {
    queueEvent(a, status);
  }
}

// Events go out one at a time, in order. Fast tasks (opening a URL) can finish before the
// "approved" event is even sent; then we skip "approved" and announce only the result.
let eventChain = Promise.resolve();
function queueEvent(a, status) {
  eventChain = eventChain.then(async () => {
    if (status === "approved") {
      await new Promise((r) => setTimeout(r, 400));
      if (["done", "failed"].includes(a.status)) return;
    }
    await fireEvent(STATUS_EVENTS[status], {
      action: a.action,
      target_name: TARGET_NAMES[a.target] || a.target,
      result_summary: a.result?.summary || "",
    });
    // Give the agent a moment to start speaking before the next event moves it on.
    if (status === "approved") await new Promise((r) => setTimeout(r, 2500));
  }).catch(() => {});
}

async function approve(a, via, req) {
  if (a.status !== "awaiting_approval") return false;
  setStatus(a, "approved", { approvedVia: via });
  try {
    const out = await dispatch(a, {
      callbackUrl: `${publicUrl(req)}/api/actions/${a.id}/result`,
      callbackToken: CALLBACK_TOKEN,
      ownerName: OWNER_NAME,
      onResult: ({ status, summary }) => setStatus(a, status, { result: { summary } }),
    });
    setStatus(a, out.status, { result: out.result });
    if (out.simulateDoneAfterMs) {
      setTimeout(() => a.status === "dispatched" && setStatus(a, "done", { result: { summary: `Simulated: ${a.action}` } }), out.simulateDoneAfterMs);
    }
  } catch (err) {
    setStatus(a, "failed", { result: { summary: `Dispatch failed: ${err.message}` } });
  }
  return true;
}

function createAction({ target, action, details, chirp = true }) {
  const id = newId();
  const now = new Date().toISOString();
  const a = {
    id, target, action, details, status: "awaiting_approval", createdAt: now, updatedAt: now,
    requestChirp: makePayload("R", id), approveChirp: makePayload("A", id), waiters: [],
  };
  actions.set(id, a);
  broadcast("action", view(a));
  if (chirp) broadcast("chirp", { actionId: id, payload: a.requestChirp }, "console");
  console.log(`[action ${id}] requested: ${target} / ${action}${chirp ? "" : " (voice mode)"}`);
  // Expire unapproved requests after 10 minutes.
  setTimeout(() => a.status === "awaiting_approval" && setStatus(a, "expired"), 10 * 60 * 1000);
  return a;
}

function latestAction(id) {
  if (id && actions.has(String(id).toLowerCase())) return actions.get(String(id).toLowerCase());
  return [...actions.values()].at(-1) || null;
}

function statusSentence(a) {
  const r = a.result?.summary ? ` Result: ${a.result.summary}` : "";
  switch (a.status) {
    case "awaiting_approval": return "Still waiting for the owner to approve on their phone.";
    case "approved": return "Approved. Sending it off now.";
    case "dispatched": return `Approved via ${a.approvedVia} and handed to ${a.target}. It is working on it; the result will come in shortly.${r}`;
    case "done": return `Done.${r}`;
    case "denied": return "The owner denied this request on their phone. Do not retry unless they ask.";
    case "expired": return "The request expired without approval.";
    case "failed": return `It failed.${r}`;
    default: return `Status: ${a.status}.${r}`;
  }
}

// ---------- app ----------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));
// No caching, so a reload always picks up the latest pages during the demo.
app.use(express.static(path.join(__dirname, "public"), { etag: false, lastModified: false, setHeaders: (res) => res.set("Cache-Control", "no-store") }));
app.get("/vendor/ggwave.js", (_req, res) => res.sendFile(path.join(__dirname, "node_modules/ggwave/ggwave.js")));
app.get("/vendor/bolna-web-call.min.js", (_req, res) =>
  res.sendFile(path.join(__dirname, "node_modules/@bolna/web-call/dist/bolna-web-call.min.js")));
app.get("/phone", (_req, res) => res.sendFile(path.join(__dirname, "public/phone.html")));

app.get("/api/config", (_req, res) => {
  res.json({
    chirpProtocol: env.CHIRP_PROTOCOL || "GGWAVE_PROTOCOL_ULTRASOUND_FASTEST",
    bolnaConfigured: Boolean(env.BOLNA_API_KEY && env.BOLNA_AGENT_ID),
    phraseRequired: Boolean(SECRET_PHRASE),
    targets: listTargets(),
    testMode: ALLOW_TEST,
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/$/, "") : null,
    graphAvailable: Boolean(env.BOLNA_GRAPH_AGENT_ID),
  });
});

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const client = { role: req.query.role === "phone" ? "phone" : "console", res };
  sseClients.add(client);
  res.write(`event: hello\ndata: ${JSON.stringify({ actions: [...actions.values()].map(view), session: { verified: session.verified } })}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(client); });
});

// Bolna web-call session mint. The SDK POSTs { user_data } here; the bn- key never reaches the browser.
app.post("/api/bolna-session", async (req, res) => {
  // Live (graph) agent by default; ?mode=classic is the fallback.
  const mode = req.query.mode !== "classic" && env.BOLNA_GRAPH_AGENT_ID ? "graph" : "classic";
  const agentId = mode === "graph" ? env.BOLNA_GRAPH_AGENT_ID : env.BOLNA_AGENT_ID;
  if (!env.BOLNA_API_KEY || !agentId) return res.status(500).json({ error: "Set BOLNA_API_KEY and BOLNA_AGENT_ID in .env" });
  session.runId = null;
  resetSession(mode, false);
  const body = JSON.stringify({ agent_id: agentId, user_data: req.body?.user_data || {} });
  const headers = { Authorization: `Bearer ${env.BOLNA_API_KEY}`, "Content-Type": "application/json" };
  try {
    let r = await fetch("https://api.bolna.ai/web-call/freeswitch-session", { method: "POST", headers, body });
    if (r.status === 404) r = await fetch("https://api.bolna.ai/web-call/session", { method: "POST", headers, body });
    const text = await r.text();
    if (!r.ok) console.error(`[bolna-session] ${r.status} ${text}`);
    try { session.runId = JSON.parse(text).run_id || null; } catch {}
    console.log(`[bolna-session] ${mode} agent, run ${session.runId}`);
    res.status(r.status).type("application/json").send(text);
  } catch (err) {
    res.status(502).json({ error: `Could not reach Bolna: ${err.message}` });
  }
});

// ---------- Bolna function tools ----------
function toolsAuth(req, res, next) {
  if (!TOOLS_TOKEN) return next();
  const got = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (got.length === TOOLS_TOKEN.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOOLS_TOKEN))) return next();
  res.status(401).json({ message: "Unauthorized tool call." });
}
const args = (req) => ({ ...req.query, ...(req.body || {}) });

app.post("/tools/verify_identity", toolsAuth, (req, res) => {
  const { name = "", secret_phrase = "" } = args(req);
  if (!SECRET_PHRASE) { session.verified = true; return res.json({ verified: true, message: "No phrase configured. Verified." }); }
  if (session.attempts >= 3) return res.json({ verified: false, message: "Too many wrong attempts. Tell the caller you cannot take actions on this call and end politely." });
  session.attempts++;
  const ok = phraseMatches(secret_phrase, SECRET_PHRASE);
  session.verified = ok;
  broadcast("session", { verified: ok });
  console.log(`[verify] name="${name}" ok=${ok} attempt=${session.attempts}`);
  const modeAsk = session.phone
    ? ` This is a phone call: after greeting, ask once "Gibberlink mode, where I chirp approvals to your phone, or plain voice mode?" and call set_approval_mode with their answer.`
    : "";
  res.json(ok
    ? { verified: true, message: `Verified. Greet ${OWNER_NAME || name || "them"} by name.${modeAsk} Then ask what they want done.` }
    : { verified: false, message: `That phrase is wrong (${3 - session.attempts} attempts left). Ask them to say it again. Never reveal or hint at the phrase.` });
});

app.post("/tools/request_action", toolsAuth, (req, res) => {
  if (!session.verified) return res.json({ ok: false, message: "Caller is not verified yet. Ask for their name and secret phrase and call verify_identity first." });
  let { target = "grok_bot", action = "", details = "" } = args(req);
  target = String(target).toLowerCase().trim().replace(/[\s-]+/g, "_");
  const targets = listTargets().map((t) => t.id);
  if (!targets.includes(target)) target = "grok_bot";
  if (!String(action).trim()) return res.json({ ok: false, message: "Missing action. Ask the caller what exactly they want done." });
  if (session.approval === "voice") {
    // Voice mode: the caller's spoken yes (after the read-back) is the approval. No chirp.
    const a = createAction({ target, action: String(action).slice(0, 200), details: String(details).slice(0, 2000), chirp: false });
    approve(a, "voice", req);
    return res.json({
      ok: true, action_id: a.id,
      message: `Approved by voice and sent to ${TARGET_NAMES[target] || target}. Tell them it's on its way${session.mode === "graph" ? "; you will be told automatically when it finishes" : " and call check_action_status for the result"}.`,
    });
  }
  const a = createAction({ target, action: String(action).slice(0, 200), details: String(details).slice(0, 2000) });
  res.json({
    ok: true, action_id: a.id,
    message: session.mode === "graph"
      ? `Approval chirp is playing now. Say only "Check your phone." and stop. You will be told automatically when it is approved and when it finishes.`
      : `Approval chirp is playing now. Say only "Check your phone." Then immediately call check_action_status with action_id ${a.id}; it waits for the approval.`,
  });
});

app.post("/tools/set_approval_mode", toolsAuth, (req, res) => {
  const raw = String(args(req).mode || "").toLowerCase();
  const mode = /voice|plain|normal|human|talk/.test(raw) ? "voice" : "gibberlink";
  session.approval = mode;
  broadcast("session", { verified: session.verified, mode: session.mode, phone: session.phone, approval: mode });
  console.log(`[mode] approval=${mode} (heard "${raw}")`);
  res.json({
    ok: true, approval_mode: mode,
    message: mode === "voice"
      ? "Voice mode on. From now on, the caller's yes after your read-back is the approval; no chirps. Tell them in one sentence."
      : "Gibberlink mode on. Approvals now go to their phone as chirps; they tap Approve. Tell them in one sentence.",
  });
});

app.post("/tools/check_action_status", toolsAuth, async (req, res) => {
  const a = latestAction(args(req).action_id);
  if (!a) return res.json({ message: "There are no requests yet." });
  if (["awaiting_approval", "approved", "dispatched"].includes(a.status)) {
    const before = a.status;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, STATUS_WAIT_MS);
      a.waiters.push(() => { clearTimeout(t); resolve(); });
    });
    if (a.status === "approved" && before !== "approved") await new Promise((r) => setTimeout(r, 800));
  }
  res.json({ action_id: a.id, status: a.status, message: statusSentence(a) });
});

// ---------- chirp endpoints (phone + console) ----------
app.post("/api/chirp/resolve", (req, res) => {
  const p = parsePayload(req.body?.payload);
  if (!p || p.kind !== "R") return res.status(400).json({ error: "Not a valid ChirpKey request chirp." });
  const a = actions.get(p.id);
  if (!a) return res.status(404).json({ error: "Unknown or old request." });
  res.json({ action: view(a), approveChirp: a.status === "awaiting_approval" ? a.approveChirp : null });
});

app.post("/api/chirp/heard", async (req, res) => {
  const p = parsePayload(req.body?.payload);
  if (!p || p.kind !== "A") return res.status(400).json({ error: "Not a valid approval chirp." });
  const a = actions.get(p.id);
  if (!a) return res.status(404).json({ error: "Unknown request." });
  const changed = await approve(a, "chirp", req);
  res.json({ ok: true, changed, action: view(a) });
});

// Network fallback from the phone. The request chirp payload proves the phone heard the laptop.
app.post("/api/actions/:id/decision", async (req, res) => {
  const a = actions.get(req.params.id);
  const p = parsePayload(req.body?.proof);
  if (!a || !p || p.kind !== "R" || p.id !== a.id) return res.status(403).json({ error: "Invalid proof for this request." });
  if (req.body?.decision === "deny") {
    if (a.status === "awaiting_approval") setStatus(a, "denied");
  } else {
    await approve(a, "phone_tap", req);
  }
  res.json({ ok: true, action: view(a) });
});

// Result callback from Grok Bot / other executors.
app.post("/api/actions/:id/result", (req, res) => {
  const got = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (CALLBACK_TOKEN && got !== CALLBACK_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  const a = actions.get(req.params.id);
  if (!a) return res.status(404).json({ error: "Unknown request" });
  const status = ["done", "failed", "dispatched"].includes(req.body?.status) ? req.body.status : "done";
  setStatus(a, status, { result: { summary: String(req.body?.summary || "").slice(0, 1000), data: req.body?.data ?? null } });
  res.json({ ok: true });
});

app.get("/api/actions", (_req, res) => res.json([...actions.values()].map(view).reverse()));

app.post("/api/actions/:id/replay", (req, res) => {
  const a = actions.get(req.params.id);
  if (!a || a.status !== "awaiting_approval") return res.status(400).json({ error: "Nothing to replay." });
  broadcast("chirp", { actionId: a.id, payload: a.requestChirp }, "console");
  res.json({ ok: true });
});

// Local testing without a Bolna call.
app.post("/api/test/request", (req, res) => {
  if (!ALLOW_TEST) return res.status(404).end();
  const { target = "grok_bot", action = "Test action", details = "" } = req.body || {};
  const a = createAction({ target, action, details });
  res.json(view(a));
});

// ---------- call reports (Bolna execution webhook + executions API) ----------
function toReport(x) {
  return {
    id: x.id,
    agentId: x.agent_id,
    status: x.status,
    duration: x.conversation_duration ?? x.telephony_data?.duration ?? null,
    createdAt: x.created_at,
    summary: x.summary || null,
    extracted: x.extracted_data || null,
    termination: x.termination_reason || null,
    turns: typeof x.transcript === "string" ? x.transcript.split("\n").filter(Boolean).length : null,
  };
}
function storeCall(x) {
  if (!x?.id) return;
  const prev = calls.get(x.id) || {};
  const next = { ...prev, ...Object.fromEntries(Object.entries(toReport(x)).filter(([, v]) => v !== null && v !== undefined)) };
  calls.set(x.id, next);
  broadcast("call", next);
}

app.post("/webhooks/bolna", (req, res) => {
  if (TOOLS_TOKEN && req.query.token !== TOOLS_TOKEN) return res.status(401).end();
  const x = req.body?.data || req.body;
  storeCall(x);
  console.log(`[webhook] execution ${x?.id} ${x?.status} (${x?.telephony_data?.provider || x?.provider || "?"})`);
  // Phone calls (inbound to the Bolna number, or "Call my phone") don't go through the web-call
  // mint, so pick up the run here. The execution id is the run_id the events API needs.
  const isPhone = (x?.telephony_data?.provider || x?.provider) !== "web-call";
  if (isPhone && x?.id && ["initiated", "ringing", "in-progress"].includes(x.status) && session.runId !== x.id) {
    session.runId = x.id;
    resetSession(x.agent_id === env.BOLNA_GRAPH_AGENT_ID ? "graph" : "classic", true);
    console.log(`[phone-call] ${session.mode} agent, run ${x.id}`);
  }
  res.json({ ok: true });
});

// "Call my phone": the live agent dials the owner from the Bolna number.
app.post("/api/call-me", async (req, res) => {
  const to = String(req.body?.to || env.OWNER_PHONE || "").replace(/[^\d+]/g, "");
  if (!/^\+\d{8,15}$/.test(to)) return res.status(400).json({ error: "Enter the number in international format, e.g. +9198XXXXXXXX" });
  const agentId = env.BOLNA_GRAPH_AGENT_ID || env.BOLNA_AGENT_ID;
  const body = { agent_id: agentId, recipient_phone_number: to, ...(env.BOLNA_PHONE_NUMBER ? { from_phone_number: env.BOLNA_PHONE_NUMBER } : {}) };
  try {
    const r = await fetch("https://api.bolna.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    console.log(`[call-me] ${to} -> ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
    if (r.ok && data.execution_id) {
      session.runId = data.execution_id;
      resetSession(agentId === env.BOLNA_GRAPH_AGENT_ID ? "graph" : "classic", true);
    }
    res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true, execution_id: data.execution_id } : { error: data.message || data.detail || JSON.stringify(data) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/calls", async (_req, res) => {
  if (env.BOLNA_API_KEY) {
    for (const id of [env.BOLNA_AGENT_ID, env.BOLNA_GRAPH_AGENT_ID].filter(Boolean)) {
      try {
        const r = await fetch(`https://api.bolna.ai/v2/agent/${id}/executions?page_size=10`, {
          headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}` }, signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const data = await r.json();
        const rows = Array.isArray(data) ? data : data.data || data.executions || [];
        rows.forEach(storeCall);
      } catch {}
    }
  }
  res.json([...calls.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20));
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`ChirpKey on http://localhost:${PORT}  (console)  |  /phone  (phone approver)`);
  console.log(`Targets: ${listTargets().map((t) => `${t.id}${t.configured ? "" : " (simulated)"}`).join(", ")}`);
});
