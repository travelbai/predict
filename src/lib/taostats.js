// Taostats API client
//
// Base URL : https://api.taostats.io
// Auth     : Authorization: <key>   (no Bearer prefix)
// Docs     : https://docs.taostats.io

const BASE = "https://api.taostats.io";
const RETRY_DELAYS = [3_000, 8_000, 20_000];

// Subnet admission: at least 14 days of price history
const MIN_HISTORY_DAYS = 14;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all active subnets and return those with sufficient history.
 * TVL is returned in TAO (total_tao / 1e9).
 *
 * @param {object} env  Worker env bindings (needs env.TAOSTATS_API_KEY)
 * @returns {{ id, symbol, name, tvlTao, regDays }[]}
 */
// Subnets per batch — keeps subrequests under Cloudflare's 50-per-invocation cap.
// Budget per batch: 3 Binance + 1 pool list + 1 identity + 44 histories = 49 total.
export const BATCH_SIZE = 44;

export async function fetchEligibleSubnets(env) {
  // Fetch pool data and subnet identities in parallel
  const [poolData, identityData] = await Promise.all([
    get("/api/dtao/pool/v1", { limit: 256 }, env),
    get("/api/subnet/identity/v1", { limit: 256 }, env).catch(err => {
      console.warn(`[taostats] identity fetch failed, using pool names: ${err.message}`);
      return { data: [] };
    }),
  ]);

  // Build netuid → identity map for name/symbol lookup
  const identityMap = new Map();
  for (const s of (identityData.data ?? [])) {
    const id = s.netuid ?? s.subnet_id;
    if (id != null) {
      identityMap.set(id, {
        name: s.subnet_name || s.name || "",
        symbol: s.token_symbol || s.symbol || "",
      });
    }
  }

  const subnets = poolData.data ?? [];

  return subnets
    .filter(s => s.netuid !== 0) // skip root subnet
    .map(s => {
      const identity = identityMap.get(s.netuid);
      // Prefer identity API names, fall back to pool data, then generic
      const name = identity?.name || s.subnet_name || s.name || `SN${s.netuid}`;
      const symbol = identity?.symbol || s.token_symbol || s.symbol || name;
      return {
        id: s.netuid,
        symbol: symbol.trim(),
        name: name.trim(),
        tvlTao: Number(s.total_tao) / 1e9,
        regDays: null,
      };
    })
    .sort((a, b) => b.tvlTao - a.tvlTao);
}

/**
 * Fetch daily price history for a subnet (TAO-denominated).
 * Returns newest-first; we reverse to get chronological order.
 *
 * @param {number} netuid
 * @param {number} limit   max candles to fetch (e.g. 180 for daily cron)
 * @param {object} env
 * @returns {{ time: number, price: number }[]}  chronological order
 */
export async function fetchSubnetHistory(netuid, limit, env) {
  const data = await get(
    "/api/dtao/pool/history/v1",
    { netuid, limit, order: "timestamp_desc" },
    env,
  );

  const raw = data.data ?? [];
  const candles = raw
    .map(k => ({
      time: new Date(k.timestamp).getTime(),
      price: parseFloat(k.price),
      volume: k.tao_volume != null ? parseFloat(k.tao_volume) : (k.volume != null ? parseFloat(k.volume) : null),
    }))
    .filter(k => k.price > 0 && k.time > 0);

  const dropped = raw.length - candles.length;
  if (dropped > 0) {
    console.warn(`[taostats] SN${netuid}: dropped ${dropped}/${raw.length} invalid candles`);
  }

  candles.reverse();
  return candles;
}

/**
 * How many days of history does this subnet have?
 * Used as the regDays gate (must be >= MIN_HISTORY_DAYS).
 */
export function historyDays(candles) {
  if (candles.length < 2) return 0;
  const ms = candles[candles.length - 1].time - candles[0].time;
  return Math.floor(ms / 86_400_000);
}

export { MIN_HISTORY_DAYS };

// ── Internal helpers ──────────────────────────────────────────────────────────

async function get(path, params, env, attempt = 0) {
  const apiKey = env?.TAOSTATS_API_KEY ?? "";
  const url = buildUrl(`${BASE}${path}`, params);

  try {
    const res = await fetch(url, {
      headers: {
        // Taostats requires raw key — no Bearer prefix
        "Authorization": apiKey,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`Taostats HTTP ${res.status} ${path}: ${body.slice(0, 120)}`);
      if (!retryable) throw err; // 4xx (except 429) — fail fast, no retry
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
