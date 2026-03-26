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
      ctx.waitUntil(handleScheduled("2 0 * * *", env));
      return json({ status: "started", cron: "2 0 * * *" });
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

async function handleDebugAccuracy(subnetId, env) {
  try {
    const raw = await env.KV.get("dashboard_state");
    const state = raw ? JSON.parse(raw) : MOCK_STATE;
    const prev = (state.subnets ?? []).find(s => s.id === subnetId);
    if (!prev) return json({ error: `subnet ${subnetId} not found in KV` });

    const tao4h = await fetchBinanceKlines("TAOUSDT", "4h", 180);
    const taoDaily = aggregateToDaily(tao4h);
    const taoReturns = logReturns(taoDaily.map(k => k.price));

    const h4Win = prev.h4?.windowDays ?? 30;
    const history = await fetchSubnetHistory(subnetId, h4Win + 5, env);
    const recentH4 = history.slice(-h4Win);
    const subnetTaoReturns = logReturns(recentH4.map(k => k.price));
    const taoSlice = taoReturns.slice(-subnetTaoReturns.length);
    const subnetUsdtReturns = subnetTaoReturns.map((r, i) =>
      r !== null && taoSlice[i] !== null ? r + taoSlice[i] : null
    );

    const lastIdx = subnetUsdtReturns.length - 1;
    const xA = taoSlice[lastIdx];
    const yA = subnetUsdtReturns[lastIdx];

    return json({
      subnetId,
      prevBeta0: prev.h4?.beta0,
      prevBeta1: prev.h4?.beta1,
      taoReturnsLen: taoReturns.length,
      subnetTaoReturnsLen: subnetTaoReturns.length,
      taoSliceLen: taoSlice.length,
      lastIdx,
      xA,
      yA,
      xA_isFinite: Number.isFinite(xA),
      yA_isFinite: Number.isFinite(yA),
      yA_absLt1e10: Math.abs(yA) < 1e-10,
      accuracy: (Number.isFinite(xA) && Number.isFinite(yA))
        ? computeAccuracy(prev.h4.beta0, prev.h4.beta1, xA, yA)
        : "skipped",
    });
  } catch (err) {
    return json({ error: err.message });
  }
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
