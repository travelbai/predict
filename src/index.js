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
      ctx.waitUntil(handleScheduled("0 0 * * *", env));
      return json({ status: "started", cron: "0 0 * * *", message: "Daily cron running in background — check /api/dashboard in ~60s" });
    }
    if (url.pathname === "/api/run-4h") {
      ctx.waitUntil(handleScheduled("0 */4 * * *", env));
      return json({ status: "started", cron: "0 */4 * * *", message: "4H cron running in background — check /api/dashboard in ~30s" });
    }

    return new Response("Not Found", { status: 404 });
  },

  // ── Cron handler ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event.cron, env));
  },
};

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
