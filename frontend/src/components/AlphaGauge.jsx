import { C } from "../constants/colors.js";

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/**
 * Semi-circular gauge showing the alpha (β₀) value.
 * alphaRange: [min, max] from dashboard state (dynamic, from back-test P5/P95)
 */
export default function AlphaGauge({ alpha, alphaRange = [-1, 1] }) {
  const [rangeMin, rangeMax] = alphaRange;
  const span = rangeMax - rangeMin || 2;
  const norm = clamp((alpha - rangeMin) / span, 0, 1);
  const angle = -90 + norm * 180;
  const color = norm > 0.6 ? C.green : norm > 0.35 ? C.yellow : C.red;

  return (
    <div style={{ textAlign: "center" }}>
      <div className="label">Alpha Index</div>
      <svg viewBox="0 0 200 115" width="160" style={{ overflow: "visible", marginTop: 4 }}>
        <defs>
          <linearGradient id="gg" x1="0%" y1="0%" x2="100%">
            <stop offset="0%" stopColor="#E5484D" />
            <stop offset="50%" stopColor="#F0B90B" />
            <stop offset="100%" stopColor="#00B07C" />
          </linearGradient>
        </defs>
        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#eaeaea" strokeWidth="10" strokeLinecap="round" />
        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#gg)" strokeWidth="10" strokeLinecap="round" opacity="0.75" />
        <g transform={`rotate(${angle}, 100, 100)`}>
          <line x1="100" y1="100" x2="100" y2="36" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="100" cy="100" r="4" fill={color} />
        </g>
        <text x="100" y="94" textAnchor="middle" fill={C.text} fontSize="19" fontWeight="700" fontFamily="var(--mono)">
          {alpha >= 0 ? "+" : ""}{(alpha * 100).toFixed(2)}%
        </text>
      </svg>
    </div>
  );
}
