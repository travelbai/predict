// Cloudflare Worker — Predict
//
// Routes:
//   GET /api/state          → reads dashboard_state from KV
//   GET /api/dashboard      → alias (frontend compat)
//   GET /api/run-daily      → manually trigger full cron
//   GET /api/init-history   → cold-start batch initializer
//
// Scheduled:
//   "0 */4 * * *"           → unified cron (4h/d1/w1 all in one)

import { runCron } from "./cron/run.js";
import { runInitHistory } from "./cron/init.js";
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

    // Frontend data endpoint
    if (url.pathname === "/api/state" || url.pathname === "/api/dashboard") {
      return handleState(env);
    }

    // Manual cron trigger (debug)
    if (url.pathname === "/api/run-daily") {
      ctx.waitUntil(runCron(env));
      return json({ status: "cron_started", message: "Full cron triggered in background." });
    }

    // Cold-start history initializer
    if (url.pathname === "/api/init-history") {
      try {
        const result = await runInitHistory(env);
        return json(result);
      } catch (err) {
        return json({ status: "error", message: err.message }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  // ── Cron handler ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleState(env) {
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
