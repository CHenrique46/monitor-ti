export default function SummaryCards({ summary, loading, activeFilter, onFilterChange }) {
  const items = [
    { key: 'all', label: 'Total', value: summary.total, className: '' },
    { key: 'online', label: 'Online', value: summary.online, className: 'online' },
    { key: 'offline', label: 'Offline', value: summary.offline, className: 'offline' },
    { key: 'attention', label: 'Requer atenção', value: summary.attention, className: 'attention' },
    { key: 'reboot', label: 'Reinício recomendado', value: summary.rebootRecommended, className: 'reboot' },
    { key: 'critical', label: 'Alertas críticos', value: summary.criticalAlerts, className: 'critical' }
  ]

  return (
    <div className={`summary operational-summary ${loading ? 'is-loading' : ''}`} aria-label="Resumo operacional">
      {items.map((item) => {
        const content = <><span className={`summary-num ${item.className}`}>{loading ? '—' : item.value}</span><span className="summary-label">{item.label}</span></>
        return <button key={item.key} type="button" className={`summary-item summary-action ${activeFilter === item.key ? 'active' : ''}`} onClick={() => onFilterChange(item.key)} aria-label={`Filtrar por ${item.label}`} aria-pressed={activeFilter === item.key}>{content}</button>
      })}
    </div>
  );
}
