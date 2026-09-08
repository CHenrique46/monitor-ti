export default function SummaryCards({ summary, loading, activeFilter, onFilterChange }) {
  const items = [
    { key: 'all', label: 'Total', value: summary.total, className: '' },
    { key: 'online', label: 'Online', value: summary.online, className: 'online' },
    { key: 'offline', label: 'Offline', value: summary.offline, className: 'offline' },
    { key: 'attention', label: 'Requer atenção', value: summary.attention, className: 'attention' },
    { key: 'reboot', label: 'Reinício recomendado', value: summary.rebootRecommended, className: 'reboot' },
    { key: 'critical', label: 'Máquinas críticas', value: summary.criticalAlerts, className: 'critical' }
  ]

  return (
    <>
      <div className={`summary operational-summary ${loading ? 'is-loading' : ''}`} aria-label="Resumo operacional">
        {items.map((item) => {
        const content = <><span className={`summary-num ${item.className}`}>{loading ? '—' : item.value}</span><span className="summary-label">{item.label}</span></>
        return <button key={item.key} type="button" className={`summary-item summary-action ${activeFilter === item.key ? 'active' : ''}`} onClick={() => onFilterChange(item.key)} aria-label={`Filtrar por ${item.label}`} aria-pressed={activeFilter === item.key}>{content}</button>
        })}
      </div>
      <div className="quick-filters" aria-label="Filtros rápidos">
        {[['all', 'Todos', summary.total], ['online', 'Online', summary.online], ['offline', 'Offline', summary.offline], ['attention', 'Atenção', summary.attention], ['critical', 'Críticos', summary.criticalAlerts]].map(([key, label, value]) => <button key={key} type="button" className={activeFilter === key ? 'active' : ''} onClick={() => onFilterChange(key)} aria-pressed={activeFilter === key}>{label} <strong>{loading ? '—' : value}</strong></button>)}
        <select className="quick-filter-more" value={activeFilter === 'reboot' || activeFilter === 'normal' ? activeFilter : ''} onChange={(event) => event.target.value && onFilterChange(event.target.value)} aria-label="Outros filtros">
          <option value="">Mais filtros</option>
          <option value="reboot">Reinício recomendado</option>
          <option value="normal">Normais</option>
        </select>
      </div>
    </>
  );
}
