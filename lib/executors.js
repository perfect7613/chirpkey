// Where approved actions go. Unconfigured targets are simulated.
//
// grok_bot     -> a Grok Bot routine webhook (cloud: billing, creating/running bots, browser tasks)
// claude_code  -> runs `claude -p` on this laptop when CLAUDE_CODE_WORKDIR is set (see lib/local.js)
// codex        -> runs `codex exec` on this laptop when CODEX_WORKDIR is set
// gpu          -> your GPU job API or a small wrapper script
import { localWorkdir, runLocal } from "./local.js";
//
// Configure with <TARGET>_WEBHOOK_URL and optional <TARGET>_WEBHOOK_KEY (sent as a Bearer token).
// Add more targets with EXTRA_TARGETS=name1,name2 plus the matching env vars.

const BUILTIN = {
  grok_bot: "Grok Bot: subscriptions and billing, creating new bots, running existing bots, browser tasks",
  claude_code: "Claude Code on the owner's laptop: coding tasks in their project folder",
  codex: "Codex on the owner's laptop: coding tasks in their project folder",
  gpu: "GPU jobs: start, stop, status",
  laptop: "The owner's laptop: open a website or app, or play something on YouTube Music / YouTube / Spotify",
};

function targets() {
  const extra = (process.env.EXTRA_TARGETS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const all = { ...BUILTIN };
  for (const t of extra) all[t] ??= `Custom target ${t}`;
  return all;
}

const envFor = (id) => ({
  url: process.env[`${id.toUpperCase()}_WEBHOOK_URL`],
  key: process.env[`${id.toUpperCase()}_WEBHOOK_KEY`],
});

export function listTargets() {
  return Object.entries(targets()).map(([id, description]) => ({
    id, description, configured: Boolean(envFor(id).url || localWorkdir(id)),
  }));
}

export async function dispatch(action, { callbackUrl, callbackToken, ownerName, onResult }) {
  const { url, key } = envFor(action.target);
  if (!url && localWorkdir(action.target)) {
    const summary = runLocal(action, onResult);
    return { status: "dispatched", result: { summary } };
  }
  const body = {
    request_id: action.id,
    target: action.target,
    action: action.action,
    details: action.details,
    approved_by: ownerName || "owner",
    approved_via: action.approvedVia,
    approved_at: new Date().toISOString(),
    // The executor POSTs {status: "done"|"failed", summary} here with this Bearer token when finished.
    callback_url: callbackUrl,
    callback_token: callbackToken || null,
    instruction:
      `Approved request from ${ownerName || "the owner"}: ${action.action}. ${action.details}`.trim() +
      ` When finished, POST JSON {"status":"done","summary":"<one sentence>"} to ${callbackUrl}` +
      (callbackToken ? ` with header "Authorization: Bearer ${callbackToken}".` : "."),
  };

  if (!url) {
    return { status: "dispatched", result: { summary: `Simulated (no ${action.target.toUpperCase()}_WEBHOOK_URL set)` }, simulateDoneAfterMs: 4000 };
  }

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = (await r.text()).slice(0, 500);
  if (!r.ok) throw new Error(`${action.target} webhook returned ${r.status}: ${text}`);
  // A 200 from a Grok Bot routine means the run started, not that it finished.
  return { status: "dispatched", result: { summary: `Started on ${action.target}.` } };
}
