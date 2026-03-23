/**
 * Cron dispatcher.
 *
 * "0 0 * * *"   → Cron 1: BTC/TAO macro + subnet 24H & 1W regression
 * "0 */4 * * *" → Cron 2: subnet 4H regression
 */

import { runDailyCron } from "./daily.js";
import { runFourHourCron } from "./fourHour.js";
import { MOCK_STATE } from "../mock/dashboardState.js";

export async function handleScheduled(cron, env) {
  console.log(`[scheduler] triggered: ${cron}`);

  let state = await loadState(env);

  try {
    if (cron === "0 0 * * *") {
      await runDailyCron(state, env);
    } else if (cron === "0 */4 * * *") {
      await runFourHourCron(state, env);
    } else {
      console.warn(`[scheduler] unknown cron expression: ${cron}`);
      return;
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
