/**
 * Cold-start history initializer — /api/init-history
 *
 * Taostats rate limit: 5 requests/minute.
 * Strategy: sequential processing, 1 subnet at a time, 13s delay between each.
 * Runs in background via ctx.waitUntil() — returns immediately.
 *
 * Each visit processes ~20 subnets (~5 minutes in background).
 * Total: ceil(128/20) ≈ 7 visits, each ~5 min apart.
 */

import {
  fetchAllPools,
  fetchSubnetHistory,
  INIT_BATCH_SIZE,
} from "../lib/taostats.js";
import { zeroVolumeRatio } from "../lib/math.js";

/** Max zero-volume ratio before a subnet is excluded. */
const MAX_ZERO_VOLUME = 0.15;

/** Delay between Taostats history requests (13s ≈ under 5/min). */
const REQUEST_DELAY_MS = 13_000;

/**
 * Run one batch of history initialization (background).
 * Processes subnets one-by-one with rate-limit delays.
 */
export async function runInitHistory(env) {
  const batchIndex = parseInt(await env.KV.get("init_batch_index") ?? "0", 10);

  // Fetch pool list (1-2 subrequests) — counts toward rate limit
  const pools = await fetchAllPools(env);
  const eligible = pools
    .filter(p => p.netuid != null && p.netuid !== 0)
    .sort((a, b) => Number(b.total_tao ?? 0) - Number(a.total_tao ?? 0));

  const totalSubnets = eligible.length;
  const totalBatches = Math.ceil(totalSubnets / INIT_BATCH_SIZE);

  if (batchIndex >= totalBatches) {
    return {
      status: "already_initialized",
      message: `All ${totalSubnets} subnets initialized in ${totalBatches} batches.`,
    };
  }

  // Slice this batch
  const start = batchIndex * INIT_BATCH_SIZE;
  const end = Math.min(start + INIT_BATCH_SIZE, totalSubnets);
  const batch = eligible.slice(start, end);

  // Read existing price_history
  const historyRaw = await env.KV.get("price_history");
  const history = historyRaw ? JSON.parse(historyRaw) : { subnets: {} };

  let initialized = 0;
  let skipped = 0;
  const errors = [];

  // Wait 13s after pool list fetch to respect rate limit
  await sleep(REQUEST_DELAY_MS);

  // Process ONE subnet at a time with 13s delay between each
  for (let i = 0; i < batch.length; i++) {
    const pool = batch[i];
    const netuid = pool.netuid;

    try {
      const candles = await fetchSubnetHistory(netuid, 180, env);

      if (candles.length === 0) {
        skipped++;
      } else {
        // Zero-volume check
        const volumeCandles = candles.filter(c => c.volume != null);
        if (volumeCandles.length > 0 && zeroVolumeRatio(volumeCandles) > MAX_ZERO_VOLUME) {
          console.log(`[init] SN${netuid}: skipped — high zero-volume ratio`);
          skipped++;
        } else {
          history.subnets[String(netuid)] = candles.map(c => ({ time: c.time, price: c.price }));
          initialized++;
          console.log(`[init] SN${netuid}: ${candles.length} candles ✓`);
        }
      }
    } catch (err) {
      console.error(`[init] SN${netuid}: ${err.message}`);
      errors.push({ netuid, error: err.message });
    }

    // Rate-limit delay (skip after last item)
    if (i < batch.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  history.lastUpdated = new Date().toISOString();

  // Write back
  await Promise.all([
    env.KV.put("price_history", JSON.stringify(history)),
    env.KV.put("init_batch_index", String(batchIndex + 1)),
  ]);

  console.log(`[init] batch ${batchIndex + 1}/${totalBatches} done — ${initialized} ok, ${skipped} skipped, ${errors.length} errors`);

  // Write a progress marker so /api/init-history?status=1 can read it
  await env.KV.put("init_progress", JSON.stringify({
    batch: batchIndex + 1,
    totalBatches,
    subnetsProcessed: end,
    totalSubnets,
    initialized,
    skipped,
    errors: errors.length,
    completedAt: new Date().toISOString(),
  }));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
