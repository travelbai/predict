// Cloudflare Worker — Predict
//
// Routes:
//   GET /api/state          → reads dashboard_state from KV
//   GET /api/dashboard      → alias (frontend compat)
//
// Scheduled:
//   "0 */4 * * *"           → unified cron (4h/d1/w1 all in one)

import { runCron } from "./cron/run.js";

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
    if (!raw) return json({ status: "empty", message: "No data yet. Waiting for first cron run." });
    return json(JSON.parse(raw));
  } catch (err) {
    console.error("[state] error:", err.message);
    return json({ status: "error", message: "Failed to load dashboard state" }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
