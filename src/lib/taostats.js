// Taostats API client — bulk-first design
//
// Base URL : https://api.taostats.io
// Auth     : Authorization: <key>   (no Bearer prefix)
// Docs     : https://docs.taostats.io

const BASE = "https://api.taostats.io";
const RETRY_DELAYS = [3_000, 10_000, 30_000];

/** Subnets per init-history batch (keeps subrequests under 50). */
export const INIT_BATCH_SIZE = 44;

/** Minimum days of price history before a subnet enters regression. */
export const MIN_HISTORY_DAYS = 14;

// ── Bulk endpoints (regular cron) ────────────────────────────────────────────

/**
 * Fetch ALL pools in one paginated sweep (like TAOFLOW).
 * Returns flat array of pool objects with netuid, price, total_tao, etc.
 *
 * @param {object} env  Worker env bindings
 * @returns {Promise<object[]>}
 */
export async function fetchAllPools(env) {
  return fetchPages(env, "/api/dtao/pool/latest/v1", { limit: 200 }, 3);
}

// ── Per-subnet history (init only) ───────────────────────────────────────────

/**
 * Fetch daily price history for a single subnet (TAO-denominated).
 * Only used by /api/init-history for cold-start backfill.
 *
 * @param {number} netuid
 * @param {number} limit   max candles (e.g. 180)
 * @param {object} env
 * @returns {Promise<{ time: number, price: number, volume: number|null }[]>}
 */
export async function fetchSubnetHistory(netuid, limit, env) {
  const data = await get(
    "/api/dtao/pool/history/v1",
    { netuid, limit, order: "timestamp_desc" },
    env,
  );

  const raw = data.data ?? [];
  return raw
    .map(k => ({
      time: new Date(k.timestamp).getTime(),
      price: parseFloat(k.price),
      volume: k.tao_volume != null ? parseFloat(k.tao_volume) : null,
    }))
    .filter(k => k.price > 0 && k.time > 0)
    .reverse(); // chronological order
}

/**
 * How many calendar days does this price array span?
 */
export function historyDays(candles) {
  if (candles.length < 2) return 0;
  const ms = candles[candles.length - 1].time - candles[0].time;
  return Math.floor(ms / 86_400_000);
}

// ── Paginated fetch (TAOFLOW pattern) ────────────────────────────────────────

async function fetchPages(env, path, params, maxPages) {
  const first = await get(path, { ...params, page: 1 }, env);
  const totalPages = Math.min(first.pagination?.total_pages ?? 1, maxPages);
  if (totalPages <= 1) return first.data ?? [];

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      get(path, { ...params, page: i + 2 }, env).then(r => r.data ?? [])
    )
  );
  return [...(first.data ?? []), ...rest.flat()];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function get(path, params, env, attempt = 0) {
  const apiKey = env?.TAOSTATS_API_KEY ?? "";
  const url = buildUrl(`${BASE}${path}`, params);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: apiKey,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`Taostats HTTP ${res.status} ${path}: ${body.slice(0, 120)}`);
      if (!retryable) throw err;
      throw err;
    }

    return await res.json();
  } catch (err) {
    if (attempt < RETRY_DELAYS.length) {
      console.warn(`[taostats] retry ${attempt + 1} in ${RETRY_DELAYS[attempt] / 1000}s — ${err.message}`);
      await sleep(RETRY_DELAYS[attempt]);
      return get(path, params, env, attempt + 1);
    }
    throw new Error(`[taostats] all retries failed for ${path}: ${err.message}`);
  }
}

function buildUrl(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
