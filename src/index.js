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
    //   ?reset=1   → restart from batch 0
    //   ?status=1  → check background progress
    //   (default)  → start next batch in background
    if (url.pathname === "/api/init-history") {
      if (url.searchParams.get("reset") === "1") {
        await env.KV.delete("init_batch_index");
        await env.KV.delete("init_progress");
        return json({ status: "reset", message: "Init state cleared. Visit again to start batch 1." });
      }
      if (url.searchParams.get("status") === "1") {
        const progress = await env.KV.get("init_progress");
        return json(progress ? JSON.parse(progress) : { status: "no_progress" });
      }
      // Fire-and-forget: run in background (~5 min per batch due to rate limit)
      const batchIndex = parseInt(await env.KV.get("init_batch_index") ?? "0", 10);
      ctx.waitUntil(runInitHistory(env));
      return json({
        status: "init_started",
        batch: batchIndex + 1,
        message: `Batch ${batchIndex + 1} started in background. ~5 min to complete (Taostats rate limit: 5 req/min). Check progress: /api/init-history?status=1`,
      });
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
