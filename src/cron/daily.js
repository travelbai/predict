// Cron 1 — Daily 00:00 UTC
//
// Step 1: BTC → TAO macro regression (52-week window)
// Step 2: TAO → Subnet daily regressions
//   d1: last 90 daily candles
//   w1: 180 daily candles aggregated to weekly

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetHistory, historyDays, MIN_HISTORY_DAYS } from "../lib/taostats.js";
import {
  logReturns,
  alignByTimestamp,
  linearRegressionPipeline,
  aggregateToWeekly,
  percentileRange,
  computeAccuracy,
} from "../lib/math.js";

const BTC_TAO_WEEKS = 52;
const SUBNET_HISTORY_LIMIT = 180;
const D1_WINDOW = 90;

export async function runDailyCron(state, env) {
  console.log("[daily] === starting daily regression run ===");
  const now = new Date().toISOString();

  // ── Step 1: BTC → TAO macro ───────────────────────────────────────────────
  console.log("[daily] step 1: Binance BTC + TAO weekly klines");

  const [btcWeekly, taoWeekly, taoDaily] = await Promise.all([
    fetchBinanceKlines("BTCUSDT", "1w", BTC_TAO_WEEKS),
    fetchBinanceKlines("TAOUSDT", "1w", BTC_TAO_WEEKS),
    fetchBinanceKlines("TAOUSDT", "1d", SUBNET_HISTORY_LIMIT),
  ]);

  const { x: btcPrices, y: taoPrices } = alignByTimestamp(btcWeekly, taoWeekly);
  const btcReturns = logReturns(btcPrices);
  const taoWeeklyReturns = logReturns(taoPrices);

  // Accuracy of previous model
  let btcTaoAccuracy = null;
  let btcTaoMapeHistory = state.btcTao?.mapeHistory ?? [];
  if (state.btcTao?.beta0 != null && btcReturns.length > 0) {
    const xA = btcReturns[btcReturns.length - 1];
    const yA = taoWeeklyReturns[taoWeeklyReturns.length - 1];
    if (xA != null && yA != null) {
      btcTaoAccuracy = computeAccuracy(state.btcTao.beta0, state.btcTao.beta1, xA, yA);
      if (btcTaoAccuracy !== null)
        btcTaoMapeHistory = [...btcTaoMapeHistory.slice(-4), 1 - btcTaoAccuracy];
    }
  }

  const btcTaoResult = linearRegressionPipeline(btcReturns, taoWeeklyReturns);
  if (!btcTaoResult) throw new Error("BTC→TAO: insufficient clean samples");

  state.btcTao = {
    beta0: btcTaoResult.beta0,
    beta1: btcTaoResult.beta1,
    r2: btcTaoResult.r2,
    accuracy: btcTaoAccuracy,
    mapeHistory: btcTaoMapeHistory,
    windowDays: 360,
    window: "360d / 52w",
    sampleCount: btcTaoResult.sampleCount,
    calculatedAt: now,
  };

  state.alphaRangeBtcTao = percentileRange(
    taoWeeklyReturns.filter(r => r !== null), 5, 95
  );

  // TAO daily log-returns reused for unit conversion (subnet TAO→USDT)
  const taoDailyReturns = logReturns(taoDaily.map(d => d.price));

  console.log(`[daily] BTC→TAO β₁=${btcTaoResult.beta1.toFixed(3)} R²=${btcTaoResult.r2.toFixed(3)}`);

  // ── Step 2: TAO → Subnets (d1 + w1) ────────────────────────────────────
  console.log("[daily] step 2: subnet regressions (d1 + w1)");

  const subnets = await fetchEligibleSubnets(env);
  console.log(`[daily] ${subnets.length} subnets fetched`);

  const allAlphas = { d1: [], w1: [] };
  const subnetMap = Object.fromEntries((state.subnets ?? []).map(s => [s.id, s]));

  // TAO/USD price from the last Binance daily candle (needed for TVL conversion)
  const taoUsdPrice = taoDaily[taoDaily.length - 1]?.price ?? 0;

  for (const subnet of subnets) {
    try {
      const history = await fetchSubnetHistory(subnet.id, SUBNET_HISTORY_LIMIT, env);

      const days = historyDays(history);
      if (days < MIN_HISTORY_DAYS) {
        console.log(`[daily] SN${subnet.id} skipped: only ${days} days of history`);
        continue;
      }

      // TVL in USD
      const tvlUsd = subnet.tvlTao * taoUsdPrice;

      // ── d1 regression: last 90 daily candles ──────────────────────────
      const recent90 = history.slice(-D1_WINDOW);
      const subnetTaoReturns_d1 = logReturns(recent90.map(k => k.price));
      const taoSlice_d1 = taoDailyReturns.slice(-subnetTaoReturns_d1.length);
      // Convert subnet returns TAO→USDT via log-return additivity
      const subnetUsdtReturns_d1 = subnetTaoReturns_d1.map((r, i) =>
        r !== null && taoSlice_d1[i] !== null ? r + taoSlice_d1[i] : null
      );
      const d1 = linearRegressionPipeline(taoSlice_d1, subnetUsdtReturns_d1);

      // ── w1 regression: weekly aggregation of 180 days ─────────────────
      const weekly = aggregateToWeekly(history);
      const subnetTaoReturns_w1 = logReturns(weekly.map(k => k.price));
      const taoSlice_w1 = taoWeeklyReturns.slice(-subnetTaoReturns_w1.length);
      const subnetUsdtReturns_w1 = subnetTaoReturns_w1.map((r, i) =>
        r !== null && taoSlice_w1[i] !== null ? r + taoSlice_w1[i] : null
      );
      const w1 = linearRegressionPipeline(taoSlice_w1, subnetUsdtReturns_w1);

      // Accuracy vs previous model
      const prev = subnetMap[subnet.id];
      let d1Acc = null, w1Acc = null;
      let d1Mape = prev?.d1?.mapeHistory ?? [];
      let w1Mape = prev?.w1?.mapeHistory ?? [];

      if (prev?.d1?.beta0 != null && taoSlice_d1.length > 0) {
        const xA = taoSlice_d1[taoSlice_d1.length - 1];
        const yA = subnetUsdtReturns_d1[subnetUsdtReturns_d1.length - 1];
        if (xA != null && yA != null) {
          d1Acc = computeAccuracy(prev.d1.beta0, prev.d1.beta1, xA, yA);
          if (d1Acc !== null) d1Mape = [...d1Mape.slice(-4), 1 - d1Acc];
        }
      }
      if (prev?.w1?.beta0 != null && taoSlice_w1.length > 0) {
        const xA = taoSlice_w1[taoSlice_w1.length - 1];
        const yA = subnetUsdtReturns_w1[subnetUsdtReturns_w1.length - 1];
        if (xA != null && yA != null) {
          w1Acc = computeAccuracy(prev.w1.beta0, prev.w1.beta1, xA, yA);
          if (w1Acc !== null) w1Mape = [...w1Mape.slice(-4), 1 - w1Acc];
        }
      }

      if (d1) allAlphas.d1.push(d1.beta0);
      if (w1) allAlphas.w1.push(w1.beta0);

      subnetMap[subnet.id] = {
        id: subnet.id,
        symbol: subnet.symbol,
        name: subnet.name,
        tvl: Math.round(tvlUsd),
        regDays: days,
        // Preserve h4 from the 4H cron; daily cron only updates d1 + w1
        h4: prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: 30 },
        d1: d1
          ? { beta0: d1.beta0, beta1: d1.beta1, r2: d1.r2, accuracy: d1Acc, mapeHistory: d1Mape, windowDays: D1_WINDOW }
          : (prev?.d1 ?? null),
        w1: w1
          ? { beta0: w1.beta0, beta1: w1.beta1, r2: w1.r2, accuracy: w1Acc, mapeHistory: w1Mape, windowDays: 180 }
          : (prev?.w1 ?? null),
      };

      console.log(`[daily] SN${subnet.id} ${subnet.symbol} d1 R²=${d1?.r2?.toFixed(2) ?? "n/a"} w1 R²=${w1?.r2?.toFixed(2) ?? "n/a"}`);
    } catch (err) {
      console.error(`[daily] SN${subnet.id} failed: ${err.message}`);
    }
  }

  if (allAlphas.d1.length > 0) state.alphaRanges.d1 = percentileRange(allAlphas.d1, 5, 95);
  if (allAlphas.w1.length > 0) state.alphaRanges.w1 = percentileRange(allAlphas.w1, 5, 95);

  state.subnets = Object.values(subnetMap);
  console.log(`[daily] done — ${state.subnets.length} subnets`);
}
