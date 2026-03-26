import { useState, useMemo } from "react";
import { C } from "../constants/colors.js";
import PredictionSlider from "./PredictionSlider.jsx";

const PERIODS = ["4H", "24H", "1W"];
const PK = { "4H": "h4", "24H": "d1", "1W": "w1" };
const fmt = (n, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d) + "%";

function r2Color(r2) {
  if (r2 > 0.5) return C.green;
  if (r2 >= 0.3) return C.yellow;
  return C.gray;
}

function accuracyColor(acc) {
  if (acc === null || acc === undefined) return C.t3;
  if (acc > 0.9) return C.green;
  if (acc >= 0.7) return C.yellow;
  return C.red;
}

function TH({ label, sortKey, currentSort, onSort, left }) {
  const active = currentSort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        padding: "12px 14px",
        textAlign: left ? "left" : "center",
        verticalAlign: "middle",
        cursor: "pointer",
        userSelect: "none",
        fontSize: 11,
        fontWeight: 500,
        color: active ? C.text : C.t3,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        borderBottom: `1px solid ${C.border}`,
        whiteSpace: "nowrap",
        position: "relative",
        background: "#fff",
      }}
    >
      {label}
      {active && (
        <span style={{ position: "absolute", marginLeft: 3, fontSize: 10 }}>
          {currentSort.asc ? "↑" : "↓"}
        </span>
      )}
    </th>
  );
}

export default function SubnetTable({ subnets, alphaRanges }) {
  const [slider, setSlider] = useState(0);
  const [period, setPeriod] = useState("4H");
  const [sort, setSort] = useState({ key: "predicted", asc: false });
  const [hideLow, setHideLow] = useState(true);

  const pk = PK[period];

  const rows = useMemo(() => {
    let list = subnets.map(s => {
      const d = s[pk] ?? { beta0: 0, beta1: 0, r2: 0, accuracy: null };
      return {
        ...s,
        beta0: d.beta0,
        beta1: d.beta1,
        r2: d.r2,
        accuracy: d.accuracy ?? null,
        predicted: d.beta0 * 100 + d.beta1 * slider,
        lowLiq: s.tvl < 500000,
      };
    });

    if (hideLow) list = list.filter(r => !r.lowLiq);

    list.sort((a, b) => {
      const av = a[sort.key] ?? a.id;
      const bv = b[sort.key] ?? b.id;
      return sort.asc ? av - bv : bv - av;
    });

    return list;
  }, [subnets, slider, pk, sort, hideLow]);

  function handleSort(key) {
    setSort(prev => prev.key === key ? { key, asc: !prev.asc } : { key, asc: false });
  }

  const thProps = { currentSort: sort, onSort: handleSort };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <h2 className="title">
          <span>
            <span style={{ color: C.green }}>$TAO</span>
            {" → "}
            <span style={{ color: C.text }}>Subnets</span>
          </span>
          <span className="subtitle">Alpha Prediction</span>
        </h2>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)} className="pbtn" data-active={period === p}>
              {p}
            </button>
          ))}
          <div style={{ width: 1, height: 16, background: C.border, margin: "0 8px" }} />
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 12, color: C.t3 }}>
            <input
              type="checkbox"
              checked={hideLow}
              onChange={e => setHideLow(e.target.checked)}
              style={{ accentColor: C.green }}
            />
            Hide low liquidity
          </label>
        </div>
      </div>

      <PredictionSlider
        value={slider}
        onChange={setSlider}
        label="If $TAO moves by [ X ]%, how do subnets react?"
      />

      <div style={{ overflowX: "auto", marginTop: 18, borderRadius: 10, border: `1px solid ${C.border}` }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 13 }}>
          <thead>
            <tr>
              <TH label="Subnet"      sortKey="id"        {...thProps} left />
              <TH label="Coefficient" sortKey="beta1"     {...thProps} />
              <TH label="Alpha"       sortKey="beta0"     {...thProps} />
              <TH label="R²"          sortKey="r2"        {...thProps} />
              <TH label="Predict"     sortKey="predicted" {...thProps} />
              <TH label="准确率"      sortKey="accuracy"  {...thProps} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const negPred = r.predicted < 0;
              const dim = r.r2 < 0.3;
              return (
                <tr key={r.id} className="trow" style={{ opacity: dim ? 0.35 : 1 }}>
                  <td className="td" style={{ fontFamily: "var(--sans)" }}>
                    <span style={{ color: C.t3, marginRight: 6 }}>SN{r.id}</span>
                    {r.symbol}
                    {r.lowLiq && (
                      <span style={{ marginLeft: 8, fontSize: 9, color: C.red, background: C.redBg, borderRadius: 4, padding: "2px 5px" }}>
                        LOW LIQ
                      </span>
                    )}
                  </td>
                  <td className="td tc" style={{ color: r.beta1 > 2 ? C.yellow : C.text }}>
                    {r.beta1.toFixed(2)}
                  </td>
                  <td className="td tc" style={{ color: r.beta0 >= 0 ? C.green : C.red }}>
                    {r.beta0 >= 0 ? "+" : ""}{(r.beta0 * 100).toFixed(2)}%
                  </td>
                  <td className="td tc" style={{ color: r2Color(r.r2) }}>
                    {r.r2.toFixed(2)}
                  </td>
                  <td className="td tc">
                    <span style={{ fontSize: 14, color: negPred ? C.red : C.green }}>
                      {fmt(r.predicted, 2)}
                    </span>
                  </td>
                  <td className="td tc" style={{ color: accuracyColor(r.accuracy) }}>
                    {r.accuracy !== null && r.accuracy !== undefined
                      ? `${(r.accuracy * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!hideLow && (
        <div style={{ marginTop: 12, fontSize: 11, color: C.t3 }}>
          <span style={{ color: C.red }}>●</span> Low liquidity (TVL &lt; $500K). Exercise extreme caution.
        </div>
      )}
    </div>
  );
}
