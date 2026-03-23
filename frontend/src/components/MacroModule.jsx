import { useState } from "react";
import { C } from "../constants/colors.js";
import PredictionSlider from "./PredictionSlider.jsx";
import AlphaGauge from "./AlphaGauge.jsx";

const fmt = (n, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d) + "%";

export default function MacroModule({ btcTao, alphaRange }) {
  const [slider, setSlider] = useState(0);
  const predicted = btcTao.beta0 * 100 + btcTao.beta1 * slider;
  const isNeg = predicted < 0;
  const r2Color = btcTao.r2 > 0.5 ? C.green : btcTao.r2 >= 0.3 ? C.yellow : C.gray;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
        <h2 className="title">
          <span>
            <span style={{ color: C.btc }}>$BTC</span>
            {" → "}
            <span style={{ color: C.green }}>$TAO</span>
          </span>
          <span className="subtitle">Macro Regression</span>
        </h2>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: C.t3 }}>
            R²{" "}
            <span style={{ color: r2Color, fontWeight: 600 }}>{btcTao.r2.toFixed(2)}</span>
          </span>
          <span style={{ fontSize: 12, color: C.t3 }}>{btcTao.window}</span>
        </div>
      </div>

      <PredictionSlider
        value={slider}
        onChange={setSlider}
        label="If $BTC moves by [ X ]%, how does $TAO react?"
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 22 }}>
        <div className="metric-card">
          <AlphaGauge alpha={btcTao.beta0} alphaRange={alphaRange} />
        </div>
        <div className="metric-card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div className="label">Coefficient</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: C.text, fontFamily: "var(--mono)", marginTop: 4 }}>
            {btcTao.beta1.toFixed(2)}
          </div>
        </div>
        <div
          className="metric-card"
          style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: isNeg ? C.redBg : C.greenBg }}
        >
          <div className="label">Predicted $TAO</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: isNeg ? C.red : C.green, fontFamily: "var(--mono)", marginTop: 4 }}>
            {fmt(predicted, 2)}
          </div>
        </div>
      </div>
    </div>
  );
}
