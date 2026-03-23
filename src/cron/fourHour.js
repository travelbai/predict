// Cron 2 — Every 4 hours (6x/day)
//
// h4 regression: TAO → Subnet using last 30 days of daily candles.
// Taostats does not provide sub-daily history, so daily data is used
// for all three time windows. h4 reflects the shortest (30d) window.

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetHistory, historyDays, MIN_HISTORY_DAYS } from "../lib/taostats.js";
import {
  logReturns,
  linearRegressionPipeline,
  percentileRange,
  computeAccuracy,
} from "../lib/math.js";

const H4_WINDOW = 30; // days
const H4_FETCH_LIMIT = 35; // a few extra for IQR headroom

export async function runFourHourCron(state, env) {
  console.log("[4h] === starting 4H (30d daily) regression run ===");
  const now = new Date().toISOString();

  // TAO daily returns from Binance (last 35 days)
  console.log("[4h] fetching TAO/USDT daily klines from Binance");
  const taoKlines = await fetchBinanceKlines("TAOUSDT", "1d", H4_FETCH_LIMIT);
  const taoReturns = logReturns(taoKlines.map(k => k.price));

  const taoUsdPrice = taoKlines[taoKlines.length - 1]?.price ?? 0;

  const subnets = await fetchEligibleSubnets(env);
  console.log(`[4h] ${subnets.length} subnets to process`);

  const subnetMap = Object.fromEntries((state.subnets ?? []).map(s => [s.id, s]));
  const allAlphas = [];

  for (const subnet of subnets) {
    try {
      const history = await fetchSubnetHistory(subnet.id, H4_FETCH_LIMIT, env);

      if (historyDays(history) < MIN_HISTORY_DAYS) continue;

      const subnetTaoReturns = logReturns(history.map(k => k.price));
      const taoSlice = taoReturns.slice(-subnetTaoReturns.length);
      // Convert TAO-priced subnet returns → USDT
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
        ? { beta0: h4.beta0, beta1: h4.beta1, r2: h4.r2, accuracy: h4Acc, mapeHistory: h4Mape, windowDays: H4_WINDOW }
        : (prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: H4_WINDOW });

      const tvlUsd = subnet.tvlTao * taoUsdPrice;

      if (subnetMap[subnet.id]) {
        subnetMap[subnet.id] = {
          ...subnetMap[subnet.id],
          tvl: Math.round(tvlUsd),
          h4: h4State,
        };
      } else {
        subnetMap[subnet.id] = {
          id: subnet.id,
          symbol: subnet.symbol,
          name: subnet.name,
          tvl: Math.round(tvlUsd),
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
