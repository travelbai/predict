// One-time KV seeder — runs the full regression pipeline locally
// and writes the result directly to Cloudflare KV via REST API.
//
// Usage:
//   node scripts/seed.js <CF_API_TOKEN> <CF_ACCOUNT_ID> <TAOSTATS_API_KEY> [KV_NAMESPACE_ID]
//
// If KV_NAMESPACE_ID is omitted it reads it from wrangler.toml automatically.

import { readFileSync } from "fs";
import { resolve } from "path";

const [,, CF_TOKEN, ACCOUNT_ID, TAOSTATS_KEY, kvIdArg] = process.argv;

if (!CF_TOKEN || !ACCOUNT_ID || !TAOSTATS_KEY) {
  console.error("Usage: node scripts/seed.js <CF_API_TOKEN> <CF_ACCOUNT_ID> <TAOSTATS_API_KEY>");
  process.exit(1);
}

// Read KV namespace ID from wrangler.toml if not provided
let KV_NAMESPACE_ID = kvIdArg;
if (!KV_NAMESPACE_ID) {
  const toml = readFileSync(resolve("wrangler.toml"), "utf8");
  const m = toml.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/);
  KV_NAMESPACE_ID = m?.[1];
  if (!KV_NAMESPACE_ID) { console.error("Could not read KV id from wrangler.toml"); process.exit(1); }
}

console.log(`KV namespace: ${KV_NAMESPACE_ID}`);

// Minimal env shim for the Worker modules
const env = { TAOSTATS_API_KEY: TAOSTATS_KEY };

// ── Import Worker modules ─────────────────────────────────────────────────────
const { fetchBinanceKlines } = await import("../src/lib/binance.js");
const { fetchEligibleSubnets, fetchSubnetHistory, historyDays, MIN_HISTORY_DAYS } = await import("../src/lib/taostats.js");
const { logReturns, alignByTimestamp, linearRegressionPipeline, aggregateToWeekly, percentileRange } = await import("../src/lib/math.js");

// ── Run daily pipeline ────────────────────────────────────────────────────────

console.log("\n[seed] fetching BTC/TAO weekly klines from Binance…");
const [btcWeekly, taoWeekly, taoDaily] = await Promise.all([
  fetchBinanceKlines("BTCUSDT", "1w", 52),
  fetchBinanceKlines("TAOUSDT", "1w", 52),
  fetchBinanceKlines("TAOUSDT", "1d", 180),
]);

const { x: btcPrices, y: taoPrices } = alignByTimestamp(btcWeekly, taoWeekly);
const btcReturns = logReturns(btcPrices);
const taoWeeklyReturns = logReturns(taoPrices);
const taoDailyReturns = logReturns(taoDaily.map(d => d.price));

const btcTaoResult = linearRegressionPipeline(btcReturns, taoWeeklyReturns);
if (!btcTaoResult) { console.error("BTC→TAO regression failed"); process.exit(1); }

const taoUsdPrice = taoDaily[taoDaily.length - 1]?.price ?? 0;
console.log(`[seed] BTC→TAO β₁=${btcTaoResult.beta1.toFixed(3)} R²=${btcTaoResult.r2.toFixed(3)}  TAO/USD=$${taoUsdPrice.toFixed(2)}`);

// ── Subnets ───────────────────────────────────────────────────────────────────

console.log("\n[seed] fetching eligible subnets…");
const subnets = await fetchEligibleSubnets(env);
console.log(`[seed] ${subnets.length} subnets fetched`);

const allAlphas = { h4: [], d1: [], w1: [] };
const subnetResults = [];

for (const subnet of subnets) {
  try {
    process.stdout.write(`  SN${String(subnet.id).padEnd(4)} ${subnet.symbol.padEnd(12)}`);

    const history = await fetchSubnetHistory(subnet.id, 180, env);
    const days = historyDays(history);

    if (days < MIN_HISTORY_DAYS) {
      process.stdout.write(`skipped (${days} days)\n`);
      continue;
    }

    const tvlUsd = Math.round(subnet.tvlTao * taoUsdPrice);

    // h4 (30d window)
    const recent30 = history.slice(-35);
    const r30 = logReturns(recent30.map(k => k.price));
    const t30 = taoDailyReturns.slice(-r30.length);
    const u30 = r30.map((r, i) => (r !== null && t30[i] !== null ? r + t30[i] : null));
    const h4 = linearRegressionPipeline(t30, u30);

    // d1 (90d window)
    const recent90 = history.slice(-90);
    const r90 = logReturns(recent90.map(k => k.price));
    const t90 = taoDailyReturns.slice(-r90.length);
    const u90 = r90.map((r, i) => (r !== null && t90[i] !== null ? r + t90[i] : null));
    const d1 = linearRegressionPipeline(t90, u90);

    // w1 (weekly aggregated)
    const weekly = aggregateToWeekly(history);
    const rw = logReturns(weekly.map(k => k.price));
    const tw = taoWeeklyReturns.slice(-rw.length);
    const uw = rw.map((r, i) => (r !== null && tw[i] !== null ? r + tw[i] : null));
    const w1 = linearRegressionPipeline(tw, uw);

    if (h4) allAlphas.h4.push(h4.beta0);
    if (d1) allAlphas.d1.push(d1.beta0);
    if (w1) allAlphas.w1.push(w1.beta0);

    const nullPeriod = { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: 0 };

    subnetResults.push({
      id: subnet.id,
      symbol: subnet.symbol,
      name: subnet.name,
      tvl: tvlUsd,
      regDays: days,
      h4: h4 ? { beta0: h4.beta0, beta1: h4.beta1, r2: h4.r2, accuracy: null, mapeHistory: [], windowDays: 30 } : nullPeriod,
      d1: d1 ? { beta0: d1.beta0, beta1: d1.beta1, r2: d1.r2, accuracy: null, mapeHistory: [], windowDays: 90 } : nullPeriod,
      w1: w1 ? { beta0: w1.beta0, beta1: w1.beta1, r2: w1.r2, accuracy: null, mapeHistory: [], windowDays: 180 } : nullPeriod,
    });

    process.stdout.write(
      `h4 R²=${h4?.r2?.toFixed(2) ?? "--"}  d1 R²=${d1?.r2?.toFixed(2) ?? "--"}  w1 R²=${w1?.r2?.toFixed(2) ?? "--"}  TVL $${(tvlUsd/1000).toFixed(0)}k\n`
    );
  } catch (err) {
    process.stdout.write(`ERROR: ${err.message}\n`);
  }
}

// ── Build dashboard_state ─────────────────────────────────────────────────────

const state = {
  version: 1,
  updatedAt: new Date().toISOString(),
  status: "ok",
  staleReason: null,
  btcTao: {
    beta0: btcTaoResult.beta0,
    beta1: btcTaoResult.beta1,
    r2: btcTaoResult.r2,
    accuracy: null,
    mapeHistory: [],
    windowDays: 360,
    window: "360d / 52w",
    sampleCount: btcTaoResult.sampleCount,
    calculatedAt: new Date().toISOString(),
  },
  alphaRangeBtcTao: percentileRange(taoWeeklyReturns.filter(r => r !== null), 5, 95),
  alphaRanges: {
    h4: allAlphas.h4.length > 0 ? percentileRange(allAlphas.h4, 5, 95) : [-1.5, 2.0],
    d1: allAlphas.d1.length > 0 ? percentileRange(allAlphas.d1, 5, 95) : [-0.8, 1.2],
    w1: allAlphas.w1.length > 0 ? percentileRange(allAlphas.w1, 5, 95) : [-0.4, 0.6],
  },
  subnets: subnetResults,
};

console.log(`\n[seed] ${subnetResults.length} subnets computed`);
console.log(`[seed] BTC→TAO β₀=${state.btcTao.beta0.toFixed(4)} β₁=${state.btcTao.beta1.toFixed(4)} R²=${state.btcTao.r2.toFixed(4)}`);

// ── Write to KV via Cloudflare REST API ───────────────────────────────────────

const payload = JSON.stringify(state);
console.log(`\n[seed] writing ${(payload.length / 1024).toFixed(1)} KB to KV…`);

const kvRes = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/dashboard_state`,
  {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: payload,
  }
);

const kvData = await kvRes.json();
if (kvData.success) {
  console.log("✅ KV updated successfully");
  console.log(`\nLive dashboard: https://predict-6hg.pages.dev`);
} else {
  console.error("❌ KV write failed:", JSON.stringify(kvData.errors));
  process.exit(1);
}
