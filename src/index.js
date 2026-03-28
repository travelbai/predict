// Cloudflare Worker — Predict
//
// Routes:
//   GET /api/dashboard        → reads dashboard_state from KV
//   GET /api/debug/*?key=...  → debug routes (requires DEBUG_KEY env var)
//
// Scheduled triggers (via deploy workflow):
//   Daily:  "1 0 * * *", "21 0 * * *", "41 0 * * *"   — BTC/TAO macro + subnet d1 & w1
//   4H:     "0 1/4 * * *", "30 1/4 * * *"             — subnet h4 (odd hours)

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

    // DEBUG routes — gated behind DEBUG_KEY environment variable
    if (url.pathname.startsWith("/api/debug/")) {
      const key = url.searchParams.get("key");
      if (!env.DEBUG_KEY || key !== env.DEBUG_KEY) {
        return json({ error: "unauthorized" }, 403);
      }

      if (url.pathname === "/api/debug/run-daily") {
        ctx.waitUntil(handleScheduled("1 0 * * *", env));
        return json({ status: "cron_started", batch: 0 });
      }
      if (url.pathname === "/api/debug/run-daily-1") {
        ctx.waitUntil(handleScheduled("21 0 * * *", env));
        return json({ status: "cron_started", batch: 1 });
      }
      if (url.pathname === "/api/debug/run-daily-2") {
        ctx.waitUntil(handleScheduled("41 0 * * *", env));
        return json({ status: "cron_started", batch: 2 });
      }
      if (url.pathname === "/api/debug/run-4h") {
        ctx.waitUntil(handleScheduled("0 1/4 * * *", env));
        return json({ status: "started", cron: "0 1/4 * * *" });
      }
      if (url.pathname === "/api/debug/heartbeat") {
        try {
          const raw = await env.KV.get("cron_heartbeat");
          return json(raw ? JSON.parse(raw) : { error: "no heartbeat found" });
        } catch (err) {
          return json({ error: err.message });
        }
      }
      if (url.pathname === "/api/debug/subnets") {
        const { fetchEligibleSubnets } = await import("./lib/taostats.js");
        const subnets = await fetchEligibleSubnets(env);
        return json(subnets.slice(0, 10));
      }
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
