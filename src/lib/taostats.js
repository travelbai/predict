// Taostats API client
//
// Base URL : https://api.taostats.io
// Auth     : Authorization: <key>   (no Bearer prefix)
// Docs     : https://docs.taostats.io

const BASE = "https://api.taostats.io";
const RETRY_DELAYS = [60_000, 300_000, 900_000];

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
export async function fetchEligibleSubnets(env) {
  const data = await get("/api/dtao/pool/v1", { limit: 200 }, env);
  const subnets = data.data ?? [];

  return subnets
    .filter(s => s.netuid !== 0) // skip root subnet
    .map(s => ({
      id: s.netuid,
      symbol: (s.name || `SN${s.netuid}`).trim(),
      name: s.name || `SN${s.netuid}`,
      // total_tao is in rao (1 TAO = 1e9 rao)
      tvlTao: Number(s.total_tao) / 1e9,
      // Use history size as proxy for registration age (checked after fetching history)
      regDays: null,
    }));
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

  const candles = (data.data ?? [])
    .map(k => ({
      time: new Date(k.timestamp).getTime(),
      price: parseFloat(k.price),
      // tao_volume is the TAO traded in this period; fall back to null if absent
      volume: k.tao_volume != null ? parseFloat(k.tao_volume) : (k.volume != null ? parseFloat(k.volume) : null),
    }))
    .filter(k => k.price > 0 && k.time > 0);

  // Reverse to chronological order
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
      throw new Error(`Taostats HTTP ${res.status} ${path}: ${body.slice(0, 120)}`);
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
