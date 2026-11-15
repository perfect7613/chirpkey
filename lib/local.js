// Runs Claude Code and Codex headless on this laptop (the ChirpKey server runs here too).
//
// CLAUDE_CODE_WORKDIR   folder Claude Code works in (required to enable the local runner)
// CLAUDE_CODE_PERMISSION_MODE  acceptEdits (default) | auto | bypassPermissions
// CLAUDE_CODE_MAX_BUDGET_USD   optional spend cap per task
// CODEX_WORKDIR         folder Codex works in (required to enable the local runner)
// CODEX_SANDBOX         workspace-write (default) | read-only | danger-full-access
// LOCAL_TASK_TIMEOUT_MIN       default 20
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const env = process.env;

export function localWorkdir(target) {
  if (target === "claude_code") return env.CLAUDE_CODE_WORKDIR || null;
  if (target === "codex") return env.CODEX_WORKDIR || null;
  if (target === "laptop") return env.LAPTOP_ACTIONS === "off" ? null : process.env.HOME;
  return null;
}

// ---------- laptop: open a website or app with macOS `open` (no shell, no AI) ----------
const SITES = {
  "youtube music": "https://music.youtube.com", youtube: "https://www.youtube.com", spotify: "https://open.spotify.com",
  gmail: "https://mail.google.com", "google calendar": "https://calendar.google.com", github: "https://github.com",
  twitter: "https://x.com", x: "https://x.com", linkedin: "https://www.linkedin.com", instagram: "https://www.instagram.com",
  netflix: "https://www.netflix.com", "chat gpt": "https://chatgpt.com", chatgpt: "https://chatgpt.com", claude: "https://claude.ai",
  grok: "https://grok.com", bolna: "https://platform.bolna.ai", whatsapp: "https://web.whatsapp.com", maps: "https://maps.google.com",
};
export function resolveOpen(text) {
  const t = String(text || "");
  const url = t.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (url) return { url };
  const low = t.toLowerCase();
  const play = low.match(/play (.+?) on (youtube music|youtube|spotify)/);
  if (play) {
    const q = encodeURIComponent(play[1].trim());
    const base = { "youtube music": "https://music.youtube.com/search?q=", youtube: "https://www.youtube.com/results?search_query=", spotify: "https://open.spotify.com/search/" }[play[2]];
    return { url: base + q };
  }
  const site = Object.keys(SITES).sort((a, b) => b.length - a.length).find((k) => new RegExp(`\\b${k}\\b`).test(low));
  if (site) return { url: SITES[site] };
  const domain = low.match(/\b([a-z0-9-]+\.)+(com|in|ai|io|org|net|dev|app|co)\b/)?.[0];
  if (domain) return { url: `https://${domain}` };
  const app = t.match(/(?:open|launch|start)\s+(?:the\s+)?([A-Za-z0-9 .]{2,40}?)(?:\s+app)?(?:[.,]|$)/i)?.[1];
  if (app) return { app: app.trim() };
  return null;
}

function runLaptop(a, onResult) {
  const target = resolveOpen(`${a.action} ${a.details}`);
  if (!target) {
    setTimeout(() => onResult({ status: "failed", summary: "I couldn't tell which website or app to open." }), 0);
    return "Working out what to open.";
  }
  const args = target.url ? [target.url] : ["-a", target.app];
  const child = spawn("open", args, { stdio: "ignore" });
  child.on("error", (e) => onResult({ status: "failed", summary: `Couldn't open it: ${e.message}` }));
  child.on("close", (code) => onResult(code === 0
    ? { status: "done", summary: `Opened ${target.url ? target.url.replace(/^https?:\/\//, "").split("/")[0] : target.app} on the laptop.` }
    : { status: "failed", summary: `The laptop couldn't open ${target.url || target.app}.` }));
  console.log(`[local] open ${args.join(" ")}`);
  return `Opening on the laptop.`;
}

const taskPrompt = (a) =>
  `${a.action}\n\n${a.details || ""}\n\n` +
  "This task was requested by voice and approved by the owner. Do it, then end with one short sentence " +
  "summarising what you did; that sentence will be read aloud.";

// Keep the spoken summary short: last non-empty paragraph, capped.
function voiceSummary(text) {
  const parts = String(text || "").trim().split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const last = (parts.at(-1) || "").replace(/[`*#_>]/g, "").replace(/\s+/g, " ");
  return last.length > 280 ? `${last.slice(0, 277)}…` : last || "Finished with no output.";
}

function run(cmd, args, cwd, onExit) {
  const timeoutMs = Number(env.LOCAL_TASK_TIMEOUT_MIN || 20) * 60 * 1000;
  const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6); });
  child.stderr.on("data", (d) => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.on("error", (e) => { clearTimeout(timer); onExit(-1, out, e.message); });
  child.on("close", (code) => { clearTimeout(timer); onExit(code, out, err); });
  console.log(`[local] ${cmd} started in ${cwd} (pid ${child.pid})`);
}

// Starts the task and returns immediately; onResult({status, summary}) fires when it finishes.
export function runLocal(a, onResult) {
  if (a.target === "laptop") return runLaptop(a, onResult);
  const cwd = localWorkdir(a.target);
  if (a.target === "claude_code") {
    const args = ["-p", taskPrompt(a), "--output-format", "json", "--permission-mode", env.CLAUDE_CODE_PERMISSION_MODE || "acceptEdits"];
    if (env.CLAUDE_CODE_MAX_BUDGET_USD) args.push("--max-budget-usd", env.CLAUDE_CODE_MAX_BUDGET_USD);
    run("claude", args, cwd, (code, out, err) => {
      let result = null;
      try { result = JSON.parse(out); } catch {}
      const ok = code === 0 && result && !result.is_error;
      onResult({
        status: ok ? "done" : "failed",
        summary: ok ? voiceSummary(result.result) : `Claude Code failed: ${voiceSummary(result?.result || err || out)}`,
      });
    });
    return `Claude Code started in ${path.basename(cwd)}.`;
  }
  if (a.target === "codex") {
    const dir = mkdtempSync(path.join(tmpdir(), "chirpkey-codex-"));
    const lastMsg = path.join(dir, "last.txt");
    const args = ["exec", "--sandbox", env.CODEX_SANDBOX || "workspace-write", "--skip-git-repo-check", "-C", cwd, "-o", lastMsg, taskPrompt(a)];
    run("codex", args, cwd, (code, out, err) => {
      let last = "";
      try { last = readFileSync(lastMsg, "utf8"); } catch {}
      rmSync(dir, { recursive: true, force: true });
      // Codex prints its banner and warnings on stderr; surface the real error line.
      const errLine = (err.match(/ERROR: .*$/m)?.[0] || "").replace(/^ERROR: /, "");
      let reason = errLine;
      try { reason = JSON.parse(errLine).error?.message || errLine; } catch {}
      onResult({
        status: code === 0 ? "done" : "failed",
        summary: code === 0 ? voiceSummary(last || out) : `Codex failed: ${voiceSummary(reason || err.split("\n").filter(Boolean).at(-1) || out)}`,
      });
    });
    return `Codex started in ${path.basename(cwd)}.`;
  }
  throw new Error(`No local runner for ${a.target}`);
}
