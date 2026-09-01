export default function SummaryCards({ summary, loading, onShowAll, onShowAttention }) {
  const items = [
    { key: 'total', label: 'Total', value: summary.total, className: '', onClick: onShowAll },
    { key: 'online', label: 'Online', value: summary.online, className: 'online' },
    { key: 'offline', label: 'Offline', value: summary.offline, className: 'offline' },
    { key: 'attention', label: 'Requer atenção', value: summary.attention, className: 'attention', onClick: onShowAttention },
    { key: 'reboot', label: 'Reinício recomendado', value: summary.rebootRecommended, className: 'reboot' },
    { key: 'critical', label: 'Alertas críticos', value: summary.criticalAlerts, className: 'critical' }
  ]

  return (
    <div className={`summary operational-summary ${loading ? 'is-loading' : ''}`} aria-label="Resumo operacional">
      {items.map((item) => {
        const content = <><span className={`summary-num ${item.className}`}>{loading ? '—' : item.value}</span><span className="summary-label">{item.label}</span></>
        return item.onClick ? <button key={item.key} type="button" className="summary-item summary-action" onClick={item.onClick}>{content}</button> : <div key={item.key} className="summary-item">{content}</div>
      })}
    </div>
  );
}
