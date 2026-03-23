/**
 * Cron 2 — Every 4 hours (6×/day)
 *
 * Computes TAO → Subnet 4H regression for all eligible subnets.
 * Updates only the h4 field in state; leaves d1 + w1 untouched.
 *
 * Window: 30 days × 6 bars/day = 180 4H candles
 */

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetKlines, isTooThinlyTraded } from "../lib/taostats.js";
import {
  logReturns,
  linearRegressionPipeline,
  percentileRange,
  computeAccuracy,
} from "../lib/math.js";

// 30 days × 6 bars/day
const H4_LIMIT = 180;
const H4_WINDOW_DAYS = 30;

export async function runFourHourCron(state, env) {
  console.log("[4h] === starting 4H regression run ===");
  const now = new Date().toISOString();

  // ── Fetch TAO 4H klines from Binance ─────────────────────────────────────
  console.log("[4h] fetching TAO/USDT 4H klines");
  const tao4hKlines = await fetchBinanceKlines("TAOUSDT", "4h", H4_LIMIT);
  const taoReturns = logReturns(tao4hKlines.map(k => k.price));

  // ── Fetch eligible subnets ────────────────────────────────────────────────
  const subnets = await fetchEligibleSubnets(env);
  console.log(`[4h] ${subnets.length} subnets to process`);

  const subnetMap = Object.fromEntries((state.subnets ?? []).map(s => [s.id, s]));
  const allAlphas = [];

  for (const subnet of subnets) {
    try {
      const klines = await fetchSubnetKlines(subnet.id, "4h", H4_LIMIT, env);

      if (isTooThinlyTraded(klines)) {
        console.log(`[4h] SN${subnet.id} excluded: too many zero-volume candles`);
        continue;
      }

      // Subnet prices are in TAO → USDT via log-return additivity
      const subnetTaoReturns = logReturns(klines.map(k => k.price));
      const taoSlice = taoReturns.slice(-subnetTaoReturns.length);
      const subnetUsdtReturns = subnetTaoReturns.map((r, i) =>
        r !== null && taoSlice[i] !== null ? r + taoSlice[i] : null
      );

      const h4 = linearRegressionPipeline(taoSlice, subnetUsdtReturns);

      // Accuracy vs previous 4H model
      const prev = subnetMap[subnet.id];
      let h4Accuracy = null;
      let h4MapeHistory = prev?.h4?.mapeHistory ?? [];

      if (prev?.h4?.beta0 != null && taoSlice.length > 0) {
        const xA = taoSlice[taoSlice.length - 1];
        const yA = subnetUsdtReturns[subnetUsdtReturns.length - 1];
        if (xA != null && yA != null) {
          h4Accuracy = computeAccuracy(prev.h4.beta0, prev.h4.beta1, xA, yA);
          if (h4Accuracy !== null) h4MapeHistory = [...h4MapeHistory.slice(-4), 1 - h4Accuracy];
        }
      }

      if (h4) allAlphas.push(h4.beta0);

      const h4State = h4
        ? { beta0: h4.beta0, beta1: h4.beta1, r2: h4.r2, accuracy: h4Accuracy, mapeHistory: h4MapeHistory, windowDays: H4_WINDOW_DAYS }
        : (prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: H4_WINDOW_DAYS });

      if (subnetMap[subnet.id]) {
        // Update only h4; preserve d1 + w1 + metadata
        subnetMap[subnet.id] = { ...subnetMap[subnet.id], h4: h4State };
      } else {
        // New subnet not yet in state
        subnetMap[subnet.id] = {
          id: subnet.id,
          symbol: subnet.symbol,
          name: subnet.name,
          tvl: subnet.tvl,
          regDays: subnet.regDays,
          h4: h4State,
          d1: null,
          w1: null,
        };
      }

      console.log(`[4h] SN${subnet.id} ${subnet.symbol} — h4 R²=${h4?.r2?.toFixed(2) ?? "n/a"}`);
    } catch (err) {
      console.error(`[4h] SN${subnet.id} failed: ${err.message}`);
    }
  }

  // Calibrate 4H alpha range
  if (allAlphas.length > 0) {
    state.alphaRanges = state.alphaRanges ?? {};
    state.alphaRanges.h4 = percentileRange(allAlphas, 5, 95);
  }

  state.subnets = Object.values(subnetMap);
  console.log(`[4h] done — ${state.subnets.length} subnets in state`);
}
