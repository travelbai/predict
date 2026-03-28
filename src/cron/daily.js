// Cron 1 — Daily 00:01 UTC (3 batches: 00:01, 00:21, 00:41)
//
// Step 1: BTC → TAO macro regression (52-week window)
// Step 2: TAO → Subnet regressions
//   d1: every day  — last 90 daily candles
//   w1: Monday only — 180 daily candles aggregated to weekly

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetHistory, historyDays, MIN_HISTORY_DAYS, BATCH_SIZE } from "../lib/taostats.js";
import {
  logReturns,
  alignByTimestamp,
  linearRegressionPipeline,
  aggregateToWeekly,
  percentileRange,
  zeroVolumeRatio,
  adaptiveWindow,
} from "../lib/math.js";

// TAO daily fetch: D1_MAX(180) + 5 buffer for alignment
const TAO_DAILY_FETCH = 185;

// Adaptive window bounds — weeks (BTC→TAO uses weekly data)
const BTC_TAO_MIN = 26, BTC_TAO_MAX = 104, BTC_TAO_DEFAULT = 52; // 6m / 2y / 1y
// Adaptive window bounds — days (subnet regressions)
const D1_MIN = 30, D1_MAX = 180, D1_DEFAULT = 90;   // 1m / 6m / 3m
const W1_MIN = 90, W1_MAX = 360, W1_DEFAULT = 180;   // 3m / 1y / 6m

export async function runDailyCron(state, env, batch = 0) {
  const isMonday = new Date().getUTCDay() === 1;
  console.log(`[daily] === starting daily regression run (batch ${batch}, w1=${isMonday ? "yes" : "skip"}) ===`);
  const now = new Date().toISOString();

  // ── Step 1: BTC → TAO macro ───────────────────────────────────────────────
  console.log("[daily] step 1: Binance BTC + TAO weekly klines");

  const btcTaoWeeks = adaptiveWindow(
    state.btcTao?.mapeHistory,
    state.btcTao?.windowWeeks ?? BTC_TAO_DEFAULT,
    BTC_TAO_MIN,
    BTC_TAO_MAX,
  );

  const fetches = [
    fetchBinanceKlines("BTCUSDT", "1w", btcTaoWeeks),
    fetchBinanceKlines("TAOUSDT", "1d", TAO_DAILY_FETCH),
  ];
  // Weekly TAO klines only needed when w1 runs (Monday) or for BTC→TAO macro
  fetches.push(fetchBinanceKlines("TAOUSDT", "1w", btcTaoWeeks));

  const [btcWeekly, taoDaily, taoWeekly] = await Promise.all(fetches);

  const { x: btcPrices, y: taoPrices } = alignByTimestamp(btcWeekly, taoWeekly);
  const btcReturns = logReturns(btcPrices);
  const taoWeeklyReturns = logReturns(taoPrices);

  const btcTaoResult = linearRegressionPipeline(btcReturns, taoWeeklyReturns);
  if (!btcTaoResult) throw new Error("BTC→TAO: insufficient clean samples");

  // Cross-run sMAPE for btcTao → drives mapeHistory
  let btcTaoSmape = null;
  if (state.btcTao?.beta0 != null) {
    for (let j = taoWeeklyReturns.length - 1; j >= 0; j--) {
      const xA = btcReturns[j];
      const yA = taoWeeklyReturns[j];
      if (Number.isFinite(xA) && Number.isFinite(yA)) {
        const yPred = state.btcTao.beta0 + state.btcTao.beta1 * xA;
        const denom = (Math.abs(yPred) + Math.abs(yA)) / 2;
        btcTaoSmape = denom < 1e-10 ? 0 : Math.abs(yPred - yA) / denom;
        break;
      }
    }
  }
  const btcTaoMapeHistory = btcTaoSmape != null
    ? [...(state.btcTao?.mapeHistory ?? []), btcTaoSmape].slice(-10)
    : (state.btcTao?.mapeHistory ?? []);

  state.btcTao = {
    beta0: btcTaoResult.beta0,
    beta1: btcTaoResult.beta1,
    r2: btcTaoResult.r2,
    accuracy: btcTaoResult.accuracy,
    windowWeeks: btcTaoWeeks,
    windowDays: btcTaoWeeks * 7,
    window: `${btcTaoWeeks * 7}d / ${btcTaoWeeks}w`,
    sampleCount: btcTaoResult.sampleCount,
    mapeHistory: btcTaoMapeHistory,
    calculatedAt: now,
  };

  state.alphaRangeBtcTao = percentileRange(
    taoWeeklyReturns.filter(r => r !== null), 5, 95
  );

  // TAO daily log-returns reused for unit conversion (subnet TAO→USDT)
  const taoDailyReturns = logReturns(taoDaily.map(d => d.price));

  console.log(`[daily] BTC→TAO β₁=${btcTaoResult.beta1.toFixed(3)} R²=${btcTaoResult.r2.toFixed(3)}`);

  // ── Step 2: TAO → Subnets ─────────────────────────────────────────────────
  console.log(`[daily] step 2: subnet regressions (d1${isMonday ? " + w1" : ""})`);

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
    const w1Win = isMonday
      ? adaptiveWindow(prev?.w1?.mapeHistory, prev?.w1?.windowDays ?? W1_DEFAULT, W1_MIN, W1_MAX)
      : 0;
    // On non-Monday, only fetch enough history for d1
    const fetchDays = isMonday
      ? Math.min(Math.max(d1Win, w1Win) + 5, W1_MAX + 5)
      : d1Win + 5;

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

    // ── d1 regression (every day) ──────────────────────────────────────────
    const recentD1 = history.slice(-d1Win);
    const subnetTaoReturns_d1 = logReturns(recentD1.map(k => k.price));
    const taoSlice_d1 = taoDailyReturns.slice(-subnetTaoReturns_d1.length);
    const subnetUsdtReturns_d1 = subnetTaoReturns_d1.map((r, i) =>
      r !== null && taoSlice_d1[i] !== null ? r + taoSlice_d1[i] : null
    );
    const d1 = linearRegressionPipeline(taoSlice_d1, subnetUsdtReturns_d1);

    // Cross-run sMAPE for d1
    let crossRunSmape_d1 = null;
    if (prev?.d1?.beta0 != null) {
      for (let j = subnetUsdtReturns_d1.length - 1; j >= 0; j--) {
        const xA = taoSlice_d1[j];
        const yA = subnetUsdtReturns_d1[j];
        if (Number.isFinite(xA) && Number.isFinite(yA)) {
          const yPred = prev.d1.beta0 + prev.d1.beta1 * xA;
          const denom = (Math.abs(yPred) + Math.abs(yA)) / 2;
          crossRunSmape_d1 = denom < 1e-10 ? 0 : Math.abs(yPred - yA) / denom;
          break;
        }
      }
    }
    const mapeHistory_d1 = crossRunSmape_d1 != null
      ? [...(prev?.d1?.mapeHistory ?? []), crossRunSmape_d1].slice(-10)
      : (prev?.d1?.mapeHistory ?? []);
    const crossRunAcc_d1 = crossRunSmape_d1 != null ? Math.max(0, Math.min(1, 1 - crossRunSmape_d1)) : null;

    // ── w1 regression (Monday only) ────────────────────────────────────────
    let w1Result = null;
    let mapeHistory_w1 = prev?.w1?.mapeHistory ?? [];
    let crossRunAcc_w1 = null;

    if (isMonday) {
      const recentW1 = history.slice(-w1Win);
      const weekly = aggregateToWeekly(recentW1);
      const subnetTaoReturns_w1 = logReturns(weekly.map(k => k.price));
      const taoSlice_w1 = taoWeeklyReturns.slice(-subnetTaoReturns_w1.length);
      const subnetUsdtReturns_w1 = subnetTaoReturns_w1.map((r, i) =>
        r !== null && taoSlice_w1[i] !== null ? r + taoSlice_w1[i] : null
      );
      w1Result = linearRegressionPipeline(taoSlice_w1, subnetUsdtReturns_w1);

      // Cross-run sMAPE for w1
      let crossRunSmape_w1 = null;
      if (prev?.w1?.beta0 != null) {
        for (let j = subnetUsdtReturns_w1.length - 1; j >= 0; j--) {
          const xA = taoSlice_w1[j];
          const yA = subnetUsdtReturns_w1[j];
          if (Number.isFinite(xA) && Number.isFinite(yA)) {
            const yPred = prev.w1.beta0 + prev.w1.beta1 * xA;
            const denom = (Math.abs(yPred) + Math.abs(yA)) / 2;
            crossRunSmape_w1 = denom < 1e-10 ? 0 : Math.abs(yPred - yA) / denom;
            break;
          }
        }
      }
      mapeHistory_w1 = crossRunSmape_w1 != null
        ? [...(prev?.w1?.mapeHistory ?? []), crossRunSmape_w1].slice(-10)
        : (prev?.w1?.mapeHistory ?? []);
      crossRunAcc_w1 = crossRunSmape_w1 != null ? Math.max(0, Math.min(1, 1 - crossRunSmape_w1)) : null;
    }

    const logW1 = isMonday ? ` w1(${w1Win}d) R²=${w1Result?.r2?.toFixed(2) ?? "n/a"}` : "";
    console.log(`[daily] SN${subnet.id} ${subnet.symbol} d1(${d1Win}d) R²=${d1?.r2?.toFixed(2) ?? "n/a"}${logW1}`);

    return {
      id: subnet.id,
      symbol: subnet.symbol,
      name: subnet.name,
      tvl: Math.round(tvlUsd),
      regDays: days,
      h4: prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, windowDays: 30 },
      d1: d1 ? { beta0: d1.beta0, beta1: d1.beta1, r2: d1.r2, accuracy: d1.accuracy ?? crossRunAcc_d1, mapeHistory: mapeHistory_d1, windowDays: d1Win } : (prev?.d1 ?? null),
      w1: isMonday
        ? (w1Result ? { beta0: w1Result.beta0, beta1: w1Result.beta1, r2: w1Result.r2, accuracy: w1Result.accuracy ?? crossRunAcc_w1, mapeHistory: mapeHistory_w1, windowDays: w1Win } : (prev?.w1 ?? null))
        : (prev?.w1 ?? null),  // non-Monday: preserve previous w1 data
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
