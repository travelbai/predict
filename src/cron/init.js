/**
 * Cold-start history initializer — /api/init-history
 *
 * Each visit fetches ~44 subnet histories from Taostats /history/ endpoint,
 * writes them into KV price_history, then increments init_batch_index.
 * 3 visits covers all ~128 subnets. After that, returns "already initialized".
 *
 * Subrequest budget per visit: 2 (pool list) + 44 (histories) = 46, under 50.
 */

import {
  fetchAllPools,
  fetchSubnetHistory,
  historyDays,
  INIT_BATCH_SIZE,
  MIN_HISTORY_DAYS,
} from "../lib/taostats.js";
import { zeroVolumeRatio } from "../lib/math.js";

/** Max zero-volume ratio before a subnet is excluded. */
const MAX_ZERO_VOLUME = 0.15;

/**
 * Run one batch of history initialization.
 * Returns a JSON-serializable status object.
 */
export async function runInitHistory(env) {
  // Read current batch index
  const batchIndex = parseInt(await env.KV.get("init_batch_index") ?? "0", 10);

  // Fetch pool list to know all subnets (1-2 subrequests)
  const pools = await fetchAllPools(env);
  const eligible = pools
    .filter(p => p.netuid != null && p.netuid !== 0)
    .sort((a, b) => {
      const tvlA = Number(a.total_tao ?? 0);
      const tvlB = Number(b.total_tao ?? 0);
      return tvlB - tvlA; // highest TVL first
    });

  const totalSubnets = eligible.length;
  const totalBatches = Math.ceil(totalSubnets / INIT_BATCH_SIZE);

  if (batchIndex >= totalBatches) {
    return {
      status: "already_initialized",
      message: `All ${totalSubnets} subnets initialized in ${totalBatches} batches.`,
      totalSubnets,
      totalBatches,
    };
  }

  // Slice this batch
  const start = batchIndex * INIT_BATCH_SIZE;
  const end = Math.min(start + INIT_BATCH_SIZE, totalSubnets);
  const batch = eligible.slice(start, end);

  // Read existing price_history
  const historyRaw = await env.KV.get("price_history");
  const history = historyRaw ? JSON.parse(historyRaw) : { subnets: {} };

  // Fetch histories in parallel (up to 44 subrequests)
  const results = await Promise.allSettled(
    batch.map(pool =>
      fetchSubnetHistory(pool.netuid, 180, env)
        .then(candles => ({ netuid: pool.netuid, candles, error: null }))
        .catch(err => ({ netuid: pool.netuid, candles: [], error: err.message }))
    )
  );

  let initialized = 0;
  let skipped = 0;
  const errors = [];

  for (const result of results) {
    const { netuid, candles, error } = result.status === "fulfilled"
      ? result.value
      : { netuid: null, candles: [], error: result.reason?.message ?? "unknown" };

    if (error) {
      errors.push({ netuid, error });
      continue;
    }

    if (candles.length === 0) {
      skipped++;
      continue;
    }

    // Zero-volume check: skip subnets with >15% zero-volume candles
    const volumeCandles = candles.filter(c => c.volume != null);
    if (volumeCandles.length > 0 && zeroVolumeRatio(volumeCandles) > MAX_ZERO_VOLUME) {
      console.log(`[init] SN${netuid}: skipped — zero-volume ratio > ${MAX_ZERO_VOLUME * 100}%`);
      skipped++;
      continue;
    }

    // Store as simple {time, price} — no volume needed for regression
    const id = String(netuid);
    history.subnets[id] = candles.map(c => ({ time: c.time, price: c.price }));
    initialized++;
  }

  history.lastUpdated = new Date().toISOString();

  // Write back
  await Promise.all([
    env.KV.put("price_history", JSON.stringify(history)),
    env.KV.put("init_batch_index", String(batchIndex + 1)),
  ]);

  const progress = `${end}/${totalSubnets}`;
  console.log(`[init] batch ${batchIndex + 1}/${totalBatches} done — ${initialized} initialized, ${skipped} skipped, ${errors.length} errors`);

  return {
    status: "batch_done",
    batch: batchIndex + 1,
    totalBatches,
    subnetsProcessed: end,
    totalSubnets,
    initialized,
    skipped,
    errors: errors.length,
    errorDetails: errors.slice(0, 5), // cap detail output
    message: `Batch ${batchIndex + 1}/${totalBatches} done (${progress} subnets). ${initialized} initialized, ${skipped} skipped.`,
  };
}
