// Cron 2 — Every 4 hours (6x/day)
//
// h4 regression: TAO → Subnet using 30-day window.
// TAO data source : Binance TAO/USDT 4H (180 bars = 30 days × 6 bars/day)
//                   aggregated to daily (last 4H close per UTC day)
// Subnet data     : Taostats daily history (last 35 days, sliced to match TAO)
//
// Both series aligned to daily frequency before regression so frequencies match.

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetHistory, historyDays, MIN_HISTORY_DAYS } from "../lib/taostats.js";
import {
  logReturns,
  aggregateToDaily,
  linearRegressionPipeline,
  percentileRange,
  computeAccuracy,
  zeroVolumeRatio,
  adaptiveWindow,
} from "../lib/math.js";

const H4_BARS = 180; // 180 4H bars = 30 days of TAO data

// Adaptive window bounds (days)
const H4_MIN = 15, H4_MAX = 60, H4_DEFAULT = 30;

export async function runFourHourCron(state, env) {
  console.log("[4h] === starting 4H regression run ===");

  // ── Fetch TAO/USDT 4H from Binance ───────────────────────────────────────
  console.log("[4h] fetching TAO/USDT 4H klines (180 bars)");
  const tao4h = await fetchBinanceKlines("TAOUSDT", "4h", H4_BARS);

  // Aggregate 4H → daily (last 4H close per UTC day)
  const taoDaily = aggregateToDaily(tao4h);
  const taoReturns = logReturns(taoDaily.map(k => k.price));

  // Latest TAO/USD price for TVL calculation
  const taoUsdPrice = tao4h[tao4h.length - 1]?.price ?? 0;

  // ── Subnets ───────────────────────────────────────────────────────────────
  const subnets = await fetchEligibleSubnets(env);
  console.log(`[4h] ${subnets.length} subnets`);

  const subnetMap = Object.fromEntries((state.subnets ?? []).map(s => [s.id, s]));
  const allAlphas = [];

  // Process subnets in parallel batches to avoid Taostats rate-limiting
  const BATCH = 10;
  const results = [];
  for (let i = 0; i < subnets.length; i += BATCH) {
    const batch = subnets.slice(i, i + BATCH);
    results.push(...await Promise.allSettled(batch.map(async subnet => {
    const prev = subnetMap[subnet.id];

    const h4Win = adaptiveWindow(prev?.h4?.mapeHistory, prev?.h4?.windowDays ?? H4_DEFAULT, H4_MIN, H4_MAX);
    const fetchDays = h4Win + 5;

    const history = await fetchSubnetHistory(subnet.id, fetchDays, env);

    if (historyDays(history) < MIN_HISTORY_DAYS) return null;

    const zvr = zeroVolumeRatio(history);
    if (zvr > 0.15) {
      console.log(`[4h] SN${subnet.id} skipped: ${(zvr * 100).toFixed(0)}% zero-volume candles`);
      return null;
    }

    const recentH4 = history.slice(-h4Win);
    const subnetTaoReturns = logReturns(recentH4.map(k => k.price));
    const taoSlice = taoReturns.slice(-subnetTaoReturns.length);
    const subnetUsdtReturns = subnetTaoReturns.map((r, i) =>
      r !== null && taoSlice[i] !== null ? r + taoSlice[i] : null
    );

    const h4 = linearRegressionPipeline(taoSlice, subnetUsdtReturns);

    // Cross-run single-point accuracy: old β predicts latest actual data point
    let h4Acc = null;
    let h4Mape = prev?.h4?.mapeHistory ?? [];
    if (prev?.h4?.beta0 != null) {
      // Find the last index where both series have a finite value
      const lastIdx = subnetUsdtReturns.length - 1;
      const xA = taoSlice[lastIdx];
      const yA = subnetUsdtReturns[lastIdx];
      if (Number.isFinite(xA) && Number.isFinite(yA)) {
        h4Acc = computeAccuracy(prev.h4.beta0, prev.h4.beta1, xA, yA);
        if (h4Acc !== null) h4Mape = [...h4Mape.slice(-4), 1 - h4Acc];
      }
    }

    const h4State = h4
      ? { beta0: h4.beta0, beta1: h4.beta1, r2: h4.r2, accuracy: h4Acc, mapeHistory: h4Mape, windowDays: h4Win }
      : (prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: H4_DEFAULT });

    const tvlUsd = Math.round(subnet.tvlTao * taoUsdPrice);
    console.log(`[4h] SN${subnet.id} ${subnet.symbol} win=${h4Win}d R²=${h4?.r2?.toFixed(2) ?? "n/a"}`);

    return prev
      ? { ...prev, tvl: tvlUsd, h4: h4State }
      : { id: subnet.id, symbol: subnet.symbol, name: subnet.name, tvl: tvlUsd, regDays: historyDays(history), h4: h4State, d1: null, w1: null };
  })));
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      console.error(`[4h] SN${subnets[i].id} failed: ${r.reason?.message}`);
    } else if (r.value !== null) {
      subnetMap[r.value.id] = r.value;
      if (r.value.h4?.beta0 != null) allAlphas.push(r.value.h4.beta0);
    }
  }

  if (allAlphas.length > 0) {
    state.alphaRanges = state.alphaRanges ?? {};
    state.alphaRanges.h4 = percentileRange(allAlphas, 5, 95);
  }

  state.subnets = Object.values(subnetMap);
  console.log(`[4h] done — ${state.subnets.length} subnets`);
}
