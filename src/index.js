// Cloudflare Worker — Predict
//
// Routes:
//   GET /api/dashboard  → reads dashboard_state from KV
//   GET /api/run-daily  → manually trigger Daily Cron (debug only — remove when done)
//   GET /api/run-4h     → manually trigger 4H Cron   (debug only — remove when done)
//
// Scheduled triggers (wrangler.toml):
//   Cron 1: "0 0 * * *"     daily 00:00 UTC — BTC/TAO macro + subnet 24H & 1W regression
//   Cron 2: "0 */4 * * *"   every 4 hours  — subnet 4H regression

import { handleScheduled } from "./cron/scheduler.js";
import { MOCK_STATE } from "./mock/dashboardState.js";
import { fetchBinanceKlines } from "./lib/binance.js";
import { fetchSubnetHistory, historyDays } from "./lib/taostats.js";
import { logReturns, aggregateToDaily, computeAccuracy } from "./lib/math.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  // ── HTTP handler ─────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/dashboard") {
      return handleDashboard(env);
    }

    // DEBUG routes — remove after testing
    if (url.pathname === "/api/run-daily") {
      ctx.waitUntil(handleScheduled("0 2 * * *", env));
      const debug = await handleAccuracyProbe("d1", env);
      return json({ status: "cron_started", accuracyProbe: debug });
    }
    if (url.pathname === "/api/run-4h") {
      ctx.waitUntil(handleScheduled("0 */4 * * *", env));
      return json({ status: "started", cron: "0 */4 * * *" });
    }

    // DEBUG: check heartbeat KV entry — remove after testing
    if (url.pathname === "/api/check-heartbeat") {
      try {
        const raw = await env.KV.get("cron_heartbeat");
        return json(raw ? JSON.parse(raw) : { error: "no heartbeat found" });
      } catch (err) {
        return json({ error: err.message });
      }
    }

    // DEBUG: sync accuracy probe for one subnet — remove after testing
    if (url.pathname.startsWith("/api/debug-accuracy/")) {
      const subnetId = parseInt(url.pathname.split("/").pop(), 10);
      return handleDebugAccuracy(subnetId, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  // ── Cron handler ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event.cron, env));
  },
};

// Synchronous accuracy probe — computes cross-run accuracy step by step for
// the first subnet that has previous betas stored. Returns raw diagnostics so
// the full calculation is visible in the browser.
async function handleAccuracyProbe(period, env) {
  try {
    const raw = await env.KV.get("dashboard_state");
    const state = raw ? JSON.parse(raw) : MOCK_STATE;

    // Find first subnet that has previous betas for the requested period
    const prev = (state.subnets ?? []).find(s => s[period]?.beta0 != null);
    if (!prev) return { error: `no subnet with previous ${period} betas in KV` };

    // Fetch TAO price data
    const taoDaily = await fetchBinanceKlines("TAOUSDT", "1d", 185);
    const taoDailyReturns = logReturns(taoDaily.map(d => d.price));

    // Fetch subnet history
    const win = prev[period].windowDays ?? 90;
    const history = await fetchSubnetHistory(prev.id, win + 5, env);
    const recent = history.slice(-win);
    const subnetTaoReturns = logReturns(recent.map(k => k.price));
    const taoSlice = taoDailyReturns.slice(-subnetTaoReturns.length);
    const subnetUsdtReturns = subnetTaoReturns.map((r, i) =>
      r !== null && taoSlice[i] !== null ? r + taoSlice[i] : null
    );

    // Search from end for last valid (finite, non-zero) data point
    let xActual = null, yActual = null, foundIdx = -1;
    for (let j = subnetUsdtReturns.length - 1; j >= 0; j--) {
      const x = taoSlice[j];
      const y = subnetUsdtReturns[j];
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(y) >= 1e-10) {
        xActual = x; yActual = y; foundIdx = j;
        break;
      }
    }

    if (xActual === null) {
      return {
        subnetId: prev.id, symbol: prev.symbol, period,
        error: "no valid data point found",
        seriesLen: subnetUsdtReturns.length,
        nullOrNaNCount: subnetUsdtReturns.filter(v => !Number.isFinite(v)).length,
      };
    }

    const beta0Old = prev[period].beta0;
    const beta1Old = prev[period].beta1;
    const yPredicted = beta0Old + beta1Old * xActual;
    const mape = Math.abs(yPredicted - yActual) / Math.abs(yActual);
    const accuracy = Math.max(0, Math.min(1, 1 - mape));

    return {
      subnetId: prev.id, symbol: prev.symbol, period,
      beta0Old, beta1Old,
      xActual, yActual, yPredicted,
      mape, accuracy,
      foundIdx, seriesLen: subnetUsdtReturns.length,
      note: "cross-run: prev betas vs latest actual data point",
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleDebugAccuracy(subnetId, env) {
  return json(await handleAccuracyProbe("h4", env));
}

async function handleDashboard(env) {
  try {
    const raw = await env.KV.get("dashboard_state");
    const state = raw ? JSON.parse(raw) : MOCK_STATE;
    return json(state);
  } catch (err) {
    return json({ status: "error", message: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
