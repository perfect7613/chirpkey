// Creates or updates the ChirpKey agents on Bolna, with tools pointing at PUBLIC_URL.
//   npm run setup-agent              classic agent  (BOLNA_AGENT_ID)
//   npm run setup-agent -- --graph   graph agent with live events (BOLNA_GRAPH_AGENT_ID)
//   add --print to print the JSON instead of calling Bolna
// Also attaches the "ChirpKey Outcomes" post-call extraction category to the agent.
import { buildAgent } from "./agent-config.mjs";
import { listTargets } from "../lib/executors.js";

const { BOLNA_API_KEY, BOLNA_AGENT_ID, BOLNA_GRAPH_AGENT_ID, PUBLIC_URL, TOOLS_TOKEN, OWNER_NAME } = process.env;
const print = process.argv.includes("--print");
const graph = process.argv.includes("--graph");
const agentId = graph ? BOLNA_GRAPH_AGENT_ID : BOLNA_AGENT_ID;
const envName = graph ? "BOLNA_GRAPH_AGENT_ID" : "BOLNA_AGENT_ID";

if (!PUBLIC_URL || !/^https:\/\//.test(PUBLIC_URL)) {
  console.error("Set PUBLIC_URL to your public https URL (e.g. the ngrok URL) in .env first.");
  process.exit(1);
}

const body = buildAgent({
  publicUrl: PUBLIC_URL.replace(/\/$/, ""),
  toolsToken: TOOLS_TOKEN,
  ownerName: OWNER_NAME,
  targets: listTargets(),
  graph,
});

if (print) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}
if (!BOLNA_API_KEY) {
  console.error("Set BOLNA_API_KEY in .env.");
  process.exit(1);
}

const H = { Authorization: `Bearer ${BOLNA_API_KEY}`, "Content-Type": "application/json" };
async function call(method, path, payload) {
  const r = await fetch(`https://api.bolna.ai${path}`, { method, headers: H, body: payload ? JSON.stringify(payload) : undefined });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

const res = await call(agentId ? "PUT" : "POST", agentId ? `/v2/agent/${agentId}` : "/v2/agent", body);
if (!res.ok) {
  console.error(`Bolna returned ${res.status}: ${JSON.stringify(res.data)}`);
  process.exit(1);
}
const id = agentId || res.data.agent_id || res.data.id;
console.log(agentId ? `Updated ${envName} ${id}; tools point at ${PUBLIC_URL}.` : `Created agent ${id}. Add to .env:\n${envName}=${id}`);

// ---------- post-call extractions ----------
const CATEGORY = "ChirpKey Outcomes";
const DISPOSITIONS = [
  {
    name: "Requests",
    question: "List every action the caller asked ChirpKey to do, in English, one short phrase each, separated by semicolons. Write 'none' if there were no requests.",
    is_subjective: true, is_objective: false,
  },
  {
    name: "Target system",
    question: "Which system handled the caller's main request?",
    is_subjective: false, is_objective: true,
    objective_options: [
      { value: "grok_bot", condition: "Billing, subscriptions, creating or running Grok bots, browser tasks" },
      { value: "claude_code", condition: "Coding task sent to Claude Code" },
      { value: "codex", condition: "Coding task sent to Codex" },
      { value: "gpu", condition: "GPU job" },
      { value: "none", condition: "No request was made" },
    ],
  },
  {
    name: "Outcome",
    question: "What happened to the caller's main request by the end of the call?",
    is_subjective: false, is_objective: true,
    objective_options: [
      { value: "done", condition: "The agent reported the task finished successfully" },
      { value: "running", condition: "Approved and still running when the call ended" },
      { value: "denied", condition: "The owner denied it on the phone" },
      { value: "failed", condition: "The task failed or approval never came" },
      { value: "no_request", condition: "No request was made" },
    ],
  },
  {
    name: "Language",
    question: "Which language did the caller mostly speak?",
    is_subjective: false, is_objective: true,
    objective_options: [
      { value: "english", condition: "Mostly English" },
      { value: "hinglish", condition: "Mix of Hindi and English" },
      { value: "hindi", condition: "Mostly Hindi" },
    ],
  },
];

const existing = await call("GET", `/agent/${id}/extraction-categories`);
const list = Array.isArray(existing.data) ? existing.data : existing.data?.categories || existing.data?.data || [];
let category = list.find((c) => c.name === CATEGORY);
if (!category) {
  const cat = await call("POST", `/agent/${id}/extraction-categories`, { name: CATEGORY, model: "gpt-4.1-mini" });
  if (!cat.ok) {
    console.warn(`Extractions: could not create category (${cat.status}): ${JSON.stringify(cat.data)}`);
    process.exit(0);
  }
  category = cat.data.category || cat.data;
}
const have = new Set((category.dispositions || []).map((d) => d.name));
let made = 0;
for (const d of DISPOSITIONS.filter((d) => !have.has(d.name))) {
  const r = await call("POST", "/dispositions/", { ...d, category_id: category.id, agent_id: id, model: "gpt-4.1-mini" });
  if (r.ok) made++;
  else console.warn(`Extractions: disposition "${d.name}" failed (${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
}
console.log(`Extractions: "${CATEGORY}" has ${have.size + made}/${DISPOSITIONS.length} questions.`);
