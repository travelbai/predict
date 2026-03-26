// Cron dispatcher.
// "0 0 * * *"   → Cron 1: BTC/TAO macro + subnet 24H & 1W regression
// "0 */4 * * *" → Cron 2: subnet 4H regression

import { runDailyCron } from "./daily.js";
import { runFourHourCron } from "./fourHour.js";
import { MOCK_STATE } from "../mock/dashboardState.js";

// Maps each cron expression to its job type and batch index.
// Batch 0 = top 44 by TVL, batch 1 = next 44, batch 2 = remainder.
const CRON_MAP = {
  "0 2 * * *":    { type: "daily", batch: 0 },
  "20 2 * * *":   { type: "daily", batch: 1 },
  "40 2 * * *":   { type: "daily", batch: 2 },
  "0 */4 * * *":  { type: "4h",    batch: 0 },
  "20 */4 * * *": { type: "4h",    batch: 1 },
  "40 */4 * * *": { type: "4h",    batch: 2 },
};

export async function handleScheduled(cron, env) {
  const job = CRON_MAP[cron];
  if (!job) {
    console.warn(`[scheduler] unknown cron expression: ${cron}`);
    return;
  }
  console.log(`[scheduler] triggered: ${cron} → ${job.type} batch ${job.batch}`);

  // Diagnostic heartbeat
  try {
    await env.KV.put("cron_heartbeat", JSON.stringify({ cron, type: job.type, batch: job.batch, startedAt: new Date().toISOString() }));
  } catch (e) {
    console.error(`[scheduler] heartbeat KV write failed: ${e.message}`);
  }

  let state = await loadState(env);

  try {
    if (job.type === "daily") {
      await runDailyCron(state, env, job.batch);
    } else {
      await runFourHourCron(state, env, job.batch);
    }

    state.status = "ok";
    state.staleReason = null;
    state.updatedAt = new Date().toISOString();
    state.version = 1;
  } catch (err) {
    console.error(`[scheduler] run failed — preserving stale snapshot: ${err.message}`);
    state.status = "stale";
    state.staleReason = err.message;
    // Do NOT update state.updatedAt — keep the timestamp of the last good run
  }

  await saveState(env, state);
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function loadState(env) {
  try {
    const raw = await env.KV.get("dashboard_state");
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.warn(`[scheduler] failed to load existing state: ${err.message}`);
  }
  return structuredClone(MOCK_STATE);
}

async function saveState(env, state) {
  await env.KV.put("dashboard_state", JSON.stringify(state));
  console.log("[scheduler] state saved to KV");
}
