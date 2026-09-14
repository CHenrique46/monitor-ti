import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import SiteNav from './SiteNav'
import MetricChart from './MetricChart'
import { computeAlerts } from '../utils/alerts'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { useAuth } from '../auth/AuthContext'
import { bytesToGB, formatUptime, formatPercent, sistemaLabel, fmtDate } from '../utils/formatters'
import { getUptimeStatus, UPTIME_STATUS, uptimeStatusLabel } from '../utils/uptime'
import { compareVersions, isVersionNewer } from '../utils/version'
import { activationStatus, displayProductName, licenseType, normalizeOffice, partialKey } from '../utils/office'
import { buildInventoryBaselinePayload, canAddInventory } from '../utils/inventoryBaseline'
import { buildAgentUpdateRequest, preserveSelectedAgentRelease, releaseStatusLabel, sortAgentReleases } from '../utils/agentReleases'

function MetricBar({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0))
  const cls = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''
  return <div className="bar"><div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} /></div>
}

function Field({ label, children }) {
  return <div className="detail-field"><span className="detail-key">{label}</span><span className="detail-val">{children ?? 'Não informado'}</span></div>
}

function formatDiskBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '-'
  const value = Number(bytes)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function Section({ title, children }) {
  return <section className="detail-section"><h3>{title}</h3><div className="detail-grid">{children}</div></section>
}

const inventoryLabels = { CPU: 'Processador', RAM: 'Memória', STORAGE: 'Armazenamento', WINDOWS: 'Windows', OFFICE: 'Office', OFFICE_PARTIAL_KEY: 'Chave Office' }
const inventoryStatusLabels = { MATCH: 'De acordo', DIFFERENT: 'Divergente', NO_BASELINE: 'Sem inventário', NO_AGENT_DATA: 'Aguardando dados da máquina', NOT_COMPARABLE: 'Não comparável' }

function InventorySection({ result }) {
  if (!result) return <Section title="Inventário"><div className="muted">Não foi possível carregar o inventário.</div></Section>
  const excelLabels = { PENDING: 'Sincronização com Excel pendente', PROCESSING: 'Sincronização com Excel em andamento', SYNCED: 'Sincronizado com Excel', FAILED: 'Sincronização com Excel falhou' }
  return <Section title="Inventário"><div className="inventory-comparison">{result.excelSync && <div className={`update-status ${result.excelSync.status === 'FAILED' ? 'failed' : ''}`}>{excelLabels[result.excelSync.status] || `Excel: ${result.excelSync.status}`}</div>}{result.comparison.map((item) => <div className={`inventory-comparison-row ${item.status.toLowerCase()}`} key={item.field}><div className="inventory-comparison-title"><strong>{inventoryLabels[item.field] || item.field}</strong><span>{item.status === 'MATCH' ? '✓' : item.status === 'DIFFERENT' ? '⚠' : '·'}</span></div><span className="inventory-comparison-status">{inventoryStatusLabels[item.status] || item.status}</span>{item.status === 'DIFFERENT' && <div className="inventory-comparison-values"><span>Inventário: {item.expected || 'Não informado'}</span><span>Máquina: {item.actual || 'Não informado'}</span></div>}</div>)}</div></Section>
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

function NormalizedProduct({ product }) {
  const activation = activationStatus(product.primaryLicense?.activationStatus)
  const key = partialKey(product.primaryLicense?.partialProductKey)
  return <article className="office-installation office-product">
    <div className="office-installation-header"><div><strong>{displayProductName(product.productName) || 'Produto não informado'}</strong></div>{product.primaryLicense?.activationStatus === 'LICENSED' && <span className="office-status ok">Licenciado</span>}</div>
    {key && <OfficeField label="Chave parcial" value={key} />}
  </article>
}

function OfficeComponent({ component }) {
  return <div className="office-component"><strong>{component.productName || 'Componente não informado'}</strong><span>Versão {component.version || 'não informada'}</span></div>
}

function OfficeSection({ office }) {
  const inventory = normalizeOffice(office)
  return <section className="detail-section office-section"><h3>Microsoft Office</h3>
    {inventory.normalized ? <>{inventory.normalized.products.length ? inventory.normalized.products.map((product, index) => <NormalizedProduct key={index} product={product} />) : <div className="office-empty"><strong>Office não identificado.</strong></div>}{inventory.installations.length ? <details className="office-technical-details"><summary>Detalhes técnicos</summary><div className="office-installations">{inventory.installations.map((installation, index) => <OfficeInstallationCard key={installation.id || index} installation={installation} />)}</div></details> : null}</> : inventory.installations.length ? <div className="office-installations">{inventory.installations.map((installation, index) => <OfficeInstallationCard key={installation.id || index} installation={installation} />)}</div> : <div className="office-empty"><strong>Informação ainda não disponível.</strong></div>}
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

function ConfirmBox({ children, onCancel, onConfirm, confirmLabel, disabled = false }) {
  return <div className="confirm-box"><p>{children}</p><div className="confirm-actions"><button type="button" className="btn-cancel" onClick={onCancel} disabled={disabled}>Cancelar</button><button type="button" className="btn-update" onClick={onConfirm} disabled={disabled}>{confirmLabel}</button></div></div>
}

function AddInventoryModal({ computer, form, saving, error, onChange, onCancel, onConfirm }) {
  const office = computer.office?.normalized?.products?.[0]
  const officeKey = partialKey(office?.primaryLicense?.partialProductKey)
  const storage = computer.discosFisicos?.map((disk) => disk.tamanho != null ? bytesToGB(disk.tamanho) : null).filter(Boolean).join(', ')
  return <div className="modal-backdrop" role="presentation"><section className="delete-dialog inventory-baseline-dialog" role="dialog" aria-modal="true" aria-labelledby="add-inventory-title" onClick={(event) => event.stopPropagation()}>
    <span className="section-kicker">Confirmação administrativa</span>
    <h2 id="add-inventory-title">Adicionar ao inventário</h2>
    <div className="delete-computer-meta"><span>Hostname: <strong>{computer.hostname}</strong></span><span>CPU: {computer.processador || 'Não informado'}</span><span>RAM: {computer.ramTotal != null ? bytesToGB(computer.ramTotal) : 'Não informado'}</span><span>Armazenamento: {storage || 'Não informado'}</span><span>Windows: {computer.sistemaRelease || computer.sistema || 'Não informado'}</span><span>Office: {office?.productName || 'Não informado'}{office?.primaryLicense?.activationStatus ? ` · ${activationStatus(office.primaryLicense.activationStatus).label}` : ''}</span>{officeKey && <span>Final da chave: {officeKey}</span>}</div>
    <p className="muted">Confirme apenas a identidade administrativa. Os dados técnicos serão obtidos pelo servidor.</p>
    <label className="delete-confirm-field">Número do equipamento<input value={form.equipamentoNumero} maxLength={64} onChange={(event) => onChange('equipamentoNumero', event.target.value)} /></label>
    <label className="delete-confirm-field">Apelido / usuário atual<input value={form.apelido} maxLength={120} onChange={(event) => onChange('apelido', event.target.value)} /></label>
    {error && <div className="update-status failed">{error}</div>}
    <div className="confirm-actions"><button type="button" className="btn-cancel" onClick={onCancel} disabled={saving}>Cancelar</button><button type="button" className="btn-update" onClick={onConfirm} disabled={saving}>{saving ? 'Adicionando...' : 'Adicionar ao inventário'}</button></div>
  </section></div>
}

export default function ComputerDetails({ computerId, latestVersion, onClose }) {
  const { user } = useAuth()
  const isAdmin = user.role === 'ADMIN'
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
  const [releases, setReleases] = useState([])
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
  const [editingIdentity, setEditingIdentity] = useState(false)
  const [identityForm, setIdentityForm] = useState({ apelido: '', equipamentoNumero: '' })
  const [identitySaving, setIdentitySaving] = useState(false)
  const [identityError, setIdentityError] = useState(null)
  const [inventoryComparison, setInventoryComparison] = useState(null)
  const [addInventoryOpen, setAddInventoryOpen] = useState(false)
  const [addInventoryForm, setAddInventoryForm] = useState({ equipamentoNumero: '', apelido: '' })
  const [addInventorySaving, setAddInventorySaving] = useState(false)
  const [addInventoryError, setAddInventoryError] = useState(null)
  const [diskCleanupError, setDiskCleanupError] = useState(null)
  const [diskCapabilities, setDiskCapabilities] = useState([])
  const [updateSubmitting, setUpdateSubmitting] = useState(false)
  const updateRequestInFlight = useRef(false)

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
    if (tab !== 'disk_cleanup') return undefined
    let active = true
    const loadCapabilities = async () => {
      try {
        const response = await apiFetch(`${API_URL}/api/computadores/${id}/capabilities`)
        const body = response.ok ? await response.json() : {}
        if (active) setDiskCapabilities(Array.isArray(body.capabilities) ? body.capabilities : [])
      } catch {
        if (active) setDiskCapabilities([])
      }
    }
    loadCapabilities()
    return () => { active = false }
  }, [id, tab])

  useEffect(() => {
    let active = true
    const loadComparison = async () => { try { const r = await apiFetch(`${API_URL}/api/computadores/${id}/inventory-comparison`); if (active) setInventoryComparison(r.ok ? await r.json() : null) } catch { if (active) setInventoryComparison(null) } }
    loadComparison(); const interval = setInterval(loadComparison, 60000)
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
    let active = true
    const loadRelease = async () => {
      if (!isAdmin) {
        if (active) setRelease(latestVersion ? { version: latestVersion, active: true } : null)
        return
      }
      try {
        const r = await apiFetch(`${API_URL}/api/agent/releases`)
        if (!r.ok) throw new Error('Falha ao carregar releases')
        const catalog = sortAgentReleases(await r.json())
        if (active) {
          setReleases(catalog)
          setRelease((current) => preserveSelectedAgentRelease(current, catalog))
        }
      } catch {
        if (active) {
          setReleases([])
          setRelease(latestVersion ? { version: latestVersion, active: true } : null)
        }
      }
    }
    loadRelease(); const interval = setInterval(loadRelease, 30000)
    return () => { active = false; clearInterval(interval) }
  }, [isAdmin, latestVersion])

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
  const triggerUpdate = async () => {
    if (updateRequestInFlight.current || !release?.version) return
    updateRequestInFlight.current = true
    setConfirm(false)
    setUpdateSubmitting(true)
    try {
      await request('/agent-update', buildAgentUpdateRequest(release.version), (message) => setUpdateStatus({ status: 'update_failed', message }))
    } finally {
      updateRequestInFlight.current = false
      setUpdateSubmitting(false)
    }
  }
  const triggerSpoolerReset = async () => { setSpoolerConfirm(false); await request('/actions/spooler-reset', { method: 'POST' }, () => {}) }
  const triggerServiceRestart = async () => { setServiceRestartConfirm(false); setServiceRestartError(null); await request('/actions/service-restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceKey: 'spooler' }) }, setServiceRestartError) }
  const triggerSystemMaintenance = async () => { setSystemMaintenanceConfirm(false); setSystemMaintenanceError(null); await request('/actions/system-maintenance', { method: 'POST' }, setSystemMaintenanceError) }
  const triggerDiskCleanupAnalysis = async () => { setDiskCleanupError(null); await request('/actions/disk-cleanup-analyze', { method: 'POST' }, setDiskCleanupError) }
  const triggerWallpaper = async () => { setWallpaperConfirm(false); setWallpaperError(null); await request('/actions/set-wallpaper', { method: 'POST' }, setWallpaperError) }
  const beginIdentityEdit = () => { setIdentityForm({ apelido: c.apelido || '', equipamentoNumero: c.equipamentoNumero || '' }); setIdentityError(null); setEditingIdentity(true) }
  const saveIdentity = async () => {
    setIdentitySaving(true); setIdentityError(null)
    try {
      const r = await apiFetch(`${API_URL}/api/computadores/${id}/inventory-metadata`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(identityForm) })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) { setIdentityError(body.erro || 'Não foi possível salvar a identificação.'); return }
      setC((previous) => ({ ...previous, ...body })); setEditingIdentity(false)
    } catch { setIdentityError('Não foi possível salvar a identificação.') } finally { setIdentitySaving(false) }
  }
  const beginAddInventory = () => { setAddInventoryForm({ equipamentoNumero: c.equipamentoNumero || '', apelido: c.apelido || '' }); setAddInventoryError(null); setAddInventoryOpen(true) }
  const addToInventory = async () => {
    setAddInventorySaving(true); setAddInventoryError(null)
    try {
      const response = await apiFetch(`${API_URL}/api/computadores/${id}/inventory-baseline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildInventoryBaselinePayload(addInventoryForm)) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) { setAddInventoryError(body.erro || 'Não foi possível adicionar ao inventário.'); return }
      const [computerResponse, comparisonResponse] = await Promise.all([apiFetch(`${API_URL}/api/computadores/${id}`), apiFetch(`${API_URL}/api/computadores/${id}/inventory-comparison`)
      ])
       if (computerResponse.ok) setC(await computerResponse.json())
       if (comparisonResponse.ok) setInventoryComparison(await comparisonResponse.json())
      setAddInventoryOpen(false)
    } catch { setAddInventoryError('Não foi possível adicionar ao inventário.') } finally { setAddInventorySaving(false) }
  }

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
  const versionComparison = release ? compareVersions(c.agentVersion, release.version) : null
  const inProgress = updateStatus && ['update_pending', 'update_downloading', 'update_validating', 'update_installing'].includes(updateStatus.status)
  const genericActions = remoteActions.filter((a) => a.action !== 'system_maintenance')
  const maintenanceActions = remoteActions.filter((a) => a.action === 'system_maintenance')
  const serviceActions = genericActions.filter((a) => a.action === 'service_restart')
  const remoteInProgress = remoteActions.some((a) => ['PENDING', 'DISPATCHED', 'RUNNING'].includes(a.status))
  const serviceInProgress = serviceActions.some((a) => ['PENDING', 'DISPATCHED', 'RUNNING'].includes(a.status))
  const maintenanceInProgress = maintenanceActions.some((a) => ['PENDING', 'DISPATCHED', 'RUNNING'].includes(a.status))
  const diskCleanupActions = remoteActions.filter((a) => a.action === 'disk_cleanup_analyze')
  const supportsDiskCleanupAnalyze = diskCapabilities.includes('disk_cleanup_analyze')
  const latestDiskCleanup = diskCleanupActions[0] || null
  const diskAnalysis = latestDiskCleanup?.resultado || null
  const diskAnalysisInProgress = latestDiskCleanup && ['PENDING', 'DISPATCHED', 'RUNNING'].includes(latestDiskCleanup.status)
  const diskCategoryBytes = (id) => diskAnalysis?.categories?.find((category) => category.id === id)?.eligibleBytes
  const tabs = [['summary', 'Resumo'], ['hardware', 'Hardware'], ['alerts', `Alertas${alerts.length ? ` (${alerts.length})` : ''}`], ['actions', 'Ações'], ['maintenance', 'Manutenção'], ['disk_cleanup', 'Limpeza de Disco']]
  const body = <div className={isAdmin ? '' : 'viewer-mode'}>
    <header className={`drawer-header ${cardClass}`}>
      <div><span className="section-kicker">Detalhes do computador</span><h1>{c.apelido || c.hostname || '(sem nome)'}</h1><div className="drawer-meta"><span>{c.hostname || 'Hostname não informado'}</span>{c.equipamentoNumero && <span>Equip. {c.equipamentoNumero}</span>}<span className={online ? 'online' : 'offline'}>{online ? '● Online' : '● Offline'}</span><span>{c.ip || 'IP não informado'}</span><span>Agent v{c.agentVersion || '?'}</span><span>Última comunicação: {fmtDate(c.ultimaConexao)}</span></div></div>
      <button type="button" className="drawer-close" onClick={onClose || (() => window.history.back())} aria-label="Fechar detalhes">×</button>
    </header>
    {!serverOk && <p className="server-warn">Não foi possível atualizar os dados.</p>}
    <nav className="detail-tabs" aria-label="Seções do computador">{tabs.map(([key, label]) => <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <div className="drawer-content">
       {tab === 'summary' && <>
         <Section title="Identificação"><Field label="Apelido">{c.apelido || 'Não informado'}</Field><Field label="Equipamento">{c.equipamentoNumero || 'Não informado'}</Field>{!editingIdentity ? <button type="button" className="btn-update identity-edit-button" onClick={beginIdentityEdit}>Editar identificação</button> : <div className="identity-form"><label>Apelido<input type="text" value={identityForm.apelido} maxLength={120} onChange={(event) => setIdentityForm((form) => ({ ...form, apelido: event.target.value }))} /></label><label>Nº do equipamento<input type="text" value={identityForm.equipamentoNumero} maxLength={64} onChange={(event) => setIdentityForm((form) => ({ ...form, equipamentoNumero: event.target.value }))} /></label><div className="confirm-actions"><button type="button" className="btn-cancel" onClick={() => setEditingIdentity(false)} disabled={identitySaving}>Cancelar</button><button type="button" className="btn-update" onClick={saveIdentity} disabled={identitySaving}>{identitySaving ? 'Salvando...' : 'Salvar'}</button></div>{identityError && <div className="update-status failed">{identityError}</div>}</div>}</Section>
         {canAddInventory(inventoryComparison) && <button type="button" className="btn-update inventory-add-button" onClick={beginAddInventory}>Adicionar ao inventário</button>}
         <div className="summary-metrics"><div><span>CPU</span><strong>{formatPercent(c.cpuUso)}</strong><MetricBar value={c.cpuUso} /></div><div><span>RAM</span><strong>{bytesToGB(c.ramUsada)} / {bytesToGB(c.ramTotal)}</strong><MetricBar value={ramPct} /></div><div><span>Disco C:</span><strong>{bytesToGB(c.discoLivre)} livres</strong><MetricBar value={discoPct} /></div></div>
        <Section title="Estado atual"><Field label="Status">{online ? 'Online' : 'Offline'}</Field><Field label={online ? 'Uptime atual' : 'Último uptime registrado'}>{formatUptime(c.uptime)}</Field><Field label="Status do uptime"><span className={`uptime-status ${uptimeStatus.toLowerCase()}`}>{uptimeStatusLabel(uptimeStatus)}</span></Field><Field label="Usuário">{c.usuario || 'Não informado'}</Field><Field label="Device ID">{c.deviceId}</Field></Section>
        {uptimeNeedsAttention && <div className={`uptime-notice ${uptimeStatus === UPTIME_STATUS.REBOOT_RECOMMENDED ? 'recommended' : ''}`}><strong>{uptimeStatusLabel(uptimeStatus)}</strong><span>{online ? `Este computador está há ${formatUptime(c.uptime)} sem reiniciar.` : `Último uptime registrado: ${formatUptime(c.uptime)}. O valor não é incrementado enquanto offline.`}</span></div>}
        <Section title="Histórico de métricas"><div className="period-selector">{['24h', '7d', '30d'].map((p) => <button key={p} type="button" className={periodo === p ? 'period-btn active' : 'period-btn'} onClick={() => setPeriodo(p)}>{p === '24h' ? '24 horas' : p === '7d' ? '7 dias' : '30 dias'}</button>)}</div><MetricChart title="CPU %" data={metricas} dataKey="cpuUso" color="#38bdf8" /><MetricChart title="RAM %" data={metricas} dataKey="ramUsoPct" color="#a78bfa" /><MetricChart title="Disco %" data={metricas} dataKey="discoUsoPct" color="#f59e0b" /></Section>
      </>}
        {tab === 'hardware' && <>
          <InventorySection result={inventoryComparison} />
          <Section title="Sistema"><Field label="Sistema">{sistemaLabel(c.sistema)}</Field><Field label="Release">{c.sistemaRelease}</Field><Field label="Arquitetura">{c.arquitetura}</Field><Field label="Build Windows">{c.sistemaBuild}</Field></Section>
         <OfficeSection office={c.office} />
         <Section title="Processador"><Field label="Modelo">{c.processador}</Field><Field label="CPUs lógicas">{c.cpusLogicas}</Field><Field label="Fabricante">{c.fabricante}</Field><Field label="Modelo do equipamento">{c.modeloEquipamento}</Field></Section>
        <Section title="Memória e armazenamento"><Field label="RAM total">{bytesToGB(c.ramTotal)}</Field><Field label="RAM usada">{bytesToGB(c.ramUsada)}</Field><Field label="Disco total">{bytesToGB(c.discoTotal)}</Field><Field label="Disco livre">{bytesToGB(c.discoLivre)}</Field></Section>
        <Section title="Equipamento"><Field label="Número de série">{c.numeroSerie}</Field><Field label="GPU">{c.gpu}</Field><Field label="MAC">{c.mac}</Field><Field label="Placa-mãe">{[c.placaMaeFabricante, c.placaMaeModelo].filter(Boolean).join(' / ')}</Field><Field label="BIOS">{[c.biosFabricante, c.biosVersao].filter(Boolean).join(' / ')}</Field></Section>
        <Section title="Discos físicos">{c.discosFisicos?.length ? c.discosFisicos.map((d, i) => <div className="inventory-row" key={d.id || i}><strong>Disco {i + 1}</strong><span>{d.modelo || 'Modelo não informado'} · {d.tamanho != null ? bytesToGB(d.tamanho) : 'Capacidade não informada'} · {d.interface || 'Interface não informada'}</span></div>) : <div className="muted">Nenhum disco físico informado.</div>}</Section>
        <Section title="Agent"><Field label="Versão instalada">v{c.agentVersion || 'desconhecida'}</Field>{isAdmin && releases.length > 0 && <label className="agent-release-selector">Versão selecionada<select value={release?.version || ''} onChange={(event) => setRelease(releases.find((item) => item.version === event.target.value) || null)}><option value="" disabled>Selecione uma release</option>{releases.map((item) => <option key={item.id} value={item.version}>v{item.version} — {releaseStatusLabel(item)}</option>)}</select></label>}{release && !isAdmin && <Field label="Versão disponível">v{release.version}</Field>}{release && isAdmin && <Field label="Versão selecionada">v{release.version} — {releaseStatusLabel(release)}</Field>}{release && !updateAvailable && <div className="update-ok">✓ Agent atualizado{versionComparison > 0 ? <small>Versão instalada superior à versão publicada</small> : versionComparison === 0 ? ` (v${release.version})` : null}</div>}{updateStatus && <div className={`update-status ${updateStatus.status === 'update_failed' ? 'failed' : updateStatus.status === 'update_success' ? 'ok' : 'running'}`}>{updateStatus.status}{updateStatus.message ? ` — ${updateStatus.message}` : ''}</div>}{isAdmin && release && updateAvailable && online && !inProgress && !updateSubmitting && <button type="button" className="btn-update" onClick={() => setConfirm(true)}>Atualizar Agent</button>}{isAdmin && !online && updateAvailable && <div className="muted">Computador offline: não é possível atualizar agora.</div>}{isAdmin && confirm && <ConfirmBox onCancel={() => setConfirm(false)} onConfirm={triggerUpdate} confirmLabel="Atualizar" disabled={updateSubmitting}>Atualizar apenas esta máquina <strong>{c.hostname}</strong> para o Agent v{release.version}?<br /><small>Versão atual: v{c.agentVersion || 'desconhecida'} · Release: {releaseStatusLabel(release)}<br />Esta ação não atualiza outras máquinas.</small></ConfirmBox>}</Section>
      </>}
      {tab === 'alerts' && <><Section title="Alertas ativos">{alerts.length ? alerts.map((a, i) => <div key={i} className={`alert ${a.severity}`}>⚠ {a.msg}</div>) : <div className="muted">Nenhum alerta ativo.</div>}</Section><Section title="Histórico de alertas">{alertas.length ? <div className="alert-history">{alertas.map((a) => { const end = a.resolvidoEm ? new Date(a.resolvidoEm) : new Date(); const minutes = Math.max(0, Math.floor((end - new Date(a.iniciadoEm)) / 60000)); const duration = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}min`; return <div key={a.id} className={`alert-history-item ${a.ativo ? 'ativo' : 'resolvido'}`}><div className="ah-top"><span className={`alert ${a.nivel}`}>{a.mensagem}</span><span className="ah-badge">{a.ativo ? 'ATIVO' : 'RESOLVIDO'}</span></div><div className="ah-meta">Início: {fmtDate(a.iniciadoEm)}{a.resolvidoEm ? ` · Fim: ${fmtDate(a.resolvidoEm)}` : ''} · Duração: {duration}</div></div> })}</div> : <div className="muted">Nenhum alerta registrado para este equipamento.</div>}</Section></>}
        {tab === 'actions' && <><Section title="Ações remotas"><div className="remote-actions-layout"><div className="remote-actions-available"><div className="action-toolbar"><span className="muted">Ações genéricas, incluindo serviços do Windows.</span>{online && !remoteInProgress && <button type="button" className="btn-update" onClick={() => setSpoolerConfirm(true)}>Reiniciar spooler</button>}{!online && <span className="muted">Computador offline: ação remota indisponível.</span>}</div>{spoolerConfirm && <ConfirmBox onCancel={() => setSpoolerConfirm(false)} onConfirm={triggerSpoolerReset} confirmLabel="Reiniciar">Reiniciar o spooler de impressão de <strong>{c.hostname}</strong>?</ConfirmBox>}{serviceRestartError && <div className="update-status failed">{serviceRestartError}</div>}{online && !serviceInProgress && <button type="button" className="btn-update" onClick={() => setServiceRestartConfirm(true)}>Reiniciar serviço Spooler</button>}{serviceRestartConfirm && <ConfirmBox onCancel={() => setServiceRestartConfirm(false)} onConfirm={triggerServiceRestart} confirmLabel="Reiniciar serviço">Reiniciar o serviço Spooler de <strong>{c.hostname}</strong>?</ConfirmBox>}{online && !remoteInProgress && <button type="button" className="btn-update" onClick={() => setWallpaperConfirm(true)}>Aplicar papel de parede padrão</button>}{wallpaperError && <div className="update-status failed">{wallpaperError}</div>}{wallpaperConfirm && <ConfirmBox onCancel={() => setWallpaperConfirm(false)} onConfirm={triggerWallpaper} confirmLabel="Aplicar">Aplicar o papel de parede padrão neste computador?<br /><small>Hostname: {c.hostname} · Status: {online ? 'Online' : 'Offline'} · Asset: WallPaperVava.jpg · Resolução: 1920x1080</small></ConfirmBox>}</div><div className="remote-actions-history">{genericActions.length ? <div className="action-list">{genericActions.map((a) => <ActionItem key={a.actionExecutionId} action={a} />)}</div> : <div className="muted">Nenhuma ação remota registrada.</div>}</div></div></Section></>}
       {tab === 'maintenance' && <Section title="Manutenção do sistema"><div className="action-toolbar"><span className="muted">Histórico de system_maintenance.</span>{online && !maintenanceInProgress && <button type="button" className="btn-update" onClick={() => setSystemMaintenanceConfirm(true)}>Executar manutenção</button>}{!online && <span className="muted">Computador offline: ação remota indisponível.</span>}</div>{systemMaintenanceError && <div className="update-status failed">{systemMaintenanceError}</div>}{systemMaintenanceConfirm && <ConfirmBox onCancel={() => setSystemMaintenanceConfirm(false)} onConfirm={triggerSystemMaintenance} confirmLabel="Executar manutenção">Executar a manutenção preventiva do Windows na máquina <strong>{c.hostname}</strong>?</ConfirmBox>}{maintenanceActions.length ? <div className="action-list">{maintenanceActions.map((action) => <details className="action-item" key={action.actionExecutionId}><summary><span><strong>{fmtDate(action.solicitadaEm)}</strong><small>{action.mensagem || 'Manutenção do sistema'}</small></span><StatusTag status={action.status} /></summary><div className="maintenance-result">{action.resultado?.overallStatus && <Field label="Resultado">{action.resultado.overallStatus}</Field>}{action.resultado?.rebootRecommended != null && <Field label="Reinicialização recomendada">{action.resultado.rebootRecommended ? 'Sim' : 'Não'}</Field>}{action.resultado?.steps?.length ? action.resultado.steps.map((step) => <div className="maintenance-step" key={step.key}><span>{({ temp_cleanup: 'Temporários', sfc: 'SFC', dism: 'DISM', dns_flush: 'DNS' }[step.key] || step.key)}</span><StatusTag status={step.status} /><small>{step.durationMs != null ? `${step.durationMs} ms` : 'Sem duração informada'}</small></div>) : <div className="muted">Resultado detalhado não disponível.</div>}</div></details>)}</div> : <div className="muted">Nenhuma execução de manutenção registrada.</div>}</Section>}
           {tab === 'disk_cleanup' && <Section title="Limpeza de Disco"><div className="disk-cleanup-panel"><p className="muted">Somente análise. Nenhum arquivo é removido.</p>{diskCleanupError && <div className="update-status failed">{diskCleanupError}</div>}{diskAnalysisInProgress && <div className="muted">Analisando espaço potencialmente recuperável...</div>}{diskAnalysis && <div className="disk-cleanup-result"><Field label="Espaço livre atual">{formatDiskBytes(diskAnalysis.freeBytesBefore)}</Field><Field label="Temporários do usuário">{formatDiskBytes(diskCategoryBytes('USER_TEMP'))}</Field><Field label="Temporários do Windows">{formatDiskBytes(diskCategoryBytes('WINDOWS_TEMP'))}</Field><Field label="Temporários adicionais">{formatDiskBytes(diskCategoryBytes('OTHER_TEMP'))}</Field><Field label="Lixeira">{formatDiskBytes(diskCategoryBytes('RECYCLE_BIN'))}</Field><Field label="Potencialmente recuperável"><strong>{formatDiskBytes(diskAnalysis.estimatedRecoverableBytes)}</strong></Field><Field label="Última análise">{fmtDate(latestDiskCleanup.concluidaEm || latestDiskCleanup.solicitadaEm)}</Field><Field label="Duração">{diskAnalysis.durationMs != null ? `${(Number(diskAnalysis.durationMs) / 1000).toFixed(1)} s` : '-'}</Field>{diskAnalysis.truncated && <div className="update-status failed">Análise parcial: alguns itens não puderam ser contabilizados.</div>}</div>}{!diskAnalysis && !diskAnalysisInProgress && <div className="muted">Nenhuma análise realizada.</div>}{isAdmin && !supportsDiskCleanupAnalyze && <p className="muted">Disponível após atualização do Agent.</p>}<button type="button" className="btn-update" onClick={triggerDiskCleanupAnalysis} disabled={!isAdmin || !online || !supportsDiskCleanupAnalyze || !!diskAnalysisInProgress}>{!isAdmin ? 'Disponível apenas para ADMIN' : diskAnalysisInProgress ? 'Analisando...' : 'Analisar'}</button></div></Section>}
    </div>
  </div>

  const addInventoryDialog = addInventoryOpen && <AddInventoryModal computer={c} form={addInventoryForm} saving={addInventorySaving} error={addInventoryError} onChange={(field, value) => setAddInventoryForm((current) => ({ ...current, [field]: value }))} onCancel={() => setAddInventoryOpen(false)} onConfirm={addToInventory} />
  if (drawer) return <div className="drawer-backdrop" onClick={onClose}><aside className="details-drawer" onClick={(event) => event.stopPropagation()}>{body}</aside>{addInventoryDialog}</div>
  return <div className="container"><SiteNav /><Link className="back-link" to="/">← Voltar ao Dashboard</Link><div className="detail-page">{body}</div>{addInventoryDialog}</div>
}
