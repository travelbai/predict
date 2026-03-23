import { C } from "./constants/colors.js";
import { useDashboard } from "./hooks/useDashboard.js";
import LiveClock from "./components/LiveClock.jsx";
import MacroModule from "./components/MacroModule.jsx";
import SubnetTable from "./components/SubnetTable.jsx";
import StaleBanner from "./components/StaleBanner.jsx";

export default function App() {
  const { state, loading, error } = useDashboard();
  const data = state;

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
        {loading && (
          <div style={{ textAlign: "center", padding: "80px 0", color: C.t3, fontSize: 14 }}>
            Loading…
          </div>
        )}

        {/* ── Error ─────────────────────────────────────────────── */}
        {error && !loading && (
          <div style={{ textAlign: "center", padding: "80px 0", color: C.t3, fontSize: 14 }}>
            Unable to load data. Please try again later.
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
