# Regression Analysis Prediction

A Bittensor ecosystem dashboard that quantifies price correlations between **$BTC → $TAO** and **$TAO → Subnet tokens** via linear regression, giving users an interactive sandbox for scenario analysis.

## Overview

- **Frontend**: React + Vite → deployed to Cloudflare Pages
- **Backend**: Cloudflare Worker (two Cron triggers)
- **Storage**: Cloudflare KV (single JSON blob: `dashboard_state.json`)
- **Data Sources**: Binance Public API (BTC/TAO prices) + Taostats API (subnet AMM pool data)

## Architecture

```
Binance API ──────────────────► Cloudflare Worker ──► KV Store ──► Cloudflare Pages (React)
Taostats API ─────────────────►    (Cron 1 + 2)        (JSON)       frontend read-only
```

All regression computation happens inside the Worker. The frontend only performs `Y = β₀ + β₁ × X` locally per slider interaction — zero matrix operations in the browser.

## Project Structure

```
predict/
├── src/
│   └── index.js          # Cloudflare Worker (API + Cron handlers)
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── components/   # MacroModule, SubnetTable, Slider, Gauge, Clock
│   │   ├── hooks/        # useDashboard (data fetching)
│   │   └── constants/    # colors, mock data
│   ├── index.html
│   └── vite.config.js
├── wrangler.toml
└── package.json
```

## Cron Schedule

| Trigger | Frequency | What it computes |
|---------|-----------|-----------------|
| Cron 1 | Daily 00:00 UTC | BTC↔TAO macro regression (52w) + TAO↔Subnet 24H & 1W regressions |
| Cron 2 | Every 4 hours | TAO↔Subnet 4H regression (30-day window) |

Each run writes one `dashboard_state.json` to KV. If all retries fail, the old snapshot is preserved with `status: "stale"`.

## KV Data Schema

```json
{
  "version": 1,
  "updatedAt": "2026-03-21T00:00:00Z",
  "status": "ok",
  "btcTao": { "beta0": 0.42, "beta1": 1.85, "r2": 0.61, "windowDays": 360 },
  "subnets": [
    {
      "id": 1, "symbol": "APEX", "tvl": 2850000,
      "h4": { "beta0": 0.12, "beta1": 2.35, "r2": 0.72 },
      "d1": { "beta0": 0.18, "beta1": 2.10, "r2": 0.68 },
      "w1": { "beta0": 0.25, "beta1": 1.95, "r2": 0.74 }
    }
  ]
}
```

## Getting Started

### Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- Cloudflare account (free tier is sufficient)

### 1. Clone & install

```bash
git clone https://github.com/travelbai/predict.git
cd predict
npm install             # Worker dependencies
cd frontend && npm install
```

### 2. Create KV namespace

```bash
# Create production namespace
wrangler kv:namespace create PREDICT_KV

# Create preview namespace (for local dev)
wrangler kv:namespace create PREDICT_KV --preview
```

Copy the generated IDs into `wrangler.toml` (replace the placeholders).

### 3. Run locally

Open **two terminals**:

```bash
# Terminal 1 — Worker (port 8787)
npm run dev

# Terminal 2 — Frontend (port 5173)
cd frontend && npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

> **Windows ARM64 note**: `wrangler dev` requires `workerd`, which does not support `win32 arm64` yet.
> On Windows ARM, run only the frontend (`cd frontend && npm run dev`) — it will serve mock data via the built-in fallback.
> To test the full Worker locally, use WSL2 (Ubuntu) or deploy directly to Cloudflare.

### 4. Seed local KV (optional)

```bash
wrangler kv:key put --binding KV --local dashboard_state "$(cat src/mock/dashboard_state.json)"
```

## Deployment

The project deploys automatically via Cloudflare:

- **Worker**: push to `main` → Wrangler CI deploys the Worker
- **Pages**: connect the `frontend/` directory in Cloudflare Pages dashboard
  - Build command: `npm run build`
  - Build output: `dist`

Set environment variables in the Cloudflare dashboard (Worker settings):
- `TAOSTATS_API_KEY` — your Taostats API key

## Risk Disclaimers

All predictions are statistical estimates based on historical regression. Not financial advice. Low-liquidity subnets (TVL < $500K) are flagged and hidden by default. R² < 0.3 subnets are shown at reduced opacity. DYOR.
