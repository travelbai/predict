/**
 * Cloudflare Worker — Predict
 *
 * Routes:
 *   GET /api/dashboard  → reads dashboard_state from KV
 *
 * Scheduled triggers (wrangler.toml):
 *   Cron 1: "0 0 * * *"   — daily 00:00 UTC  → BTC/TAO macro + subnet 24H & 1W regression
 *   Cron 2: "0 */4 * * *" — every 4 hours    → subnet 4H regression
 */

import { handleScheduled } from "./cron/scheduler.js";
import { MOCK_STATE } from "./mock/dashboardState.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  // ── HTTP handler ─────────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/dashboard") {
      return handleDashboard(env);
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
