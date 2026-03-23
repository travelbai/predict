/**
 * Binance Public API client.
 * No API key required — klines endpoint is public.
 *
 * Docs: https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data
 */

// data-api.binance.vision is the globally-accessible mirror of api.binance.com
const BASE = "https://data-api.binance.vision";

// Retry delays in ms (1min, 5min, 15min)
const RETRY_DELAYS = [60_000, 300_000, 900_000];

/**
 * Fetch klines from Binance.
 *
 * @param {string} symbol  e.g. "BTCUSDT"
 * @param {string} interval e.g. "1w" | "1d" | "4h"
 * @param {number} limit   number of candles (max 1000)
 * @returns {{ time: number, price: number, volume: number }[]}
 */
export async function fetchBinanceKlines(symbol, interval, limit) {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await fetchWithRetry(url);

  // Each element: [openTime, open, high, low, close, volume, closeTime, ...]
  return raw.map(k => ({
    time: k[6],               // close timestamp (ms) — used for alignment
    price: parseFloat(k[4]), // close price
    volume: parseFloat(k[5]),
  }));
}

// ── Retry logic ───────────────────────────────────────────────────────────────

async function fetchWithRetry(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: 60 }, // Cloudflare edge cache 1 min
    });

    if (!res.ok) {
      throw new Error(`Binance HTTP ${res.status}: ${url}`);
    }

    return await res.json();
  } catch (err) {
    if (attempt < RETRY_DELAYS.length) {
      console.warn(`[binance] retry ${attempt + 1} in ${RETRY_DELAYS[attempt] / 1000}s — ${err.message}`);
      await sleep(RETRY_DELAYS[attempt]);
      return fetchWithRetry(url, attempt + 1);
    }
    throw new Error(`[binance] all retries failed: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
