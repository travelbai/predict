/**
 * Unified cron handler — runs every 4 hours.
 *
 * Flow (see spec §6):
 *   a. Read price_history from KV
 *   b. Read snapshot_prev from KV
 *   c. Fetch Binance (4 subrequests)
 *   d. Fetch Taostats bulk (1-2 subrequests)
 *   e. Append current prices to price_history
 *   f. Prune >180 days
 *   g. Check data-point counts per subnet per timeframe
 *   h. BTC vs TAO macro regression
 *   i. TAO vs Subnet regressions (h4 / d1 / w1)
 *   j. Accuracy from snapshot_prev (sMAPE)
 *   k. Build dashboard_state → KV
 *   l. Save snapshot_prev → KV
 *   m. Save price_history → KV
 */

import { fetchBinanceKlines } from "../lib/binance.js";
import { fetchAllPools, historyDays, MIN_HISTORY_DAYS } from "../lib/taostats.js";
import {
  logReturns,
  alignByTimestamp,
  iqrFilter,
  linearRegressionPipeline,
  aggregateToWeekly,
  aggregateToDaily,
  percentileRange,
} from "../lib/math.js";

// Minimum data points for each timeframe
const MIN_H4 = 42;   // ~7 days of 4h samples
const MIN_D1 = 30;   // ~30 days
const MIN_W1 = 14;   // ~14 weeks

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runCron(env) {
  const t0 = Date.now();
  console.log("[cron] === start ===");

  try {
    // a. price_history
    const history = await loadJSON(env, "price_history") ?? { subnets: {} };

    // b. snapshot_prev + previous dashboard (for mapeHistory carry-forward)
    const [prevSnapshot, prevDashboard] = await Promise.all([
      loadJSON(env, "snapshot_prev"),
      loadJSON(env, "dashboard_state"),
    ]);

    // c. Binance — 4 parallel requests
    const [btcDaily, taoWeekly, taoDaily, tao4h] = await Promise.all([
      fetchBinanceKlines("BTCUSDT", "1d", 365),   // daily for rolling 7d BTC→TAO
      fetchBinanceKlines("TAOUSDT", "1w", 52),     // weekly for subnet W1
      fetchBinanceKlines("TAOUSDT", "1d", 365),    // daily for BTC→TAO + subnet D1
      fetchBinanceKlines("TAOUSDT", "4h", 180),    // 4h for subnet H4
    ]);

    // d. Taostats — bulk fetch all pools (~1-2 requests)
    const pools = await fetchAllPools(env);
    console.log(`[cron] fetched ${pools.length} pools from Taostats`);

    // Current TAO/USDT price for TVL conversion
    const taoUsdPrice = taoDaily.length > 0
      ? taoDaily[taoDaily.length - 1].price
      : 0;

    // e. Append current prices to price_history
    const now = new Date();
    const timeKey = roundTo4h(now.getTime());

    for (const pool of pools) {
      const nid = pool.netuid;
      if (nid === 0 || nid == null) continue;
      const price = parseFloat(pool.price);
      if (!(price > 0)) continue;

      const id = String(nid);
      if (!history.subnets[id]) history.subnets[id] = [];
      const arr = history.subnets[id];
      // Deduplicate: skip if same 4h bucket already recorded
      if (arr.length === 0 || arr[arr.length - 1].time !== timeKey) {
        arr.push({ time: timeKey, price });
      }
    }

    // f. Prune >180 days
    const cutoff = now.getTime() - 180 * 86_400_000;
    for (const id of Object.keys(history.subnets)) {
      history.subnets[id] = history.subnets[id].filter(p => p.time >= cutoff);
      if (history.subnets[id].length === 0) delete history.subnets[id];
    }
    history.lastUpdated = now.toISOString();

    // ── h. BTC → TAO macro regression (rolling 7-day from daily data) ───

    // Sample every 7th daily close from the end → non-overlapping rolling weeks
    const btcRollingWk = sampleEveryNth(btcDaily, 7);
    const taoRollingWk = sampleEveryNth(taoDaily, 7);
    const { x: btcPrices, y: taoPrices } = alignByTimestamp(btcRollingWk, taoRollingWk);
    const btcReturns = logReturns(btcPrices);
    const taoWkReturns = logReturns(taoPrices);
    const btcTaoReg = linearRegressionPipeline(btcReturns, taoWkReturns);

    // BTC→TAO accuracy from prev snapshot
    let btcTaoAccuracy = null;
    const prevBtcMape = prevDashboard?.btcTao?.mapeHistory ?? [];
    if (prevSnapshot?.btcTao && btcReturns.length > 0 && taoWkReturns.length > 0) {
      const latestX = btcReturns[btcReturns.length - 1];
      const latestY = taoWkReturns[taoWkReturns.length - 1];
      if (latestX != null && latestY != null) {
        const yPred = prevSnapshot.btcTao.beta0 + prevSnapshot.btcTao.beta1 * latestX;
        const smape = symmetricMAPE(yPred, latestY);
        btcTaoAccuracy = Math.max(0, Math.min(1, 1 - smape / 2));
      }
    }
    const btcTaoMapeHistory = btcTaoAccuracy != null
      ? [...prevBtcMape, round4(1 - btcTaoAccuracy)].slice(-10)
      : prevBtcMape;

    // ── Prepare TAO return series for subnet regression ──────────────────

    // TAO/USDT log-returns at each granularity
    const tao4hReturns = logReturns(tao4h.map(k => k.price));
    const taoDailyReturns = logReturns(taoDaily.map(k => k.price));
    const taoWeeklyReturns = logReturns(taoWeekly.map(k => k.price));

    // ── i. TAO → Subnet regressions ─────────────────────────────────────

    const poolMap = new Map(pools.map(p => [p.netuid, p]));
    // Build prev-snapshot lookup
    const prevSubMap = new Map(
      (prevSnapshot?.subnets ?? []).map(s => [s.id, s])
    );
    const prevDashSubMap = new Map(
      (prevDashboard?.subnets ?? []).map(s => [s.id, s])
    );

    const subnetResults = [];
    const allAlphas = { h4: [], d1: [], w1: [] };

    for (const [netuidStr, priceArr] of Object.entries(history.subnets)) {
      const netuid = parseInt(netuidStr, 10);
      const pool = poolMap.get(netuid);
      if (!pool) continue;

      const days = historyDays(priceArr);
      if (days < MIN_HISTORY_DAYS) continue;

      const tvlUsd = Math.round((Number(pool.total_tao ?? 0) / 1e9) * taoUsdPrice);
      const name = (pool.name && pool.name !== 'Unknown') ? pool.name : `SN${netuid}`;
      const symbol = name;

      const prevSub = prevSubMap.get(netuid);
      const prevDashSub = prevDashSubMap.get(netuid);

      // ─── H4 regression ───
      const h4 = computeTimeframe(
        priceArr, tao4hReturns, MIN_H4,
        prevSub?.h4, prevDashSub?.h4?.mapeHistory,
      );

      // ─── D1 regression ───
      const subnetDaily = aggregateToDaily(priceArr);
      const d1 = computeTimeframe(
        subnetDaily, taoDailyReturns, MIN_D1,
        prevSub?.d1, prevDashSub?.d1?.mapeHistory,
      );

      // ─── W1 regression ───
      const subnetWeekly = aggregateToWeekly(subnetDaily);
      const w1 = computeTimeframe(
        subnetWeekly, taoWeeklyReturns, MIN_W1,
        prevSub?.w1, prevDashSub?.w1?.mapeHistory,
      );

      // Collect alpha values for range calculation
      if (h4?.beta1 != null) allAlphas.h4.push(h4.beta1);
      if (d1?.beta1 != null) allAlphas.d1.push(d1.beta1);
      if (w1?.beta1 != null) allAlphas.w1.push(w1.beta1);

      subnetResults.push({
        id: netuid,
        symbol: symbol.trim(),
        name: name.trim(),
        tvl: tvlUsd,
        regDays: days,
        h4: h4 ?? nullTimeframe(),
        d1: d1 ?? nullTimeframe(),
        w1: w1 ?? nullTimeframe(),
      });
    }

    // Sort by TVL descending
    subnetResults.sort((a, b) => b.tvl - a.tvl);

    // ── k. Build dashboard_state ─────────────────────────────────────────

    const nowISO = now.toISOString();
    const dashboardState = {
      version: 1,
      updatedAt: nowISO,
      status: "ok",
      staleReason: null,

      btcTao: btcTaoReg
        ? {
            beta0: round4(btcTaoReg.beta0),
            beta1: round4(btcTaoReg.beta1),
            r2: round4(btcTaoReg.r2),
            accuracy: btcTaoAccuracy != null ? round4(btcTaoAccuracy) : null,
            mapeHistory: btcTaoMapeHistory,
            windowDays: 364,
            window: "364d / 52w",
            sampleCount: btcTaoReg.sampleCount,
            calculatedAt: nowISO,
          }
        : null,

      alphaRangeBtcTao: percentileRange(
        taoWkReturns.filter(r => r != null), 5, 95
      ),

      alphaRanges: {
        h4: allAlphas.h4.length > 0 ? percentileRange(allAlphas.h4, 5, 95) : [0, 0],
        d1: allAlphas.d1.length > 0 ? percentileRange(allAlphas.d1, 5, 95) : [0, 0],
        w1: allAlphas.w1.length > 0 ? percentileRange(allAlphas.w1, 5, 95) : [0, 0],
      },

      subnets: subnetResults,
    };

    // ── l. Save snapshot_prev ────────────────────────────────────────────

    const snapshot = {
      btcTao: btcTaoReg
        ? { beta0: btcTaoReg.beta0, beta1: btcTaoReg.beta1 }
        : null,
      subnets: subnetResults.map(s => ({
        id: s.id,
        h4: s.h4.beta1 != null ? { beta0: s.h4.beta0, beta1: s.h4.beta1 } : null,
        d1: s.d1.beta1 != null ? { beta0: s.d1.beta0, beta1: s.d1.beta1 } : null,
        w1: s.w1.beta1 != null ? { beta0: s.w1.beta0, beta1: s.w1.beta1 } : null,
      })),
      taoReturns: {
        h4: last(tao4hReturns),
        d1: last(taoDailyReturns),
        w1: last(taoWeeklyReturns),
      },
    };

    // ── Write KV (3 keys) ────────────────────────────────────────────────

    await Promise.all([
      env.KV.put("dashboard_state", JSON.stringify(dashboardState)),
      env.KV.put("snapshot_prev", JSON.stringify(snapshot)),
      env.KV.put("price_history", JSON.stringify(history)),
    ]);

    console.log(`[cron] === done — ${subnetResults.length} subnets, ${Date.now() - t0}ms ===`);
    return dashboardState;

  } catch (err) {
    console.error(`[cron] FATAL: ${err.message}`);
    // Mark dashboard as stale but don't overwrite good data
    try {
      const raw = await env.KV.get("dashboard_state");
      if (raw) {
        const state = JSON.parse(raw);
        state.status = "stale";
        state.staleReason = classifyError(err.message);
        await env.KV.put("dashboard_state", JSON.stringify(state));
      }
    } catch (_) { /* best effort */ }
    throw err;
  }
}

// ── Per-timeframe regression ─────────────────────────────────────────────────

/**
 * Compute regression for one (subnet, timeframe) pair.
 *
 * @param {{ time: number, price: number }[]} subnetPrices  chronological
 * @param {(number|null)[]} taoReturns  TAO/USDT returns at matching granularity
 * @param {number} minPoints  minimum price points required
 * @param {{ beta0: number, beta1: number }|null} prevBeta  from snapshot_prev
 * @param {number[]|undefined} prevMapeHistory  from previous dashboard
 * @returns {{ beta0, beta1, r2, accuracy, mapeHistory, windowDays }|null}
 */
function computeTimeframe(subnetPrices, taoReturns, minPoints, prevBeta, prevMapeHistory) {
  if (subnetPrices.length < minPoints) return null;

  const subnetTaoReturns = logReturns(subnetPrices.map(p => p.price));

  // Positional alignment: match lengths from the end
  const len = Math.min(subnetTaoReturns.length, taoReturns.length);
  if (len < 10) return null;

  const subTao = subnetTaoReturns.slice(-len);
  const taoSlice = taoReturns.slice(-len);

  // Convert subnet TAO returns to USDT: subnet_usdt = subnet_tao + tao_usdt
  const subUsdt = subTao.map((r, i) =>
    r != null && taoSlice[i] != null ? r + taoSlice[i] : null
  );

  // X = TAO/USDT return, Y = subnet USDT return
  const reg = linearRegressionPipeline(taoSlice, subUsdt);
  if (!reg) return null;

  // Cross-run accuracy from snapshot_prev
  let accuracy = null;
  const mapeHist = prevMapeHistory ?? [];

  if (prevBeta && taoSlice.length > 0 && subUsdt.length > 0) {
    const latestX = lastNonNull(taoSlice);
    const latestY = lastNonNull(subUsdt);
    if (latestX != null && latestY != null) {
      const yPred = prevBeta.beta0 + prevBeta.beta1 * latestX;
      const smape = symmetricMAPE(yPred, latestY);
      accuracy = Math.max(0, Math.min(1, 1 - smape / 2));
    }
  }

  const mapeHistory = accuracy != null
    ? [...mapeHist, round4(1 - accuracy)].slice(-10)
    : mapeHist;

  const windowDays = historyDays(subnetPrices);

  return {
    beta0: round4(reg.beta0),
    beta1: round4(reg.beta1),
    r2: round4(reg.r2),
    accuracy: accuracy != null ? round4(accuracy) : null,
    mapeHistory,
    windowDays,
  };
}

function nullTimeframe() {
  return { beta0: null, beta1: null, r2: null, accuracy: null, mapeHistory: [], windowDays: 0 };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadJSON(env, key) {
  try {
    const raw = await env.KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Sample every Nth element from the end of a price array.
 * Used for rolling 7-day windows: sampleEveryNth(daily, 7)
 * gives non-overlapping "weekly" prices anchored to today.
 */
function sampleEveryNth(klines, n) {
  const result = [];
  for (let i = klines.length - 1; i >= 0; i -= n) {
    result.unshift(klines[i]);
  }
  return result;
}

/** Round timestamp to nearest 4-hour boundary. */
function roundTo4h(ms) {
  const FOUR_HOURS = 4 * 3600 * 1000;
  return Math.round(ms / FOUR_HOURS) * FOUR_HOURS;
}

/** sMAPE: |pred - actual| / ((|pred| + |actual|) / 2). Returns 0 when both ≈ 0. */
function symmetricMAPE(pred, actual) {
  const denom = (Math.abs(pred) + Math.abs(actual)) / 2;
  if (denom < 1e-10) return 0;
  return Math.abs(pred - actual) / denom;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

function lastNonNull(arr) {
  return last(arr);
}

function classifyError(msg) {
  if (/binance/i.test(msg)) return "Binance API unavailable";
  if (/taostats/i.test(msg)) return "Taostats API unavailable";
  if (/subrequest/i.test(msg)) return "Too many subrequests";
  return "Data calculation error";
}
