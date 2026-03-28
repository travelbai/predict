/**
 * Mock dashboard state — returned when KV is empty (first run / local dev).
 * Mirrors the schema defined in regression-dev-prompt.md §6.
 */
export const MOCK_STATE = {
  version: 1,
  updatedAt: "2026-03-21T00:00:00Z",
  status: "ok",
  staleReason: null,

  btcTao: {
    beta0: 0.42,
    beta1: 1.85,
    r2: 0.61,
    accuracy: null,
    mapeHistory: [],
    windowWeeks: 52,
    windowDays: 364,
    window: "364d / 52w",
    sampleCount: 52,
    calculatedAt: "2026-03-21T00:00:00Z",
  },

  alphaRangeBtcTao: [-1.0, 1.0],

  alphaRanges: {
    h4: [-1.5, 2.0],
    d1: [-0.8, 1.2],
    w1: [-0.4, 0.6],
  },

  subnets: [
    { id: 1,   symbol: "APEX",  name: "SN1 Apex",   tvl: 2850000, regDays: 280, h4: { beta0: 0.12,  beta1: 2.35, r2: 0.72, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.18,  beta1: 2.10, r2: 0.68, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.25,  beta1: 1.95, r2: 0.74, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 3,   symbol: "COV",   name: "SN3 Cov",    tvl: 1920000, regDays: 210, h4: { beta0: 0.08,  beta1: 1.92, r2: 0.65, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.15,  beta1: 1.78, r2: 0.61, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.20,  beta1: 1.65, r2: 0.58, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 5,   symbol: "KAITO", name: "SN5 Kaito",  tvl: 3400000, regDays: 320, h4: { beta0: 0.35,  beta1: 1.45, r2: 0.81, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.40,  beta1: 1.38, r2: 0.77, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.48,  beta1: 1.30, r2: 0.82, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 9,   symbol: "PRE",   name: "SN9 Pre",    tvl: 780000,  regDays: 150, h4: { beta0: -0.05, beta1: 3.10, r2: 0.55, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.02,  beta1: 2.85, r2: 0.52, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.08,  beta1: 2.60, r2: 0.49, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 13,  symbol: "DATA",  name: "SN13 Data",  tvl: 620000,  regDays: 180, h4: { beta0: 0.22,  beta1: 1.68, r2: 0.44, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.28,  beta1: 1.55, r2: 0.41, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.32,  beta1: 1.42, r2: 0.38, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 18,  symbol: "CTX",   name: "SN18 Ctx",   tvl: 1150000, regDays: 240, h4: { beta0: 0.50,  beta1: 1.20, r2: 0.88, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.55,  beta1: 1.15, r2: 0.85, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.60,  beta1: 1.08, r2: 0.90, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 21,  symbol: "FTAO",  name: "SN21 Ftao",  tvl: 420000,  regDays: 90,  h4: { beta0: -0.10, beta1: 2.80, r2: 0.38, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: -0.05, beta1: 2.55, r2: 0.35, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.01,  beta1: 2.30, r2: 0.32, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 25,  symbol: "HIVE",  name: "SN25 Hive",  tvl: 950000,  regDays: 200, h4: { beta0: 0.18,  beta1: 2.48, r2: 0.59, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.22,  beta1: 2.30, r2: 0.56, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.28,  beta1: 2.15, r2: 0.53, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 32,  symbol: "IQT",   name: "SN32 Iqt",   tvl: 1680000, regDays: 260, h4: { beta0: 0.30,  beta1: 1.75, r2: 0.70, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.35,  beta1: 1.62, r2: 0.67, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.40,  beta1: 1.50, r2: 0.71, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 41,  symbol: "SPORT", name: "SN41 Sport", tvl: 350000,  regDays: 60,  h4: { beta0: -0.15, beta1: 3.50, r2: 0.33, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: -0.08, beta1: 3.20, r2: 0.30, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.00,  beta1: 2.90, r2: 0.28, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 56,  symbol: "GRAD",  name: "SN56 Grad",  tvl: 2100000, regDays: 300, h4: { beta0: 0.42,  beta1: 1.55, r2: 0.76, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.48,  beta1: 1.42, r2: 0.73, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.52,  beta1: 1.35, r2: 0.78, accuracy: null, mapeHistory: [], windowDays: 180 } },
    { id: 105, symbol: "BEAM",  name: "SN105 Beam", tvl: 510000,  regDays: 120, h4: { beta0: 0.65,  beta1: 1.10, r2: 0.48, accuracy: null, mapeHistory: [], windowDays: 30 }, d1: { beta0: 0.70,  beta1: 1.02, r2: 0.45, accuracy: null, mapeHistory: [], windowDays: 90  }, w1: { beta0: 0.75,  beta1: 0.95, r2: 0.42, accuracy: null, mapeHistory: [], windowDays: 180 } },
  ],
};
