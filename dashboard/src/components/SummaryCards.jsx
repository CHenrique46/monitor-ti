export default function SummaryCards({ summary }) {
  return (
    <div className="summary">
      <div className="summary-item">
        <span className="summary-num">{summary.total}</span>
        <span className="summary-label">Total</span>
      </div>
      <div className="summary-item">
        <span className="summary-num online">{summary.online}</span>
        <span className="summary-label">Online</span>
      </div>
      <div className="summary-item">
        <span className="summary-num offline">{summary.offline}</span>
        <span className="summary-label">Offline</span>
      </div>
      <div className="summary-item">
        <span className={`summary-num ${summary.alerts > 0 ? "critical" : ""}`}>
          {summary.alerts}
        </span>
        <span className="summary-label">Alertas</span>
      </div>
    </div>
  );
}
