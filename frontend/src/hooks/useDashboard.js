import { useState, useEffect } from "react";

/**
 * Fetches dashboard state from the Worker API.
 * Falls back to mock data if the API is unreachable (e.g., Worker not running).
 */
export function useDashboard() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/dashboard");
        if (!res.ok) throw new Error(`服务器返回 HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setState(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err.name === "TypeError"
            ? "网络连接失败，请检查网络后重试"
            : err.message;
          setError(msg);
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { state, loading, error };
}
