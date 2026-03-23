/**
 * Cron 1 — Daily 00:00 UTC
 *
 * Executes in one Worker invocation, in serial:
 *   Step 1: Fetch BTC/USDT 1W + TAO/USDT 1W + TAO/USDT 1D from Binance
 *           → compute BTC→TAO macro regression (52-week window)
 *   Step 2: Fetch each subnet 1D history from Taostats (one call per subnet)
 *           → compute TAO→Subnet 24H regression (90-day window)
 *           → compute TAO→Subnet 1W regression (weekly aggregation, 26 samples)
 *   Write merged result to KV
 */

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchEligibleSubnets, fetchSubnetKlines, isTooThinlyTraded } from "../lib/taostats.js";
import {
  logReturns,
  alignByTimestamp,
  linearRegressionPipeline,
  aggregateToWeekly,
  percentileRange,
  computeAccuracy,
} from "../lib/math.js";

// ── Window constants ──────────────────────────────────────────────────────────

const BTC_TAO_WEEKS = 52;     // 360d ÷ 7 ≈ 52 weekly samples
const SUBNET_DAILY_LIMIT = 180;
const D1_WINDOW_DAYS = 90;    // 24H regression: last 90 daily candles
// 1W regression uses all 180d aggregated to ~26 weekly bars

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runDailyCron(state, env) {
  console.log("[daily] === starting daily regression run ===");
  const now = new Date().toISOString();

  // ── Step 1: BTC → TAO macro regression ───────────────────────────────────
  console.log("[daily] step 1: fetching BTC & TAO klines from Binance");

  const [btcWeekly, taoWeekly, taoDaily] = await Promise.all([
    fetchBinanceKlines("BTCUSDT", "1w", BTC_TAO_WEEKS),
    fetchBinanceKlines("TAOUSDT", "1w", BTC_TAO_WEEKS),
    fetchBinanceKlines("TAOUSDT", "1d", SUBNET_DAILY_LIMIT),
  ]);

  // Align BTC & TAO weekly by close-timestamp
  const { x: btcPrices, y: taoPrices } = alignByTimestamp(btcWeekly, taoWeekly);

  const btcReturns = logReturns(btcPrices);
  const taoWeeklyReturns = logReturns(taoPrices);

  // Validate old BTC→TAO model accuracy before overwriting
  let btcTaoAccuracy = null;
  let btcTaoMapeHistory = state.btcTao?.mapeHistory ?? [];
  if (state.btcTao?.beta0 != null && taoWeeklyReturns.length > 0) {
    const xActual = btcReturns[btcReturns.length - 1];
    const yActual = taoWeeklyReturns[taoWeeklyReturns.length - 1];
    if (xActual != null && yActual != null) {
      btcTaoAccuracy = computeAccuracy(state.btcTao.beta0, state.btcTao.beta1, xActual, yActual);
      const mape = btcTaoAccuracy !== null ? 1 - btcTaoAccuracy : null;
      if (mape !== null) {
        btcTaoMapeHistory = [...btcTaoMapeHistory.slice(-4), mape];
      }
    }
  }

  const btcTaoResult = linearRegressionPipeline(btcReturns, taoWeeklyReturns);
  if (!btcTaoResult) throw new Error("BTC→TAO regression: insufficient samples after IQR filter");

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

  // Alpha range for BTC→TAO gauge (P5/P95 of β₀ over historical btcReturns)
  // We use the current taoWeeklyReturns as a proxy for the α distribution.
  // A more rigorous approach would compute rolling β₀ over a 2-year history (P3).
  state.alphaRangeBtcTao = percentileRange(taoWeeklyReturns.filter(r => r !== null), 5, 95);

  // TAO log returns (daily) — needed for unit conversion of subnet prices
  const taoDailyReturns = logReturns(taoDaily.map(d => d.price));

  console.log(`[daily] step 1 done — BTC→TAO β₁=${btcTaoResult.beta1.toFixed(3)} R²=${btcTaoResult.r2.toFixed(3)}`);

  // ── Step 2: TAO → Subnets (24H + 1W) ────────────────────────────────────
  console.log("[daily] step 2: fetching eligible subnets from Taostats");

  const subnets = await fetchEligibleSubnets(env);
  console.log(`[daily] ${subnets.length} subnets passed registration gate`);

  const allAlphas = { d1: [], w1: [] };
  const subnetMap = Object.fromEntries((state.subnets ?? []).map(s => [s.id, s]));

  for (const subnet of subnets) {
    try {
      // One Taostats call per subnet — 180 daily candles (TAO-priced)
      const dailyKlines = await fetchSubnetKlines(subnet.id, "1d", SUBNET_DAILY_LIMIT, env);

      if (isTooThinlyTraded(dailyKlines)) {
        console.log(`[daily] SN${subnet.id} excluded: too many zero-volume candles`);
        continue;
      }

      // ── 24H regression (last 90 days) ─────────────────────────────────
      const recent90 = dailyKlines.slice(-D1_WINDOW_DAYS);
      const subnetTaoReturns_d1 = logReturns(recent90.map(k => k.price));
      // TAO slice must be the same length as subnet returns
      const taoSlice_d1 = taoDailyReturns.slice(-subnetTaoReturns_d1.length);
      // Convert subnet returns to USDT-denominated via log-return additivity
      const subnetUsdtReturns_d1 = subnetTaoReturns_d1.map((r, i) =>
        r !== null && taoSlice_d1[i] !== null ? r + taoSlice_d1[i] : null
      );
      const d1 = linearRegressionPipeline(taoSlice_d1, subnetUsdtReturns_d1);

      // ── 1W regression (weekly aggregation of full 180d) ────────────────
      const weeklyKlines = aggregateToWeekly(dailyKlines);
      const subnetTaoReturns_w1 = logReturns(weeklyKlines.map(k => k.price));
      const taoSlice_w1 = taoWeeklyReturns.slice(-subnetTaoReturns_w1.length);
      const subnetUsdtReturns_w1 = subnetTaoReturns_w1.map((r, i) =>
        r !== null && taoSlice_w1[i] !== null ? r + taoSlice_w1[i] : null
      );
      const w1 = linearRegressionPipeline(taoSlice_w1, subnetUsdtReturns_w1);

      // Compute accuracy vs last period's model
      const prev = subnetMap[subnet.id];
      let d1Accuracy = null, w1Accuracy = null;
      let d1MapeHistory = prev?.d1?.mapeHistory ?? [];
      let w1MapeHistory = prev?.w1?.mapeHistory ?? [];

      if (prev?.d1?.beta0 != null && taoSlice_d1.length > 0) {
        const xA = taoSlice_d1[taoSlice_d1.length - 1];
        const yA = subnetUsdtReturns_d1[subnetUsdtReturns_d1.length - 1];
        if (xA != null && yA != null) {
          d1Accuracy = computeAccuracy(prev.d1.beta0, prev.d1.beta1, xA, yA);
          if (d1Accuracy !== null) d1MapeHistory = [...d1MapeHistory.slice(-4), 1 - d1Accuracy];
        }
      }
      if (prev?.w1?.beta0 != null && taoSlice_w1.length > 0) {
        const xA = taoSlice_w1[taoSlice_w1.length - 1];
        const yA = subnetUsdtReturns_w1[subnetUsdtReturns_w1.length - 1];
        if (xA != null && yA != null) {
          w1Accuracy = computeAccuracy(prev.w1.beta0, prev.w1.beta1, xA, yA);
          if (w1Accuracy !== null) w1MapeHistory = [...w1MapeHistory.slice(-4), 1 - w1Accuracy];
        }
      }

      if (d1) allAlphas.d1.push(d1.beta0);
      if (w1) allAlphas.w1.push(w1.beta0);

      // Preserve h4 from previous state; daily cron only updates d1 + w1
      const prevH4 = prev?.h4 ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null, mapeHistory: [], windowDays: 30 };

      subnetMap[subnet.id] = {
        id: subnet.id,
        symbol: subnet.symbol,
        name: subnet.name,
        tvl: subnet.tvl,
        regDays: subnet.regDays,
        h4: prevH4,
        d1: d1 ? { beta0: d1.beta0, beta1: d1.beta1, r2: d1.r2, accuracy: d1Accuracy, mapeHistory: d1MapeHistory, windowDays: D1_WINDOW_DAYS } : (prev?.d1 ?? null),
        w1: w1 ? { beta0: w1.beta0, beta1: w1.beta1, r2: w1.r2, accuracy: w1Accuracy, mapeHistory: w1MapeHistory, windowDays: 180 } : (prev?.w1 ?? null),
      };

      console.log(`[daily] SN${subnet.id} ${subnet.symbol} — d1 R²=${d1?.r2?.toFixed(2) ?? "n/a"} w1 R²=${w1?.r2?.toFixed(2) ?? "n/a"}`);
    } catch (err) {
      // Single subnet failure must not abort the whole run
      console.error(`[daily] SN${subnet.id} failed: ${err.message}`);
    }
  }

  // Calibrate alpha ranges (P5/P95 across all subnets)
  if (allAlphas.d1.length > 0) state.alphaRanges.d1 = percentileRange(allAlphas.d1, 5, 95);
  if (allAlphas.w1.length > 0) state.alphaRanges.w1 = percentileRange(allAlphas.w1, 5, 95);

  state.subnets = Object.values(subnetMap);

  console.log(`[daily] step 2 done — ${Object.keys(subnetMap).length} subnets in state`);
}
