import { useEffect, useState } from 'react'
import SiteNav from './SiteNav'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { useAuth } from '../auth/AuthContext'

const PAGE_SIZE = 25

function displayFolder(value) {
  return value ? value.replace(/[_-]+/g, ' ') : 'Raiz do catálogo'
}

function SummaryCard({ label, value, detail }) {
  return <div className="summary-item certificate-summary-card"><span className="summary-num">{value}</span><span className="summary-label">{label}</span>{detail && <small>{detail}</small>}</div>
}

function CertificateRow({ certificate }) {
  return <article className="certificate-row">
    <div className="certificate-main">
      <strong>{certificate.nomeEmpresa || certificate.nomeExibicao}</strong>
      <span>{certificate.documento || 'Documento não identificado'}</span>
    </div>
    <div className="certificate-meta">
      <span className="certificate-badge">A1</span>
      <span className="certificate-badge">{certificate.extensao?.replace('.', '').toUpperCase() || 'CERT'}</span>
      {certificate.anoReferencia && <span className="certificate-badge">{certificate.anoReferencia}</span>}
      <span className="certificate-folder">{displayFolder(certificate.pastaLogica)}</span>
      <span className="certificate-status">Validade ainda não identificada</span>
    </div>
  </article>
}

export default function Certificados() {
  const { user } = useAuth()
  const isAdmin = user.role === 'ADMIN'
  const [search, setSearch] = useState('')
  const [year, setYear] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState(null)
  const [summary, setSummary] = useState({ total: null, year2025: null, year2026: null })
  const [loading, setLoading] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [error, setError] = useState('')
  const [summaryError, setSummaryError] = useState(false)
  const [syncInfo, setSyncInfo] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [catalogRevision, setCatalogRevision] = useState(0)

  useEffect(() => {
    if (!isAdmin) return undefined
    const controller = new AbortController()
    let active = true
    setSummaryLoading(true)
    Promise.all([
      apiFetch(`${API_URL}/api/certificados?page=1&pageSize=1`, { signal: controller.signal }),
      apiFetch(`${API_URL}/api/certificados?page=1&pageSize=1&ano=2025`, { signal: controller.signal }),
      apiFetch(`${API_URL}/api/certificados?page=1&pageSize=1&ano=2026`, { signal: controller.signal })
    ]).then(async (responses) => {
      if (!active) return
      if (responses.some((response) => !response.ok)) throw new Error('summary')
      const bodies = await Promise.all(responses.map((response) => response.json()))
      setSummary({ total: bodies[0].total, year2025: bodies[1].total, year2026: bodies[2].total })
      setSummaryError(false)
    }).catch((loadError) => {
      if (loadError.name !== 'AbortError' && active) setSummaryError(true)
    }).finally(() => { if (active) setSummaryLoading(false) })
    apiFetch(`${API_URL}/api/certificados/sincronizacao-atual`, { signal: controller.signal }).then(async (response) => {
      if (!active || !response.ok) return
      setSyncInfo(await response.json())
    }).catch(() => {})
    return () => { active = false; controller.abort() }
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin) return undefined
    const controller = new AbortController()
    let active = true
    const timer = setTimeout(() => {
      setLoading(true)
      setError('')
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search.trim()) params.set('q', search.trim())
      if (year) params.set('ano', year)
      apiFetch(`${API_URL}/api/certificados?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          if (!active) return
          if (response.status === 403) throw new Error('forbidden')
          if (!response.ok) throw new Error('server')
          setResult(await response.json())
        })
        .catch((loadError) => {
          if (!active || loadError.name === 'AbortError') return
          setResult(null)
          setError(loadError.message === 'forbidden' ? 'Você não tem permissão para consultar este catálogo.' : 'Não foi possível carregar os certificados. Verifique se o Server está disponível.')
        })
        .finally(() => { if (active) setLoading(false) })
    }, 320)
    return () => { active = false; controller.abort(); clearTimeout(timer) }
  }, [isAdmin, page, search, year, catalogRevision])

  if (!isAdmin) return <main className="container"><SiteNav /><section className="panel certificate-access-denied"><p className="eyebrow">Acesso restrito</p><h1>Acesso negado</h1><p className="muted">O catálogo de certificados está disponível somente para administradores.</p></section></main>

  const updateSearch = (value) => { setSearch(value); setPage(1) }
  const updateYear = (value) => { setYear(value); setPage(1) }
  const totalPages = result?.totalPages || 0

  async function syncCatalogNow() {
    if (syncing || !window.confirm('Atualizar o catálogo agora? A atualização apenas lê nomes e metadados. Nenhum certificado é alterado.')) return
    setSyncing(true)
    setSyncError('')
    try {
      const response = await apiFetch(`${API_URL}/api/certificados/sincronizar`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.erro || 'Não foi possível atualizar o catálogo.')
      setSyncInfo(body)
      setCatalogRevision((value) => value + 1)
    } catch (syncLoadError) { setSyncError(syncLoadError.message) } finally { setSyncing(false) }
  }

  return <main className="container certificates-page">
    <SiteNav />
    <section className="certificates-heading"><div><p className="eyebrow">Catálogo interno</p><h1>Certificados de clientes</h1><p className="muted">Consulte os certificados disponíveis no catálogo interno.</p></div><div><a className="details-link" href="/certificados/solicitacoes">Solicitações</a><span className="certificate-admin-badge">ADMIN</span></div></section>
    <section className={`summary certificate-summary ${summaryLoading ? 'is-loading' : ''}`} aria-label="Resumo do catálogo">
      <SummaryCard label="Total no catálogo" value={summary.total ?? '—'} />
      <SummaryCard label="A1 2025" value={summary.year2025 ?? '—'} />
      <SummaryCard label="A1 2026" value={summary.year2026 ?? '—'} />
      <SummaryCard label="Metadados pendentes" value="N/D" detail="Filtro não disponível na API" />
    </section>
    {summaryError && <p className="notice error">Não foi possível carregar o resumo do catálogo.</p>}
    <section className="panel certificate-sync-panel" aria-label="Sincronização do catálogo">
      <div><p className="eyebrow">Sincronização read-only</p><h2>Atualização do catálogo</h2>{syncInfo ? <p className="muted">Última sincronização: {syncInfo.finalizadaEm ? new Date(syncInfo.finalizadaEm).toLocaleString() : 'em andamento'} · Status: {syncInfo.status} · Encontrados: {syncInfo.encontrados} · Novos: {syncInfo.criados} · Atualizados: {syncInfo.atualizados} · Inativados: {syncInfo.inativados} · Ignorados: {syncInfo.ignorados} · Erros: {syncInfo.erros}</p> : <p className="muted">Nenhuma sincronização registrada.</p>}</div>
      <button type="button" className="btn-update" onClick={syncCatalogNow} disabled={syncing}>{syncing ? 'Atualizando catálogo...' : 'Atualizar catálogo agora'}</button>
    </section>
    {syncError && <p className="notice error">{syncError}</p>}
    <section className="panel certificate-filters" aria-label="Filtros de certificados">
      <div className="certificate-search-field"><label htmlFor="certificate-search">Pesquisar por empresa ou CNPJ/CPF</label><input id="certificate-search" value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Pesquisar por empresa ou CNPJ/CPF" autoComplete="off" /></div>
      <label className="toolbar-field" htmlFor="certificate-year"><span>Ano</span><select id="certificate-year" value={year} onChange={(event) => updateYear(event.target.value)}><option value="">Todos</option><option value="2025">2025</option><option value="2026">2026</option></select></label>
      <button type="button" className="certificate-clear-button" onClick={() => { setSearch(''); setYear(''); setPage(1) }} disabled={!search && !year}>Limpar filtros</button>
    </section>
    <section className="certificate-results" aria-live="polite">
      <div className="certificate-results-heading"><div><p className="eyebrow">Resultados</p><h2>{result ? `${result.total} certificados encontrados` : 'Catálogo de certificados'}</h2></div>{result && <span className="muted">Página {result.page} de {result.totalPages || 1}</span>}</div>
      {loading && <p className="notice">Carregando certificados...</p>}
      {!loading && error && <p className="notice error">{error}</p>}
      {!loading && !error && result && result.items.length === 0 && <div className="empty"><strong>Nenhum certificado encontrado.</strong><span className="muted">Tente alterar a empresa, documento ou ano.</span></div>}
      {!loading && !error && result && result.items.length > 0 && <div className="certificate-list">{result.items.map((certificate) => <CertificateRow key={certificate.id} certificate={certificate} />)}</div>}
      {!loading && !error && result && result.items.length > 0 && <div className="certificate-pagination"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>Anterior</button><span>Página {page} de {totalPages || 1}</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}>Próxima</button></div>}
    </section>
  </main>
}
