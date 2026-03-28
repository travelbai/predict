/**
 * Pure math utilities for regression pipeline.
 * No external dependencies — runs entirely in Worker memory.
 */

// ── Log returns ───────────────────────────────────────────────────────────────

/**
 * Compute log returns from an array of prices.
 * Returns an array of length (prices.length - 1).
 * Prices of 0 or negative are skipped (pair dropped).
 */
export function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1];
    const p1 = prices[i];
    if (p0 > 0 && p1 > 0) {
      out.push(Math.log(p1 / p0));
    } else {
      out.push(null); // will be dropped in alignment
    }
  }
  return out;
}

// ── Timestamp alignment ───────────────────────────────────────────────────────

/**
 * Align two price series by close-timestamp (Binance kline[6]).
 * Returns { x, y } arrays of equal length with only matched timestamps.
 *
 * @param {{ time: number, price: number }[]} a
 * @param {{ time: number, price: number }[]} b
 */
export function alignByTimestamp(a, b) {
  const mapB = new Map(b.map(d => [d.time, d.price]));
  const x = [], y = [];
  for (const d of a) {
    if (mapB.has(d.time)) {
      x.push(d.price);
      y.push(mapB.get(d.time));
    }
  }
  return { x, y };
}

// ── IQR outlier filter ────────────────────────────────────────────────────────

/**
 * Remove paired (xi, yi) observations where either xi or yi is an outlier
 * by the 1.5×IQR rule. Null values are always dropped.
 *
 * @param {(number|null)[]} xArr
 * @param {(number|null)[]} yArr
 * @returns {{ x: number[], y: number[] }}
 */
export function iqrFilter(xArr, yArr) {
  // Drop nulls first
  const pairs = xArr
    .map((x, i) => [x, yArr[i]])
    .filter(([x, y]) => x !== null && y !== null);

  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);

  const [xLo, xHi] = iqrBounds(xs);
  const [yLo, yHi] = iqrBounds(ys);

  const x = [], y = [];
  for (let i = 0; i < pairs.length; i++) {
    if (
      xs[i] >= xLo && xs[i] <= xHi &&
      ys[i] >= yLo && ys[i] <= yHi
    ) {
      x.push(xs[i]);
      y.push(ys[i]);
    }
  }
  return { x, y };
}

function iqrBounds(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  return [q1 - 1.5 * iqr, q3 + 1.5 * iqr];
}

// ── Percentile ────────────────────────────────────────────────────────────────

/**
 * Compute a percentile from a pre-sorted array using linear interpolation.
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Return [p5, p95] of an array of values (unsorted input ok).
 */
export function percentileRange(values, p1 = 5, p2 = 95) {
  if (values.length === 0) return [0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  return [percentile(sorted, p1), percentile(sorted, p2)];
}

// ── OLS Linear Regression ─────────────────────────────────────────────────────

/**
 * Ordinary least squares: Y = β₀ + β₁X
 * Returns { beta0, beta1, r2 }.
 * Division-by-zero protection: if Σ(Xi-X̄)² < 1e-10, returns all zeros.
 *
 * @param {number[]} x
 * @param {number[]} y
 */
export function linearRegression(x, y) {
  const n = x.length;
  if (n < 2) return { beta0: 0, beta1: 0, r2: 0 };

  const xMean = mean(x);
  const yMean = mean(y);

  let ssXX = 0, ssXY = 0, ssYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - xMean;
    const dy = y[i] - yMean;
    ssXX += dx * dx;
    ssXY += dx * dy;
    ssYY += dy * dy;
  }

  // Division-by-zero guard
  if (ssXX < 1e-10) return { beta0: 0, beta1: 0, r2: 0 };

  const beta1 = ssXY / ssXX;
  const beta0 = yMean - beta1 * xMean;

  // Residual sum of squares
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = beta0 + beta1 * x[i];
    const residual = y[i] - predicted;
    ssRes += residual * residual;
  }

  const r2 = ssYY < 1e-10 ? 0 : Math.max(0, 1 - ssRes / ssYY);

  return { beta0, beta1, r2 };
}

/**
 * Full pipeline: IQR filter → OLS regression.
 * Returns null if fewer than 5 clean samples remain.
 */
export function linearRegressionPipeline(xArr, yArr) {
  const { x, y } = iqrFilter(xArr, yArr);
  if (x.length < 10) return null;
  return { ...linearRegression(x, y), sampleCount: x.length, accuracy: holdoutAccuracy(x, y) };
}

// ── Weekly aggregation ────────────────────────────────────────────────────────

/**
 * Aggregate daily klines to weekly by grouping every 7 candles
 * and taking the last close (Friday or last trading day of week).
 *
 * @param {{ time: number, price: number }[]} daily
 */
export function aggregateToWeekly(daily) {
  const weeks = [];
  for (let i = 6; i < daily.length; i += 7) {
    weeks.push(daily[i]);
  }
  return weeks;
}

// ── 4H → Daily aggregation ───────────────────────────────────────────────────

/**
 * Aggregate 4H klines to daily by grouping candles into UTC calendar days
 * and taking the last close price of each day.
 *
 * Binance 4H bars use closeTime (k[6]) as the `time` field.
 * We assign each bar to the UTC date of its close timestamp.
 *
 * @param {{ time: number, price: number }[]} klines4h  chronological
 * @returns {{ time: number, price: number }[]}  one entry per calendar day
 */
export function aggregateToDaily(klines4h) {
  const byDay = new Map(); // "YYYY-MM-DD" → { time, price }
  for (const k of klines4h) {
    const day = new Date(k.time).toISOString().slice(0, 10);
    byDay.set(day, k); // later bars overwrite earlier ones → last close of day
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

// ── Holdout Accuracy ─────────────────────────────────────────────────────────

/**
 * Compute hold-out accuracy by splitting (x, y) into an 80% train / 20% test
 * partition. Fits OLS on the training set, then measures mean MAPE on the
 * test set. Returns null when the test set has fewer than 3 usable points.
 *
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number|null}  value in [0, 1]
 */
export function holdoutAccuracy(x, y) {
  const n = x.length;
  if (n < 10) return null;

  const trainEnd = Math.floor(n * 0.8);
  const xTrain = x.slice(0, trainEnd);
  const yTrain = y.slice(0, trainEnd);
  const xTest  = x.slice(trainEnd);
  const yTest  = y.slice(trainEnd);

  const { beta0, beta1 } = linearRegression(xTrain, yTrain);

  // Holdout R²: fraction of test-set variance explained by the model
  const yMean = mean(yTest);
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < xTest.length; i++) {
    const yPred = beta0 + beta1 * xTest[i];
    ssRes += (yTest[i] - yPred) ** 2;
    ssTot += (yTest[i] - yMean) ** 2;
  }

  // Log-returns are small numbers; use relative threshold instead of absolute
  if (ssTot === 0) return null;
  return Math.max(0, 1 - ssRes / ssTot);
}

// ── Adaptive window ───────────────────────────────────────────────────────────

/**
 * Adjust regression window based on recent MAPE trend.
 *
 * Rules (require ≥5 entries in mapeHistory):
 *   - All 5 strictly increasing → shrink by 20%
 *   - All 5 below MAPE_LOW (0.15)  → grow by 10%
 *   - Otherwise → unchanged
 *
 * @param {number[]|undefined} mapeHistory  recent MAPE values, oldest first
 * @param {number} currentWindow  current window in days
 * @param {number} min  minimum window (days)
 * @param {number} max  maximum window (days)
 * @returns {number}  new window in days (integer)
 */
export function adaptiveWindow(mapeHistory, currentWindow, min, max) {
  if (!mapeHistory || mapeHistory.length < 5) return currentWindow;
  const recent = mapeHistory.slice(-5);

  const isRising = recent.every((v, i) => i === 0 || v > recent[i - 1]);
  if (isRising) return Math.max(min, Math.round(currentWindow * 0.8));

  const MAPE_LOW = 0.15;
  const isStable = recent.every(v => v < MAPE_LOW);
  if (isStable) return Math.min(max, Math.round(currentWindow * 1.1));

  return currentWindow;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Symmetric MAPE: |pred - actual| / ((|pred| + |actual|) / 2)
 * Returns 0 when both are zero (perfect prediction), range [0, 2].
 */
function symmetricMAPE(pred, actual) {
  const denom = (Math.abs(pred) + Math.abs(actual)) / 2;
  if (denom < 1e-10) return 0; // both ≈ 0 → perfect
  return Math.abs(pred - actual) / denom;
}

/**
 * Zero-volume ratio: fraction of candles with volume === 0.
 */
export function zeroVolumeRatio(klines) {
  if (klines.length === 0) return 1;
  const zeros = klines.filter(k => k.volume === 0).length;
  return zeros / klines.length;
}
