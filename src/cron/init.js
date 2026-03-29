/**
 * Cold-start history initializer — /api/init-history
 *
 * Taostats rate limit: 5 requests/minute.
 * Strategy:
 *   - Cache pool list in KV (0 API calls after first visit)
 *   - Fetch 5 subnet histories per visit (within burst limit)
 *   - Browser auto-refreshes every 65s (rate window resets)
 *   - ~26 visits × 65s ≈ 28 minutes, fully automatic
 *
 * Subrequest budget per visit: 0-2 (pool cache) + 5 (histories) ≤ 7, well under 50.
 * Wall-clock: <5s per visit, well under free-plan 30s limit.
 */

import {
  fetchAllPoolsCached,
  fetchSubnetHistory,
  INIT_BATCH_SIZE,
} from "../lib/taostats.js";
import { zeroVolumeRatio } from "../lib/math.js";

const MAX_ZERO_VOLUME = 0.15;

/**
 * Process one micro-batch of subnet history initialization.
 * Returns a result object with progress info.
 */
export async function runInitHistory(env) {
  const batchIndex = parseInt(await env.KV.get("init_batch_index") ?? "0", 10);

  // Pool list from cache (0 API calls) or fresh (2 API calls, then cached 1h)
  const pools = await fetchAllPoolsCached(env);
  const eligible = pools
    .filter(p => p.netuid != null && p.netuid !== 0)
    .sort((a, b) => Number(b.total_tao ?? 0) - Number(a.total_tao ?? 0));

  const totalSubnets = eligible.length;
  const totalBatches = Math.ceil(totalSubnets / INIT_BATCH_SIZE);

  if (batchIndex >= totalBatches) {
    return { done: true, totalSubnets, totalBatches };
  }

  // Slice this micro-batch (5 subnets)
  const start = batchIndex * INIT_BATCH_SIZE;
  const end = Math.min(start + INIT_BATCH_SIZE, totalSubnets);
  const batch = eligible.slice(start, end);

  // Read existing price_history
  const historyRaw = await env.KV.get("price_history");
  const history = historyRaw ? JSON.parse(historyRaw) : { subnets: {} };

  let initialized = 0;
  let skipped = 0;
  const errors = [];

  // Fire all 5 in parallel (burst within rate limit)
  const results = await Promise.allSettled(
    batch.map(pool =>
      fetchSubnetHistory(pool.netuid, 180, env)
        .then(candles => ({ netuid: pool.netuid, candles, error: null }))
        .catch(err => ({ netuid: pool.netuid, candles: [], error: err.message }))
    )
  );

  for (const result of results) {
    const { netuid, candles, error } = result.status === "fulfilled"
      ? result.value
      : { netuid: null, candles: [], error: result.reason?.message ?? "unknown" };

    if (error) {
      errors.push({ netuid, error });
      continue;
    }
    if (candles.length === 0) { skipped++; continue; }

    const volumeCandles = candles.filter(c => c.volume != null);
    if (volumeCandles.length > 0 && zeroVolumeRatio(volumeCandles) > MAX_ZERO_VOLUME) {
      skipped++;
      continue;
    }

    history.subnets[String(netuid)] = candles.map(c => ({ time: c.time, price: c.price }));
    initialized++;
  }

  history.lastUpdated = new Date().toISOString();

  await Promise.all([
    env.KV.put("price_history", JSON.stringify(history)),
    env.KV.put("init_batch_index", String(batchIndex + 1)),
  ]);

  return {
    done: false,
    batch: batchIndex + 1,
    totalBatches,
    subnetsProcessed: end,
    totalSubnets,
    initialized,
    skipped,
    errors: errors.length,
  };
}
