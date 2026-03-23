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
} from "../lib/math.js";

// 180 4H bars = 30 days; fetch a few extra for IQR headroom
const H4_BARS = 180;
const SUBNET_DAILY_LIMIT = 35;
const H4_WINDOW_DAYS = 30;

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

  for (const subnet of subnets) {
    try {
      const history = await fetchSubnetHistory(subnet.id, SUBNET_DAILY_LIMIT, env);

      if (historyDays(history) < MIN_HISTORY_DAYS) continue;

      // Convert subnet TAO-priced returns → USDT via log-return additivity
      const subnetTaoReturns = logReturns(history.map(k => k.price));
      const taoSlice = taoReturns.slice(-subnetTaoReturns.length);
      const subnetUsdtReturns = subnetTaoReturns.map((r, i) =>
        r !== null && taoSlice[i] !== null ? r + taoSlice[i] : null
      );

      const h4 = linearRegressionPipeline(taoSlice, subnetUsdtReturns);

      // Accuracy vs previous h4 model
      const prev = subnetMap[subnet.id];
      let h4Acc = null;
      let h4Mape = prev?.h4?.mapeHistory ?? [];

      if (prev?.h4?.beta0 != null && taoSlice.length > 0) {
        const xA = taoSlice[taoSlice.length - 1];
        const yA = subnetUsdtReturns[subnetUsdtReturns.length - 1];
        if (xA != null && yA != null) {
          h4Acc = computeAccuracy(prev.h4.beta0, prev.h4.beta1, xA, yA);
          if (h4Acc !== null) h4Mape = [...h4Mape.slice(-4), 1 - h4Acc];
        }
      }

      if (h4) allAlphas.push(h4.beta0);

      const h4State = h4
        ? { beta0: h4.beta0, beta1: h4.beta1, r2: h4.r2, accuracy: h4Acc, mapeHistory: h4Mape, windowDays: H4_WINDOW_DAYS }
        : (prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: H4_WINDOW_DAYS });

      const tvlUsd = Math.round(subnet.tvlTao * taoUsdPrice);

      if (subnetMap[subnet.id]) {
        subnetMap[subnet.id] = { ...subnetMap[subnet.id], tvl: tvlUsd, h4: h4State };
      } else {
        subnetMap[subnet.id] = {
          id: subnet.id,
          symbol: subnet.symbol,
          name: subnet.name,
          tvl: tvlUsd,
          regDays: historyDays(history),
          h4: h4State,
          d1: null,
          w1: null,
        };
      }

      console.log(`[4h] SN${subnet.id} ${subnet.symbol} R²=${h4?.r2?.toFixed(2) ?? "n/a"}`);
    } catch (err) {
      console.error(`[4h] SN${subnet.id} failed: ${err.message}`);
    }
  }

  if (allAlphas.length > 0) {
    state.alphaRanges = state.alphaRanges ?? {};
    state.alphaRanges.h4 = percentileRange(allAlphas, 5, 95);
  }

  state.subnets = Object.values(subnetMap);
  console.log(`[4h] done — ${state.subnets.length} subnets`);
}
