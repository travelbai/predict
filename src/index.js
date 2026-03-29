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
    //   ?reset=1  → restart from batch 0
    //   ?json=1   → return JSON instead of HTML
    //   (default) → auto-refresh HTML page, processes 5 subnets per visit
    if (url.pathname === "/api/init-history") {
      if (url.searchParams.get("reset") === "1") {
        await Promise.all([
          env.KV.delete("init_batch_index"),
          env.KV.delete("init_pool_cache"),
        ]);
        return json({ status: "reset", message: "Init state cleared. Visit /api/init-history to start." });
      }

      try {
        const result = await runInitHistory(env);
        // JSON mode for API clients
        if (url.searchParams.get("json") === "1") {
          return json(result);
        }
        // HTML auto-refresh page for browser
        return initHtml(result);
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

/** Auto-refresh HTML page for init-history progress. */
function initHtml(result) {
  const { done, batch, totalBatches, subnetsProcessed, totalSubnets, initialized, skipped, errors } = result;
  const pct = done ? 100 : Math.round((subnetsProcessed / totalSubnets) * 100);
  const refresh = done ? "" : '<meta http-equiv="refresh" content="65">';
  const status = done
    ? `<h2 style="color:#00B07C">Init complete</h2><p>All ${totalSubnets} subnets initialized.</p><p>Now visit <a href="/api/run-daily">/api/run-daily</a> to trigger the first regression.</p>`
    : `<h2>Initializing... batch ${batch}/${totalBatches}</h2>
       <p>${subnetsProcessed}/${totalSubnets} subnets (${pct}%)</p>
       <p>This batch: ${initialized} ok, ${skipped} skipped, ${errors} errors</p>
       <p style="color:#888">Auto-refreshing in 65s (Taostats rate limit: 5 req/min)</p>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${refresh}
<title>Init History</title>
<style>body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}
.bar{background:#333;border-radius:4px;height:24px;margin:1rem 0}
.fill{background:#00B07C;height:100%;border-radius:4px;transition:width .3s}
a{color:#00B07C}</style></head>
<body><h1>Predict — Cold Start</h1>${status}
<div class="bar"><div class="fill" style="width:${pct}%"></div></div>
</body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
