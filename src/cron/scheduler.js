/**
 * Cron scheduler — dispatches to the correct handler based on cron expression.
 *
 * "0 0 * * *"   → dailyCron  (Cron 1: BTC/TAO macro + subnet 24H & 1W)
 * "0 */4 * * *" → hourlyCron (Cron 2: subnet 4H)
 *
 * Full implementation is a P0 task; stubs are here so the Worker deploys cleanly.
 */

export async function handleScheduled(cron, env) {
  console.log(`[scheduler] cron triggered: ${cron}`);

  if (cron === "0 0 * * *") {
    await dailyCron(env);
  } else if (cron === "0 */4 * * *") {
    await hourlyCron(env);
  } else {
    console.warn(`[scheduler] unknown cron: ${cron}`);
  }
}

// ── Cron 1: Daily 00:00 UTC ───────────────────────────────────────────────────
async function dailyCron(env) {
  console.log("[cron1] starting daily regression run");

  let state = await loadState(env);

  try {
    // TODO (P0): implement full pipeline
    // 1. Fetch BTC/USDT 1W (52 bars) + TAO/USDT 1W (52 bars) + TAO/USDT 1D (180 bars) from Binance
    // 2. Align by close-timestamp, compute log returns, IQR filter, OLS regression → btcTao
    // 3. Fetch each subnet 1D (180 bars) from Taostats; compute 24H + 1W regressions
    // 4. Write merged state to KV
    console.log("[cron1] stub — full implementation pending");

    state.status = "ok";
    state.staleReason = null;
    state.updatedAt = new Date().toISOString();
  } catch (err) {
    console.error("[cron1] failed:", err.message);
    state.status = "stale";
    state.staleReason = err.message;
  }

  await saveState(env, state);
}

// ── Cron 2: Every 4 hours ─────────────────────────────────────────────────────
async function hourlyCron(env) {
  console.log("[cron2] starting 4H regression run");

  let state = await loadState(env);

  try {
    // TODO (P0): implement full pipeline
    // 1. Fetch TAO/USDT 4H (180 bars) from Binance
    // 2. Fetch each subnet 4H bars from Taostats
    // 3. Compute 4H regressions; update h4 fields in state.subnets
    // 4. Write merged state to KV
    console.log("[cron2] stub — full implementation pending");

    state.status = "ok";
    state.staleReason = null;
    state.updatedAt = new Date().toISOString();
  } catch (err) {
    console.error("[cron2] failed:", err.message);
    state.status = "stale";
    state.staleReason = err.message;
  }

  await saveState(env, state);
}

// ── KV helpers ────────────────────────────────────────────────────────────────
async function loadState(env) {
  const raw = await env.KV.get("dashboard_state");
  if (!raw) {
    const { MOCK_STATE } = await import("../mock/dashboardState.js");
    return structuredClone(MOCK_STATE);
  }
  return JSON.parse(raw);
}

async function saveState(env, state) {
  await env.KV.put("dashboard_state", JSON.stringify(state));
  console.log("[scheduler] state saved to KV");
}
