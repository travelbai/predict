// Binance Public API client — no API key required.
// Docs: https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data
//
// BASE URL priority:
//   1. BINANCE_BASE_URL env var (set in seed script to use mirror when api.binance.com is blocked)
//   2. https://api.binance.com  (default — always used in the deployed Worker)

const BASE =
  (typeof process !== "undefined" && process.env?.BINANCE_BASE_URL) ||
  "https://api.binance.com";

// Keep retries short — CF Workers have strict wall-clock limits on cron triggers
const RETRY_DELAYS = [2_000, 5_000, 10_000];

/**
 * Fetch klines from Binance.
 *
 * @param {string} symbol   e.g. "BTCUSDT"
 * @param {string} interval e.g. "1w" | "1d" | "4h"
 * @param {number} limit    number of candles (max 1000)
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

async function fetchWithRetry(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      // Cloudflare edge cache — ignored outside Workers
      cf: { cacheTtl: 60 },
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
