import { useState } from "react";
import { C } from "../constants/colors.js";

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const fmt = (n, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d) + "%";

export default function PredictionSlider({ value, onChange, label }) {
  const isNeg = value < 0;
  const pct = ((value + 80) / 180) * 100;
  const color = isNeg ? C.red : C.green;
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState("");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: C.t2 }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => onChange(clamp(value - 1, -80, 100))} className="sbtn">−</button>
          {editing ? (
            <input
              autoFocus
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onBlur={() => {
                const n = parseFloat(inputVal);
                if (!isNaN(n)) onChange(clamp(n, -80, 100));
                setEditing(false);
              }}
              onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
              className="sinput"
            />
          ) : (
            <span
              onClick={() => { setInputVal(value.toFixed(2)); setEditing(true); }}
              style={{
                minWidth: 78, height: 32, borderRadius: 8,
                background: isNeg ? C.redBg : C.greenBg,
                color, fontSize: 15, fontWeight: 700,
                fontFamily: "var(--mono)",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "text", padding: "0 8px", border: "none",
              }}
            >
              {fmt(value, 2)}
            </span>
          )}
          <button onClick={() => onChange(clamp(value + 1, -80, 100))} className="sbtn">+</button>
          <button
            onClick={() => onChange(0)}
            className="sbtn"
            style={{ fontSize: 10, padding: "0 10px", letterSpacing: 0.5, fontWeight: 600 }}
          >
            RESET
          </button>
        </div>
      </div>

      <div style={{ position: "relative", height: 3, borderRadius: 2, background: "#f0f0f0" }}>
        <div style={{
          position: "absolute",
          left: value >= 0 ? `${(80 / 180) * 100}%` : `${pct}%`,
          width: value >= 0 ? `${(value / 180) * 100}%` : `${((80 / 180) * 100) - pct}%`,
          height: "100%",
          background: color,
          borderRadius: 2,
          transition: "all 0.05s",
        }} />
        <div style={{ position: "absolute", left: `${(80 / 180) * 100}%`, top: -5, width: 1, height: 13, background: "#ddd" }} />
      </div>

      <input
        type="range"
        min={-80}
        max={100}
        step={0.01}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="slider"
      />

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.t3, marginTop: -2 }}>
        <span>-80%</span><span>0%</span><span>+100%</span>
      </div>
    </div>
  );
}
