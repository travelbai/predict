import { C } from "./constants/colors.js";
import { useDashboard } from "./hooks/useDashboard.js";
import LiveClock from "./components/LiveClock.jsx";
import MacroModule from "./components/MacroModule.jsx";
import SubnetTable from "./components/SubnetTable.jsx";
import StaleBanner from "./components/StaleBanner.jsx";

// Fallback mock — used when Worker API is unreachable in dev
const FALLBACK = {
  status: "ok",
  updatedAt: new Date().toISOString(),
  btcTao: { beta0: 0.42, beta1: 1.85, r2: 0.61, window: "360d / 52w" },
  alphaRangeBtcTao: [-1.0, 1.0],
  alphaRanges: { h4: [-1.5, 2.0], d1: [-0.8, 1.2], w1: [-0.4, 0.6] },
  subnets: [
    { id: 1,   symbol: "APEX",  tvl: 2850000, h4: { beta0: 0.12, beta1: 2.35, r2: 0.72, accuracy: null }, d1: { beta0: 0.18, beta1: 2.10, r2: 0.68, accuracy: null }, w1: { beta0: 0.25, beta1: 1.95, r2: 0.74, accuracy: null } },
    { id: 3,   symbol: "COV",   tvl: 1920000, h4: { beta0: 0.08, beta1: 1.92, r2: 0.65, accuracy: null }, d1: { beta0: 0.15, beta1: 1.78, r2: 0.61, accuracy: null }, w1: { beta0: 0.20, beta1: 1.65, r2: 0.58, accuracy: null } },
    { id: 5,   symbol: "KAITO", tvl: 3400000, h4: { beta0: 0.35, beta1: 1.45, r2: 0.81, accuracy: null }, d1: { beta0: 0.40, beta1: 1.38, r2: 0.77, accuracy: null }, w1: { beta0: 0.48, beta1: 1.30, r2: 0.82, accuracy: null } },
    { id: 9,   symbol: "PRE",   tvl: 780000,  h4: { beta0: -0.05, beta1: 3.10, r2: 0.55, accuracy: null }, d1: { beta0: 0.02, beta1: 2.85, r2: 0.52, accuracy: null }, w1: { beta0: 0.08, beta1: 2.60, r2: 0.49, accuracy: null } },
    { id: 13,  symbol: "DATA",  tvl: 620000,  h4: { beta0: 0.22, beta1: 1.68, r2: 0.44, accuracy: null }, d1: { beta0: 0.28, beta1: 1.55, r2: 0.41, accuracy: null }, w1: { beta0: 0.32, beta1: 1.42, r2: 0.38, accuracy: null } },
    { id: 18,  symbol: "CTX",   tvl: 1150000, h4: { beta0: 0.50, beta1: 1.20, r2: 0.88, accuracy: null }, d1: { beta0: 0.55, beta1: 1.15, r2: 0.85, accuracy: null }, w1: { beta0: 0.60, beta1: 1.08, r2: 0.90, accuracy: null } },
    { id: 21,  symbol: "FTAO",  tvl: 420000,  h4: { beta0: -0.10, beta1: 2.80, r2: 0.38, accuracy: null }, d1: { beta0: -0.05, beta1: 2.55, r2: 0.35, accuracy: null }, w1: { beta0: 0.01, beta1: 2.30, r2: 0.32, accuracy: null } },
    { id: 25,  symbol: "HIVE",  tvl: 950000,  h4: { beta0: 0.18, beta1: 2.48, r2: 0.59, accuracy: null }, d1: { beta0: 0.22, beta1: 2.30, r2: 0.56, accuracy: null }, w1: { beta0: 0.28, beta1: 2.15, r2: 0.53, accuracy: null } },
    { id: 32,  symbol: "IQT",   tvl: 1680000, h4: { beta0: 0.30, beta1: 1.75, r2: 0.70, accuracy: null }, d1: { beta0: 0.35, beta1: 1.62, r2: 0.67, accuracy: null }, w1: { beta0: 0.40, beta1: 1.50, r2: 0.71, accuracy: null } },
    { id: 41,  symbol: "SPORT", tvl: 350000,  h4: { beta0: -0.15, beta1: 3.50, r2: 0.33, accuracy: null }, d1: { beta0: -0.08, beta1: 3.20, r2: 0.30, accuracy: null }, w1: { beta0: 0.00, beta1: 2.90, r2: 0.28, accuracy: null } },
    { id: 56,  symbol: "GRAD",  tvl: 2100000, h4: { beta0: 0.42, beta1: 1.55, r2: 0.76, accuracy: null }, d1: { beta0: 0.48, beta1: 1.42, r2: 0.73, accuracy: null }, w1: { beta0: 0.52, beta1: 1.35, r2: 0.78, accuracy: null } },
    { id: 105, symbol: "BEAM",  tvl: 510000,  h4: { beta0: 0.65, beta1: 1.10, r2: 0.48, accuracy: null }, d1: { beta0: 0.70, beta1: 1.02, r2: 0.45, accuracy: null }, w1: { beta0: 0.75, beta1: 0.95, r2: 0.42, accuracy: null } },
  ],
};

export default function App() {
  const { state, loading, error } = useDashboard();
  const data = state ?? (error ? FALLBACK : null);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "var(--sans)", padding: "16px 20px 60px" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>

        {/* ── Top bar ──────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0 14px", marginBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: C.text, letterSpacing: -0.3 }}>
            Regression Analysis Prediction
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: C.t3 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: C.green }} />
              Live
            </span>
            <LiveClock />
          </div>
        </div>

        {/* ── Stale banner ─────────────────────────────────────── */}
        {data?.status === "stale" && <StaleBanner updatedAt={data.updatedAt} />}

        {/* ── Loading ───────────────────────────────────────────── */}
        {loading && !data && (
          <div style={{ textAlign: "center", padding: "80px 0", color: C.t3, fontSize: 14 }}>
            Loading…
          </div>
        )}

        {/* ── Modules ──────────────────────────────────────────── */}
        {data && (
          <>
            <MacroModule
              btcTao={data.btcTao}
              alphaRange={data.alphaRangeBtcTao}
            />
            <SubnetTable
              subnets={data.subnets}
              alphaRanges={data.alphaRanges}
            />
          </>
        )}

        {/* ── Footer ───────────────────────────────────────────── */}
        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: C.t3 }}>
          All predictions are statistical estimates based on historical regression. Not financial advice. DYOR.
        </div>
      </div>
    </div>
  );
}
