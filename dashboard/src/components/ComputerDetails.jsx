import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import SiteNav from './SiteNav'
import MetricChart from './MetricChart'
import { computeAlerts } from '../utils/alerts'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { bytesToGB, formatUptime, formatPercent, sistemaLabel, fmtDate } from '../utils/formatters'
import { getUptimeStatus, UPTIME_STATUS, uptimeStatusLabel } from '../utils/uptime'
import { isVersionNewer } from '../utils/version'
import { activationStatus, licenseType, normalizeOffice, partialKey } from '../utils/office'

function MetricBar({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0))
  const cls = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''
  return <div className="bar"><div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} /></div>
}

function Field({ label, children }) {
  return <div className="detail-field"><span className="detail-key">{label}</span><span className="detail-val">{children ?? 'Não informado'}</span></div>
}

function Section({ title, children }) {
  return <section className="detail-section"><h3>{title}</h3><div className="detail-grid">{children}</div></section>
}

function OfficeField({ label, value }) {
  if (value === null || value === undefined || value === '') return null
  return <Field label={label}>{value}</Field>
}

function OfficeInstallationCard({ installation }) {
  const activation = activationStatus(installation.activationStatus)
  const key = partialKey(installation.partialProductKey)
  return <article className="office-installation">
    <div className="office-installation-header">
      <div><strong>{installation.productName || 'Produto não informado'}</strong>{installation.edition && <small>{installation.edition}</small>}</div>
      <span className={`office-status ${activation.tone}`}>{activation.label}</span>
    </div>
    <div className="office-field-grid">
      <OfficeField label="Versão" value={installation.version} />
      <OfficeField label="Arquitetura" value={installation.architecture} />
      <OfficeField label="Canal de atualização" value={installation.updateChannel} />
      <OfficeField label="Tecnologia de instalação" value={installation.installationTechnology} />
      <OfficeField label="Ativação" value={activation.label} />
      <OfficeField label="Tipo de licença" value={licenseType(installation.licenseType)} />
      <OfficeField label="Chave parcial" value={key} />
      <OfficeField label="Última verificação" value={installation.collectedAt ? fmtDate(installation.collectedAt) : null} />
    </div>
    {(installation.licenseName || installation.licenseDescription) && <details className="office-license-details">
      <summary>Detalhes da licença</summary>
      <OfficeField label="Nome" value={installation.licenseName} />
      <OfficeField label="Descrição" value={installation.licenseDescription} />
    </details>}
  </article>
}

function OfficeSection({ office }) {
  const inventory = normalizeOffice(office)
  return <section className="detail-section office-section"><h3>Microsoft Office</h3>
    {inventory.installations.length ? <div className="office-installations">{inventory.installations.map((installation, index) => <OfficeInstallationCard key={installation.id || index} installation={installation} />)}</div> : <div className="office-empty"><strong>Informações do Office ainda não disponíveis.</strong><span>Será necessário um Agent compatível para coletar essas informações.</span></div>}
  </section>
}

function StatusTag({ status }) {
  const labels = { PENDING: 'Pendente', DISPATCHED: 'Enviado', RUNNING: 'Executando', SUCCESS: 'Concluído', FAILED: 'Falhou', REJECTED: 'Rejeitado', SKIPPED: 'Ignorado' }
  const tone = ['FAILED', 'REJECTED'].includes(status) ? 'failed' : status === 'SUCCESS' ? 'ok' : 'running'
  return <span className={`action-status ${tone}`}>{labels[status] || status || 'Desconhecido'}</span>
}

function ActionItem({ action }) {
  return <details className="action-item">
    <summary><span><strong>{action.label || action.action}</strong><small>{fmtDate(action.solicitadaEm)}</small></span><StatusTag status={action.status} /></summary>
    {(action.mensagem || action.erro || action.concluidaEm) && <div className="action-detail">{action.mensagem || action.erro || 'Concluída'}{action.concluidaEm && <small>Concluída em {fmtDate(action.concluidaEm)}</small>}</div>}
  </details>
}

function ConfirmBox({ children, onCancel, onConfirm, confirmLabel }) {
  return <div className="confirm-box"><p>{children}</p><div className="confirm-actions"><button type="button" className="btn-cancel" onClick={onCancel}>Cancelar</button><button type="button" className="btn-update" onClick={onConfirm}>{confirmLabel}</button></div></div>
}

export default function ComputerDetails({ computerId, latestVersion, onClose }) {
  const routeId = useParams().id
  const id = computerId || routeId
  const drawer = Boolean(computerId)
  const [serverOk, setServerOk] = useState(true)
  const [c, setC] = useState(null)
  const [notFound, setNotFound] = useState(false)
  const [periodo, setPeriodo] = useState('24h')
  const [metricas, setMetricas] = useState(null)
  const [alertas, setAlertas] = useState([])
  const [release, setRelease] = useState(null)
  const [updateStatus, setUpdateStatus] = useState(null)
  const [confirm, setConfirm] = useState(false)
  const [remoteActions, setRemoteActions] = useState([])
  const [spoolerConfirm, setSpoolerConfirm] = useState(false)
  const [serviceRestartConfirm, setServiceRestartConfirm] = useState(false)
  const [serviceRestartError, setServiceRestartError] = useState(null)
  const [systemMaintenanceConfirm, setSystemMaintenanceConfirm] = useState(false)
  const [systemMaintenanceError, setSystemMaintenanceError] = useState(null)
  const [wallpaperConfirm, setWallpaperConfirm] = useState(false)
  const [wallpaperError, setWallpaperError] = useState(null)
  const [tab, setTab] = useState('summary')

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const r = await apiFetch(`${API_URL}/api/computadores/${id}`)
        if (!active) return
        if (r.status === 404) { setNotFound(true); return }
        if (!r.ok) { setServerOk(false); return }
        setNotFound(false); setServerOk(true); setC(await r.json())
      } catch { if (active) setServerOk(false) }
    }
    load(); const interval = setInterval(load, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [id])

  useEffect(() => {
    let active = true
    const loadM = async () => { try { const r = await apiFetch(`${API_URL}/api/computadores/${id}/metricas?periodo=${periodo}`); if (active && r.ok) setMetricas(await r.json()) } catch {} }
    loadM(); const interval = setInterval(loadM, 60000)
    return () => { active = false; clearInterval(interval) }
  }, [id, periodo])

  useEffect(() => {
    let active = true
    const loadA = async () => { try { const r = await apiFetch(`${API_URL}/api/computadores/${id}/alertas`); if (active && r.ok) setAlertas(await r.json()) } catch {} }
    loadA(); const interval = setInterval(loadA, 10000)
    return () => { active = false; clearInterval(interval) }
  }, [id])

  useEffect(() => {
    if (drawer) {
      setRelease(latestVersion ? { version: latestVersion } : null)
      return undefined
    }
    let active = true
    const loadRelease = async () => { try { const r = await apiFetch(`${API_URL}/api/agent/releases/latest`); if (active) setRelease(r.ok ? await r.json() : null) } catch { if (active) setRelease(null) } }
    loadRelease(); const interval = setInterval(loadRelease, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [id, drawer, latestVersion])

  useEffect(() => {
    if (!release) return undefined
    let active = true
    const loadStatus = async () => { try { const r = await apiFetch(`${API_URL}/api/computadores/${id}/agent-update`); if (active && r.ok) setUpdateStatus(await r.json()) } catch {} }
    loadStatus(); const interval = setInterval(loadStatus, 3000)
    return () => { active = false; clearInterval(interval) }
  }, [id, release])

  useEffect(() => {
    let active = true
    const loadActions = async () => { try { const r = await apiFetch(`${API_URL}/api/computadores/${id}/actions?take=10`); if (active && r.ok) setRemoteActions(await r.json()) } catch {} }
    loadActions(); const interval = setInterval(loadActions, 5000)
    return () => { active = false; clearInterval(interval) }
  }, [id])

  useEffect(() => {
    if (!drawer) return undefined
    const closeOnEscape = (event) => event.key === 'Escape' && onClose?.()
    document.addEventListener('keydown', closeOnEscape)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', closeOnEscape); document.body.style.overflow = previousOverflow }
  }, [drawer, onClose])

  const request = async (path, options, onError) => {
    try {
      const r = await apiFetch(`${API_URL}/api/computadores/${id}${path}`, options)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) { onError(body.erro || 'Não foi possível concluir a ação.'); return }
      if (body.execution) setRemoteActions((prev) => [body.execution, ...prev.filter((a) => a.actionExecutionId !== body.execution.actionExecutionId)])
    } catch { onError('Não foi possível concluir a ação.') }
  }
  const triggerUpdate = async () => { setConfirm(false); await request('/agent-update', { method: 'POST' }, (message) => setUpdateStatus({ status: 'update_failed', message })) }
  const triggerSpoolerReset = async () => { setSpoolerConfirm(false); await request('/actions/spooler-reset', { method: 'POST' }, () => {}) }
  const triggerServiceRestart = async () => { setServiceRestartConfirm(false); setServiceRestartError(null); await request('/actions/service-restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceKey: 'spooler' }) }, setServiceRestartError) }
  const triggerSystemMaintenance = async () => { setSystemMaintenanceConfirm(false); setSystemMaintenanceError(null); await request('/actions/system-maintenance', { method: 'POST' }, setSystemMaintenanceError) }
  const triggerWallpaper = async () => { setWallpaperConfirm(false); setWallpaperError(null); await request('/actions/set-wallpaper', { method: 'POST' }, setWallpaperError) }

  if (notFound) return drawer ? <div className="drawer-backdrop" onClick={onClose}><aside className="details-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-empty">Computador não encontrado.</div></aside></div> : <div className="container"><Link className="back-link" to="/">← Voltar ao Dashboard</Link><div className="empty">Computador não encontrado.</div></div>
  if (!c) return drawer ? <div className="drawer-backdrop"><aside className="details-drawer"><div className="drawer-empty">Carregando dados do computador...</div></aside></div> : <div className="container"><SiteNav /><p className="muted">Carregando dados do computador...</p></div>

  const online = c.status === 'online'
  const { alerts } = computeAlerts(c)
  const uptimeStatus = getUptimeStatus(c.uptime)
  const uptimeNeedsAttention = [UPTIME_STATUS.ATTENTION, UPTIME_STATUS.REBOOT_RECOMMENDED].includes(uptimeStatus)
  const ramPct = c.ramTotal && c.ramUsada != null ? Math.round((c.ramUsada / c.ramTotal) * 100) : null
  const discoPct = c.discoTotal && c.discoLivre != null ? Math.round(((c.discoTotal - c.discoLivre) / c.discoTotal) * 100) : null
  const hasCritical = alerts.some((a) => a.severity === 'critical')
  const hasWarn = alerts.some((a) => a.severity === 'warn')
  const cardClass = !online ? 'offline-card' : hasCritical ? 'critical-card' : hasWarn ? 'warn-card' : 'online-card'
  const updateAvailable = release && isVersionNewer(release.version, c.agentVersion)
  const inProgress = updateStatus && ['update_pending', 'update_downloading', 'update_validating', 'update_installing'].includes(updateStatus.status)
  const genericActions = remoteActions.filter((a) => a.action !== 'system_maintenance')
  const maintenanceActions = remoteActions.filter((a) => a.action === 'system_maintenance')
  const serviceActions = genericActions.filter((a) => a.action === 'service_restart')
  const remoteInProgress = remoteActions.some((a) => ['PENDING', 'DISPATCHED', 'RUNNING'].includes(a.status))
  const serviceInProgress = serviceActions.some((a) => ['PENDING', 'DISPATCHED', 'RUNNING'].includes(a.status))
  const maintenanceInProgress = maintenanceActions.some((a) => ['PENDING', 'DISPATCHED', 'RUNNING'].includes(a.status))
  const tabs = [['summary', 'Resumo'], ['hardware', 'Hardware'], ['alerts', `Alertas${alerts.length ? ` (${alerts.length})` : ''}`], ['actions', 'Ações'], ['maintenance', 'Manutenção']]
  const body = <>
    <header className={`drawer-header ${cardClass}`}>
      <div><span className="section-kicker">Detalhes do computador</span><h1>{c.hostname || '(sem nome)'}</h1><div className="drawer-meta"><span className={online ? 'online' : 'offline'}>{online ? '● Online' : '● Offline'}</span><span>{c.ip || 'IP não informado'}</span><span>Agent v{c.agentVersion || '?'}</span><span>Última comunicação: {fmtDate(c.ultimaConexao)}</span></div></div>
      <button type="button" className="drawer-close" onClick={onClose || (() => window.history.back())} aria-label="Fechar detalhes">×</button>
    </header>
    {!serverOk && <p className="server-warn">Não foi possível atualizar os dados.</p>}
    <nav className="detail-tabs" aria-label="Seções do computador">{tabs.map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <div className="drawer-content">
      {tab === 'summary' && <>
        <div className="summary-metrics"><div><span>CPU</span><strong>{formatPercent(c.cpuUso)}</strong><MetricBar value={c.cpuUso} /></div><div><span>RAM</span><strong>{bytesToGB(c.ramUsada)} / {bytesToGB(c.ramTotal)}</strong><MetricBar value={ramPct} /></div><div><span>Disco C:</span><strong>{bytesToGB(c.discoLivre)} livres</strong><MetricBar value={discoPct} /></div></div>
        <Section title="Estado atual"><Field label="Status">{online ? 'Online' : 'Offline'}</Field><Field label={online ? 'Uptime atual' : 'Último uptime registrado'}>{formatUptime(c.uptime)}</Field><Field label="Status do uptime"><span className={`uptime-status ${uptimeStatus.toLowerCase()}`}>{uptimeStatusLabel(uptimeStatus)}</span></Field><Field label="Usuário">{c.usuario || 'Não informado'}</Field><Field label="Device ID">{c.deviceId}</Field></Section>
        {uptimeNeedsAttention && <div className={`uptime-notice ${uptimeStatus === UPTIME_STATUS.REBOOT_RECOMMENDED ? 'recommended' : ''}`}><strong>{uptimeStatusLabel(uptimeStatus)}</strong><span>{online ? `Este computador está há ${formatUptime(c.uptime)} sem reiniciar.` : `Último uptime registrado: ${formatUptime(c.uptime)}. O valor não é incrementado enquanto offline.`}</span></div>}
        <Section title="Histórico de métricas"><div className="period-selector">{['24h', '7d', '30d'].map((p) => <button key={p} type="button" className={periodo === p ? 'period-btn active' : 'period-btn'} onClick={() => setPeriodo(p)}>{p === '24h' ? '24 horas' : p === '7d' ? '7 dias' : '30 dias'}</button>)}</div><MetricChart title="CPU %" data={metricas} dataKey="cpuUso" color="#38bdf8" /><MetricChart title="RAM %" data={metricas} dataKey="ramUsoPct" color="#a78bfa" /><MetricChart title="Disco %" data={metricas} dataKey="discoUsoPct" color="#f59e0b" /></Section>
      </>}
       {tab === 'hardware' && <>
         <Section title="Sistema"><Field label="Sistema">{sistemaLabel(c.sistema)}</Field><Field label="Release">{c.sistemaRelease}</Field><Field label="Arquitetura">{c.arquitetura}</Field><Field label="Build Windows">{c.sistemaBuild}</Field></Section>
         <OfficeSection office={c.office} />
         <Section title="Processador"><Field label="Modelo">{c.processador}</Field><Field label="CPUs lógicas">{c.cpusLogicas}</Field><Field label="Fabricante">{c.fabricante}</Field><Field label="Modelo do equipamento">{c.modeloEquipamento}</Field></Section>
        <Section title="Memória e armazenamento"><Field label="RAM total">{bytesToGB(c.ramTotal)}</Field><Field label="RAM usada">{bytesToGB(c.ramUsada)}</Field><Field label="Disco total">{bytesToGB(c.discoTotal)}</Field><Field label="Disco livre">{bytesToGB(c.discoLivre)}</Field></Section>
        <Section title="Equipamento"><Field label="Número de série">{c.numeroSerie}</Field><Field label="GPU">{c.gpu}</Field><Field label="MAC">{c.mac}</Field><Field label="Placa-mãe">{[c.placaMaeFabricante, c.placaMaeModelo].filter(Boolean).join(' / ')}</Field><Field label="BIOS">{[c.biosFabricante, c.biosVersao].filter(Boolean).join(' / ')}</Field></Section>
        <Section title="Discos físicos">{c.discosFisicos?.length ? c.discosFisicos.map((d, i) => <div className="inventory-row" key={d.id || i}><strong>Disco {i + 1}</strong><span>{d.modelo || 'Modelo não informado'} · {d.tamanho != null ? bytesToGB(d.tamanho) : 'Capacidade não informada'} · {d.interface || 'Interface não informada'}</span></div>) : <div className="muted">Nenhum disco físico informado.</div>}</Section>
        <Section title="Agent"><Field label="Versão instalada">v{c.agentVersion || 'desconhecida'}</Field>{release && <Field label="Versão disponível">v{release.version}</Field>}{release && !updateAvailable && <div className="update-ok">✓ Agent atualizado (v{release.version})</div>}{updateStatus && <div className={`update-status ${updateStatus.status === 'update_failed' ? 'failed' : updateStatus.status === 'update_success' ? 'ok' : 'running'}`}>{updateStatus.status}{updateStatus.message ? ` — ${updateStatus.message}` : ''}</div>}{release && updateAvailable && online && !inProgress && <button type="button" className="btn-update" onClick={() => setConfirm(true)}>Atualizar Agent</button>}{!online && updateAvailable && <div className="muted">Computador offline: não é possível atualizar agora.</div>}{confirm && <ConfirmBox onCancel={() => setConfirm(false)} onConfirm={triggerUpdate} confirmLabel="Atualizar">Atualizar o Agent da máquina <strong>{c.hostname}</strong> para v{release.version}?</ConfirmBox>}</Section>
      </>}
      {tab === 'alerts' && <><Section title="Alertas ativos">{alerts.length ? alerts.map((a, i) => <div key={i} className={`alert ${a.severity}`}>⚠ {a.msg}</div>) : <div className="muted">Nenhum alerta ativo.</div>}</Section><Section title="Histórico de alertas">{alertas.length ? <div className="alert-history">{alertas.map((a) => { const end = a.resolvidoEm ? new Date(a.resolvidoEm) : new Date(); const minutes = Math.max(0, Math.floor((end - new Date(a.iniciadoEm)) / 60000)); const duration = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}min`; return <div key={a.id} className={`alert-history-item ${a.ativo ? 'ativo' : 'resolvido'}`}><div className="ah-top"><span className={`alert ${a.nivel}`}>{a.mensagem}</span><span className="ah-badge">{a.ativo ? 'ATIVO' : 'RESOLVIDO'}</span></div><div className="ah-meta">Início: {fmtDate(a.iniciadoEm)}{a.resolvidoEm ? ` · Fim: ${fmtDate(a.resolvidoEm)}` : ''} · Duração: {duration}</div></div> })}</div> : <div className="muted">Nenhum alerta registrado para este equipamento.</div>}</Section></>}
        {tab === 'actions' && <><Section title="Ações remotas"><div className="remote-actions-layout"><div className="remote-actions-available"><div className="action-toolbar"><span className="muted">Ações genéricas, incluindo serviços do Windows.</span>{online && !remoteInProgress && <button type="button" className="btn-update" onClick={() => setSpoolerConfirm(true)}>Reiniciar spooler</button>}{!online && <span className="muted">Computador offline: ação remota indisponível.</span>}</div>{spoolerConfirm && <ConfirmBox onCancel={() => setSpoolerConfirm(false)} onConfirm={triggerSpoolerReset} confirmLabel="Reiniciar">Reiniciar o spooler de impressão de <strong>{c.hostname}</strong>?</ConfirmBox>}{serviceRestartError && <div className="update-status failed">{serviceRestartError}</div>}{online && !serviceInProgress && <button type="button" className="btn-update" onClick={() => setServiceRestartConfirm(true)}>Reiniciar serviço Spooler</button>}{serviceRestartConfirm && <ConfirmBox onCancel={() => setServiceRestartConfirm(false)} onConfirm={triggerServiceRestart} confirmLabel="Reiniciar serviço">Reiniciar o serviço Spooler de <strong>{c.hostname}</strong>?</ConfirmBox>}{online && !remoteInProgress && <button type="button" className="btn-update" onClick={() => setWallpaperConfirm(true)}>Aplicar papel de parede padrão</button>}{wallpaperError && <div className="update-status failed">{wallpaperError}</div>}{wallpaperConfirm && <ConfirmBox onCancel={() => setWallpaperConfirm(false)} onConfirm={triggerWallpaper} confirmLabel="Aplicar">Aplicar o papel de parede padrão neste computador?<br /><small>Hostname: {c.hostname} · Status: {online ? 'Online' : 'Offline'} · Asset: WallPaperVava.jpg · Resolução: 1920x1080</small></ConfirmBox>}</div><div className="remote-actions-history">{genericActions.length ? <div className="action-list">{genericActions.map((a) => <ActionItem key={a.actionExecutionId} action={a} />)}</div> : <div className="muted">Nenhuma ação remota registrada.</div>}</div></div></Section></>}
      {tab === 'maintenance' && <Section title="Manutenção do sistema"><div className="action-toolbar"><span className="muted">Histórico de system_maintenance.</span>{online && !maintenanceInProgress && <button type="button" className="btn-update" onClick={() => setSystemMaintenanceConfirm(true)}>Executar manutenção</button>}{!online && <span className="muted">Computador offline: ação remota indisponível.</span>}</div>{systemMaintenanceError && <div className="update-status failed">{systemMaintenanceError}</div>}{systemMaintenanceConfirm && <ConfirmBox onCancel={() => setSystemMaintenanceConfirm(false)} onConfirm={triggerSystemMaintenance} confirmLabel="Executar manutenção">Executar a manutenção preventiva do Windows na máquina <strong>{c.hostname}</strong>?</ConfirmBox>}{maintenanceActions.length ? <div className="action-list">{maintenanceActions.map((action) => <details className="action-item" key={action.actionExecutionId}><summary><span><strong>{fmtDate(action.solicitadaEm)}</strong><small>{action.mensagem || 'Manutenção do sistema'}</small></span><StatusTag status={action.status} /></summary><div className="maintenance-result">{action.resultado?.overallStatus && <Field label="Resultado">{action.resultado.overallStatus}</Field>}{action.resultado?.rebootRecommended != null && <Field label="Reinicialização recomendada">{action.resultado.rebootRecommended ? 'Sim' : 'Não'}</Field>}{action.resultado?.steps?.length ? action.resultado.steps.map((step) => <div className="maintenance-step" key={step.key}><span>{({ temp_cleanup: 'Temporários', sfc: 'SFC', dism: 'DISM', dns_flush: 'DNS' }[step.key] || step.key)}</span><StatusTag status={step.status} /><small>{step.durationMs != null ? `${step.durationMs} ms` : 'Sem duração informada'}</small></div>) : <div className="muted">Resultado detalhado não disponível.</div>}</div></details>)}</div> : <div className="muted">Nenhuma execução de manutenção registrada.</div>}</Section>}
    </div>
  </>

  if (drawer) return <div className="drawer-backdrop" onClick={onClose}><aside className="details-drawer" onClick={(event) => event.stopPropagation()}>{body}</aside></div>
  return <div className="container"><SiteNav /><Link className="back-link" to="/">← Voltar ao Dashboard</Link><div className="detail-page">{body}</div></div>
}
