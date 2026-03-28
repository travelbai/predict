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
      <span>数据更新异常，当前展示 <strong>{hours}</strong> 小时前的快照数据</span>
    </div>
  );
}
