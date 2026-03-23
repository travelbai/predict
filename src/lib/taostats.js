/**
 * Taostats API client.
 *
 * Base URL: https://api.taostats.io
 * Authentication: Bearer token via env.TAOSTATS_API_KEY
 *
 * Endpoints used:
 *   GET /api/subnet/v1                          — list all subnets
 *   GET /api/dtao/pool/history/v1?netuid=N&...  — subnet AMM pool OHLCV history
 *
 * ⚠ Verify endpoint paths against the current Taostats API docs before deploy:
 *   https://docs.taostats.io
 */

const BASE = "https://api.taostats.io";
const RETRY_DELAYS = [60_000, 300_000, 900_000];

// Subnet admission thresholds
const MIN_REG_DAYS = 14;
const MAX_ZERO_VOLUME_RATIO = 0.15;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch all subnets and return only those meeting admission criteria.
 *
 * @param {object} env   Cloudflare Worker env bindings
 * @returns {{ id: number, symbol: string, name: string, tvl: number, regDays: number }[]}
 */
export async function fetchEligibleSubnets(env) {
  const data = await taostatsGet("/api/subnet/v1", {}, env);

  // Taostats returns an array of subnet objects
  const subnets = Array.isArray(data) ? data : (data.data ?? data.subnets ?? []);

  return subnets
    .map(s => ({
      id: s.netuid ?? s.id,
      symbol: (s.symbol ?? s.name ?? `SN${s.netuid}`).toUpperCase(),
      name: s.name ?? `SN${s.netuid}`,
      // TVL in USD from the primary AMM pool
      tvl: parseFloat(s.pool_tvl ?? s.tvl ?? 0),
      // Days since registration
      regDays: s.reg_days ?? daysSince(s.registered_at ?? s.created_at),
    }))
    .filter(s => s.regDays >= MIN_REG_DAYS);
}

/**
 * Fetch OHLCV kline history for a subnet from the Taostats AMM pool endpoint.
 * Prices are in TAO (dTAO AMM pool, TAO as quote asset).
 *
 * @param {number} netuid
 * @param {"4h"|"1d"} interval
 * @param {number} limit   number of candles
 * @param {object} env
 * @returns {{ time: number, price: number, volume: number }[]}
 */
export async function fetchSubnetKlines(netuid, interval, limit, env) {
  // Taostats pool history endpoint — adjust path if API version changes
  const params = {
    netuid,
    interval,
    limit,
  };

  const data = await taostatsGet("/api/dtao/pool/history/v1", params, env);
  const klines = Array.isArray(data) ? data : (data.data ?? data.history ?? []);

  return klines
    .map(k => ({
      // Accept either Unix seconds or ms timestamps
      time: normalizeTimestamp(k.timestamp ?? k.close_time ?? k.time),
      price: parseFloat(k.close ?? k.price ?? 0),
      volume: parseFloat(k.volume ?? 0),
    }))
    .filter(k => k.price > 0)
    .sort((a, b) => a.time - b.time);
}

/**
 * Check if a kline array exceeds the zero-volume ratio threshold.
 * Returns true if the subnet should be excluded.
 */
export function isTooThinlyTraded(klines) {
  if (klines.length === 0) return true;
  const zeros = klines.filter(k => k.volume === 0).length;
  return zeros / klines.length > MAX_ZERO_VOLUME_RATIO;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function taostatsGet(path, params, env, attempt = 0) {
  const apiKey = env.TAOSTATS_API_KEY ?? "";
  const url = buildUrl(`${BASE}${path}`, params);

  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Taostats HTTP ${res.status}: ${path}`);
    }

    return await res.json();
  } catch (err) {
    if (attempt < RETRY_DELAYS.length) {
      console.warn(`[taostats] retry ${attempt + 1} in ${RETRY_DELAYS[attempt] / 1000}s — ${err.message}`);
      await sleep(RETRY_DELAYS[attempt]);
      return taostatsGet(path, params, env, attempt + 1);
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

function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function normalizeTimestamp(ts) {
  if (!ts) return 0;
  const n = Number(ts);
  // If timestamp is in seconds (< year 2100 in ms = 4102444800000), convert to ms
  return n < 1e12 ? n * 1000 : n;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
