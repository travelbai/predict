// Cron 1 — Daily 00:00 UTC
//
// Step 1: BTC → TAO macro regression (52-week window)
// Step 2: TAO → Subnet daily regressions
//   d1: last 90 daily candles
//   w1: 180 daily candles aggregated to weekly

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetHistory, historyDays, MIN_HISTORY_DAYS, BATCH_SIZE } from "../lib/taostats.js";
import {
  logReturns,
  alignByTimestamp,
  linearRegressionPipeline,
  aggregateToWeekly,
  percentileRange,
  computeAccuracy,
  zeroVolumeRatio,
  adaptiveWindow,
} from "../lib/math.js";

const BTC_TAO_WEEKS = 52;
// TAO daily fetch must cover the max d1 window + 1 price point for returns
const TAO_DAILY_FETCH = 185;

// Adaptive window bounds (days)
const D1_MIN = 30, D1_MAX = 180, D1_DEFAULT = 90;
const W1_MIN = 90, W1_MAX = 360, W1_DEFAULT = 180;

export async function runDailyCron(state, env, batch = 0) {
  console.log(`[daily] === starting daily regression run (batch ${batch}) ===`);
  const now = new Date().toISOString();

  // ── Step 1: BTC → TAO macro ───────────────────────────────────────────────
  console.log("[daily] step 1: Binance BTC + TAO weekly klines");

  const [btcWeekly, taoWeekly, taoDaily] = await Promise.all([
    fetchBinanceKlines("BTCUSDT", "1w", BTC_TAO_WEEKS),
    fetchBinanceKlines("TAOUSDT", "1w", BTC_TAO_WEEKS),
    fetchBinanceKlines("TAOUSDT", "1d", TAO_DAILY_FETCH),
  ]);

  const { x: btcPrices, y: taoPrices } = alignByTimestamp(btcWeekly, taoWeekly);
  const btcReturns = logReturns(btcPrices);
  const taoWeeklyReturns = logReturns(taoPrices);

  // Cross-run single-point accuracy for BTC→TAO
  let btcTaoAccuracy = null;
  let btcTaoMapeHistory = state.btcTao?.mapeHistory ?? [];
  if (state.btcTao?.beta0 != null) {
    const xA = btcReturns[btcReturns.length - 1];
    const yA = taoWeeklyReturns[taoWeeklyReturns.length - 1];
    if (Number.isFinite(xA) && Number.isFinite(yA)) {
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

  const allSubnets = await fetchEligibleSubnets(env);
  const subnets = allSubnets.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
  console.log(`[daily] batch ${batch}: ${subnets.length} subnets (of ${allSubnets.length} eligible)`);

  const allAlphas = { d1: [], w1: [] };
  const subnetMap = Object.fromEntries((state.subnets ?? []).map(s => [s.id, s]));

  // TAO/USD price from the last Binance daily candle (needed for TVL conversion)
  const taoUsdPrice = taoDaily[taoDaily.length - 1]?.price ?? 0;

  // Process subnets in parallel chunks to avoid Taostats rate-limiting
  const CHUNK = 10;
  const results = [];
  for (let i = 0; i < subnets.length; i += CHUNK) {
    const chunk = subnets.slice(i, i + CHUNK);
    results.push(...await Promise.allSettled(chunk.map(async subnet => {
    const prev = subnetMap[subnet.id];

    const d1Win = adaptiveWindow(prev?.d1?.mapeHistory, prev?.d1?.windowDays ?? D1_DEFAULT, D1_MIN, D1_MAX);
    const w1Win = adaptiveWindow(prev?.w1?.mapeHistory, prev?.w1?.windowDays ?? W1_DEFAULT, W1_MIN, W1_MAX);
    const fetchDays = Math.min(Math.max(d1Win, w1Win) + 5, W1_MAX + 5);

    const history = await fetchSubnetHistory(subnet.id, fetchDays, env);

    const days = historyDays(history);
    if (days < MIN_HISTORY_DAYS) {
      console.log(`[daily] SN${subnet.id} skipped: only ${days} days of history`);
      return null;
    }

    const zvr = zeroVolumeRatio(history);
    if (zvr > 0.15) {
      console.log(`[daily] SN${subnet.id} skipped: ${(zvr * 100).toFixed(0)}% zero-volume candles`);
      return null;
    }

    const tvlUsd = subnet.tvlTao * taoUsdPrice;

    const recentD1 = history.slice(-d1Win);
    const subnetTaoReturns_d1 = logReturns(recentD1.map(k => k.price));
    const taoSlice_d1 = taoDailyReturns.slice(-subnetTaoReturns_d1.length);
    const subnetUsdtReturns_d1 = subnetTaoReturns_d1.map((r, i) =>
      r !== null && taoSlice_d1[i] !== null ? r + taoSlice_d1[i] : null
    );
    const d1 = linearRegressionPipeline(taoSlice_d1, subnetUsdtReturns_d1);

    const recentW1 = history.slice(-w1Win);
    const weekly = aggregateToWeekly(recentW1);
    const subnetTaoReturns_w1 = logReturns(weekly.map(k => k.price));
    const taoSlice_w1 = taoWeeklyReturns.slice(-subnetTaoReturns_w1.length);
    const subnetUsdtReturns_w1 = subnetTaoReturns_w1.map((r, i) =>
      r !== null && taoSlice_w1[i] !== null ? r + taoSlice_w1[i] : null
    );
    const w1 = linearRegressionPipeline(taoSlice_w1, subnetUsdtReturns_w1);

    // Cross-run single-point accuracy: old β predicts latest actual data point
    let d1Acc = null, w1Acc = null;
    let d1Mape = prev?.d1?.mapeHistory ?? [];
    let w1Mape = prev?.w1?.mapeHistory ?? [];

    if (prev?.d1?.beta0 != null) {
      const lastIdx = subnetUsdtReturns_d1.length - 1;
      const xA = taoSlice_d1[lastIdx];
      const yA = subnetUsdtReturns_d1[lastIdx];
      if (Number.isFinite(xA) && Number.isFinite(yA)) {
        d1Acc = computeAccuracy(prev.d1.beta0, prev.d1.beta1, xA, yA);
        if (d1Acc !== null) d1Mape = [...d1Mape.slice(-4), 1 - d1Acc];
      }
    }
    if (prev?.w1?.beta0 != null) {
      const lastIdx = subnetUsdtReturns_w1.length - 1;
      const xA = taoSlice_w1[lastIdx];
      const yA = subnetUsdtReturns_w1[lastIdx];
      if (Number.isFinite(xA) && Number.isFinite(yA)) {
        w1Acc = computeAccuracy(prev.w1.beta0, prev.w1.beta1, xA, yA);
        if (w1Acc !== null) w1Mape = [...w1Mape.slice(-4), 1 - w1Acc];
      }
    }

    console.log(`[daily] SN${subnet.id} ${subnet.symbol} d1(${d1Win}d) R²=${d1?.r2?.toFixed(2) ?? "n/a"} w1(${w1Win}d) R²=${w1?.r2?.toFixed(2) ?? "n/a"}`);

    return {
      id: subnet.id,
      symbol: subnet.symbol,
      name: subnet.name,
      tvl: Math.round(tvlUsd),
      regDays: days,
      h4: prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: 30 },
      d1: d1 ? { beta0: d1.beta0, beta1: d1.beta1, r2: d1.r2, accuracy: d1Acc, mapeHistory: d1Mape, windowDays: d1Win } : (prev?.d1 ?? null),
      w1: w1 ? { beta0: w1.beta0, beta1: w1.beta1, r2: w1.r2, accuracy: w1Acc, mapeHistory: w1Mape, windowDays: w1Win } : (prev?.w1 ?? null),
    };
  })));
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      console.error(`[daily] SN${subnets[i].id} failed: ${r.reason?.message}`);
    } else if (r.value !== null) {
      subnetMap[r.value.id] = r.value;
      if (r.value.d1?.beta0 != null) allAlphas.d1.push(r.value.d1.beta0);
      if (r.value.w1?.beta0 != null) allAlphas.w1.push(r.value.w1.beta0);
    }
  }

  if (allAlphas.d1.length > 0) state.alphaRanges.d1 = percentileRange(allAlphas.d1, 5, 95);
  if (allAlphas.w1.length > 0) state.alphaRanges.w1 = percentileRange(allAlphas.w1, 5, 95);

  // Prune subnets no longer in the full eligible list (not just the current batch)
  const eligibleIds = new Set(allSubnets.map(s => s.id));
  state.subnets = Object.values(subnetMap).filter(s => eligibleIds.has(s.id));
  console.log(`[daily] done — ${state.subnets.length} subnets`);
}
