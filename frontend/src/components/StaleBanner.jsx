/**
 * Shown when dashboard_state.status === "stale".
 * Computes how many hours ago the snapshot was taken.
 */
export default function StaleBanner({ updatedAt }) {
  const diffMs = Date.now() - new Date(updatedAt).getTime();
  const hours = Math.round(diffMs / (1000 * 60 * 60));

  return (
    <div className="stale-banner">
      <span>⚠</span>
      <span>节点拥堵，当前采用 <strong>{hours}</strong> 小时前快照参数</span>
    </div>
  );
}
