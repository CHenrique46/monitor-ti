import { useEffect, useState } from 'react'
import { API_URL, CERTIFICATE_PORTAL_READ_ONLY } from '../config'
import { formatCertificateValidity } from '../formatCertificateValidity'
import BrowserNotificationControls from './BrowserNotificationControls'
import CertificateChat from './CertificateChat'

const PAGE_SIZE = 10
const INITIAL_REQUESTS_VISIBLE = 5

function stateLabel(state) {
  return { PENDENTE: 'Pendente', APROVADA: 'Aprovada', NEGADA: 'Negada' }[state] || state
}

function requestStateLabel(request) {
  if (request.statusLiberacao === 'EXPIRADA') return 'Expirada'
  if (request.statusLiberacao === 'LIBERADO') return 'Liberada'
  return stateLabel(request.estado)
}

function displayFolder(value) {
  return value ? value.replace(/[_-]+/g, ' ') : 'Raiz do catálogo'
}

function releaseMessage(request) {
  if (request.statusLiberacao === 'EXPIRADA') return 'Liberação expirada. Faça uma nova solicitação.'
  if (request.estado === 'PENDENTE') return 'Aguardando análise da TI.'
  if (request.estado !== 'APROVADA') return null
  return request.liberacao ? 'Certificado disponível na pasta Certificados.' : 'Aprovada pelo TI. Arquivo ainda não disponibilizado.'
}

function requestPriority(request) {
  if (request.statusLiberacao === 'LIBERADO' && request.liberacao) return 0
  if (request.estado === 'PENDENTE') return 1
  if (request.estado === 'APROVADA' && !request.liberacao && request.statusLiberacao !== 'EXPIRADA') return 2
  if (request.estado === 'NEGADA') return 3
  if (request.statusLiberacao === 'EXPIRADA') return 4
  return 5
}

function sortRequests(items) {
  return [...items].sort((left, right) => requestPriority(left) - requestPriority(right) || new Date(right.solicitadoEm).getTime() - new Date(left.solicitadoEm).getTime())
}

function latestRequest(items) {
  return [...items].sort((left, right) => {
    const rightDate = new Date(right.solicitadoEm || right.criadoEm || 0).getTime()
    const leftDate = new Date(left.solicitadoEm || left.criadoEm || 0).getTime()
    return rightDate - leftDate || Number(right.id || 0) - Number(left.id || 0)
  })[0] || null
}

function PortalSidebar({ session, latestRequest, requestsLoading, requestsError, hasHistory }) {
  return <aside className="portal-sidebar">
    <a className="portal-brand" href="/" aria-label="Voltar à entrada do HenriTech">
      <span className="portal-brand-mark">HT</span>
      <span><strong>HenriTech</strong><small>Control</small></span>
    </a>
    <div className="portal-sidebar-copy"><span className="portal-kicker">Portal de certificados</span><p>Atendimento seguro para {session?.hostname || 'sua estação'}.</p></div>
    <section className="portal-latest-request" aria-labelledby="portal-latest-request-title">
      <span className="portal-kicker">Acompanhamento</span>
      <h2 id="portal-latest-request-title">Minha última solicitação</h2>
      {requestsLoading && <p>Carregando...</p>}
      {!requestsLoading && requestsError && <p>Não foi possível carregar.</p>}
      {!requestsLoading && !requestsError && !latestRequest && <p>Você ainda não fez solicitações.</p>}
      {!requestsLoading && !requestsError && latestRequest && <div className="portal-latest-request-card"><strong>{latestRequest.certificado?.nomeExibicao || 'Certificado'}</strong><span>{requestStateLabel(latestRequest)}</span></div>}
      {!requestsLoading && !requestsError && hasHistory && <a href="#portal-history">Ver histórico completo</a>}
    </section>
    <a className="portal-entry-link" href="/">Voltar à entrada</a>
  </aside>
}

export default function PortalCertificados() {
  const [session, setSession] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [requests, setRequests] = useState(null)
  const [selected, setSelected] = useState(null)
  const [draftSearch, setDraftSearch] = useState('')
  const [draftYear, setDraftYear] = useState('')
  const [search, setSearch] = useState('')
  const [year, setYear] = useState('')
  const [catalogPage, setCatalogPage] = useState(1)
  const [requestsPage, setRequestsPage] = useState(1)
  const [showOlderRequests, setShowOlderRequests] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [loading, setLoading] = useState(true)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [requestsError, setRequestsError] = useState('')
  const [traditionalSearchOpen, setTraditionalSearchOpen] = useState(false)

  async function loadCatalog(targetPage = catalogPage, targetSearch = search, targetYear = year) {
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const params = new URLSearchParams({ page: String(targetPage), pageSize: String(PAGE_SIZE) })
      if (targetSearch.trim()) params.set('q', targetSearch.trim())
      if (targetYear) params.set('ano', targetYear)
      const response = await fetch(`${API_URL}/api/portal/certificados?${params.toString()}`, { credentials: 'include' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.erro || 'Não foi possível carregar o catálogo.')
      setCatalog(body)
    } catch (loadError) { setCatalogError(loadError.message) } finally { setCatalogLoading(false) }
  }

  async function loadRequests(targetPage = requestsPage) {
    setRequestsLoading(true)
    setRequestsError('')
    try {
      const response = await fetch(`${API_URL}/api/portal/solicitacoes?page=${targetPage}&pageSize=${PAGE_SIZE}`, { credentials: 'include' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.erro || 'Não foi possível carregar suas solicitações.')
      setRequests(body)
    } catch (loadError) { setRequestsError(loadError.message) } finally { setRequestsLoading(false) }
  }

  async function refreshRequestsAfterChat() {
    setRequestsPage(1)
    setShowOlderRequests(false)
    await loadRequests(1)
  }

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const response = await fetch(`${API_URL}/api/portal/session`, { method: 'POST', credentials: 'include' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.erro || 'Estação não identificada.')
        if (active) setSession(body)
      } catch (loadError) { if (active) setError(loadError.message) } finally { if (active) setLoading(false) }
    }
    load()
    return () => { active = false }
  }, [])

  useEffect(() => { if (session) loadCatalog(catalogPage, search, year) }, [session, catalogPage, search, year])
  useEffect(() => { if (session) loadRequests(requestsPage) }, [session, requestsPage])

  async function searchCatalog(event) {
    event.preventDefault()
    setSelected(null)
    setCatalogPage(1)
    setSearch(draftSearch)
    setYear(draftYear)
  }

  async function submit(event) {
    event.preventDefault()
    if (CERTIFICATE_PORTAL_READ_ONLY) return
    if (submitting || !selected) return
    setSubmitting(true)
    setMessage('')
    setError('')
    try {
      const response = await fetch(`${API_URL}/api/portal/solicitacoes`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certificadoId: selected.id, motivo }) })
      const body = await response.json()
      if (!response.ok) {
        if (response.status === 409) throw new Error('Já existe uma solicitação pendente deste certificado para esta estação.')
        throw new Error(body.erro || 'Não foi possível registrar a solicitação.')
      }
      setMessage('Solicitação enviada para análise do TI. O certificado ainda não foi liberado.')
      setSelected(null)
      setMotivo('')
      setRequestsPage(1)
      setShowOlderRequests(false)
      await loadRequests(1)
    } catch (submitError) { setError(submitError.message) } finally { setSubmitting(false) }
  }

  const orderedRequests = requests ? sortRequests(requests.items) : []
  const visibleRequests = showOlderRequests ? orderedRequests : orderedRequests.filter((request, index) => requestPriority(request) < 2 || index < INITIAL_REQUESTS_VISIBLE)

  const lastRequest = latestRequest(requests?.items || [])

  if (loading) return <main className="portal-shell"><PortalSidebar /><div className="portal-main"><p>Identificando esta estação...</p></div></main>
  return <main className="portal-shell">
    <PortalSidebar session={session} latestRequest={lastRequest} requestsLoading={requestsLoading} requestsError={requestsError} hasHistory={orderedRequests.length > 0} />
    <div className="portal-main">
      <header className="portal-topbar"><div><span className="portal-kicker">Escritório Vavá · ambiente seguro</span><h1>Portal de certificados</h1>{CERTIFICATE_PORTAL_READ_ONLY && <p className="notice">Teste — somente consulta. Criação de solicitações desativada.</p>}</div>{session && <div className="portal-session"><span className="portal-status-dot" />{session.hostname}{session.usuarioWindows ? ` · ${session.usuarioWindows}` : ''}</div>}</header>
      {session && <div className="portal-session-tools"><span>{session.identificacao}</span><BrowserNotificationControls basePath="/api/portal/browser-notifications" label="Notificações desta estação" /></div>}
      {error && <p className="notice error">{error}</p>}
      {message && <p className="notice success">{message}</p>}
      {!error && <>
        <div className={`portal-workspace portal-content-grid ${traditionalSearchOpen ? 'is-search-open' : 'is-search-closed'}`}>
          <section className="portal-chat-column" aria-label="Atendimento do Luca">
            <div className="portal-chat-stage">
              <img className="portal-chat-mascot" src="/lucaacenando.png" alt="Luca, mascote do HenriTech" />
              <CertificateChat embedded alwaysOpen onRequestConfirmed={refreshRequestsAfterChat} onOpenTraditionalSearch={() => setTraditionalSearchOpen(true)} />
            </div>
          </section>
          {traditionalSearchOpen && <section className="portal-panel portal-search-area" aria-labelledby="portal-search-title">
              <div className="portal-panel-heading"><div><span className="portal-kicker">Pesquisa tradicional</span><h2 id="portal-search-title">Pesquisar certificados</h2></div><button type="button" className="portal-search-toggle" onClick={() => setTraditionalSearchOpen(false)}>Voltar ao chat</button></div>
              <form className="portal-search" onSubmit={searchCatalog}>
                <label htmlFor="portal-search">Empresa ou CNPJ/CPF</label><input id="portal-search" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder="Digite parte do nome ou documento" autoComplete="off" />
                <label htmlFor="portal-year">Ano</label><select id="portal-year" value={draftYear} onChange={(event) => setDraftYear(event.target.value)}><option value="">Todos</option><option value="2025">2025</option><option value="2026">2026</option></select>
                <button type="submit" className="btn-update" disabled={catalogLoading}>Pesquisar</button>
              </form>
              {catalogLoading && <p className="notice">Carregando certificados...</p>}
              {!catalogLoading && catalogError && <p className="notice error">{catalogError}</p>}
              {!catalogLoading && catalogError && <button type="button" className="btn-cancel portal-retry" onClick={() => loadCatalog(catalogPage, search, year)}>Tentar novamente</button>}
              {!catalogLoading && !catalogError && catalog && <div className="certificate-results-heading"><div><span className="portal-kicker">Resultados</span><h2>{catalog.total} certificados encontrados</h2></div><span className="muted">{PAGE_SIZE} por página · Página {catalog.page} de {catalog.totalPages || 1}</span></div>}
              {!catalogLoading && !catalogError && catalog?.items.length === 0 && <p className="empty">Nenhum certificado encontrado.</p>}
              {!catalogLoading && !catalogError && catalog?.items.length > 0 && <div className="portal-certificate-list">{catalog.items.map((certificate) => <article className={`portal-certificate ${selected?.id === certificate.id ? 'is-selected' : ''}`} key={certificate.id}><div><strong>{certificate.nomeExibicao}</strong><span>{certificate.documento || 'Documento não identificado'}</span><small>{certificate.extensao?.replace('.', '').toUpperCase() || 'CERT'} · {certificate.anoReferencia || 'Ano não informado'} · {displayFolder(certificate.pastaLogica)}</small><small className={`certificate-status validity-${formatCertificateValidity(certificate).tone}`}>{formatCertificateValidity(certificate).label}</small>{formatCertificateValidity(certificate).detail && <small>{formatCertificateValidity(certificate).detail}</small>}</div><button type="button" onClick={() => setSelected(certificate)} disabled={submitting}>{selected?.id === certificate.id ? 'Selecionado' : 'Selecionar'}</button></article>)}</div>}
              {!catalogLoading && catalog?.totalPages > 1 && <div className="certificate-pagination"><button type="button" onClick={() => setCatalogPage((current) => Math.max(1, current - 1))} disabled={catalogPage <= 1}>Anterior</button><span>Página {catalogPage} de {catalog.totalPages}</span><button type="button" onClick={() => setCatalogPage((current) => Math.min(catalog.totalPages, current + 1))} disabled={catalogPage >= catalog.totalPages}>Próxima</button></div>}
               {selected && !CERTIFICATE_PORTAL_READ_ONLY && <form onSubmit={submit} className="portal-form"><h2>Solicitar: {selected.nomeExibicao}</h2><p className="muted">{selected.documento || 'Documento não identificado'} · {selected.extensao?.replace('.', '').toUpperCase()} · {selected.anoReferencia || 'Ano não informado'}</p><label htmlFor="portal-reason">Motivo (opcional)</label><textarea id="portal-reason" maxLength="500" value={motivo} onChange={(event) => setMotivo(event.target.value)} rows="3" disabled={submitting} /><button type="submit" className="btn-update" disabled={submitting}>{submitting ? 'Solicitando...' : 'Solicitar'}</button></form>}
            </section>}
         </div>
        <section className="portal-panel portal-history" id="portal-history" aria-live="polite" aria-labelledby="portal-history-title">
          <div className="portal-panel-heading"><div><span className="portal-kicker">Histórico</span><h2 id="portal-history-title">Minhas solicitações</h2></div>{requests?.total ? <span className="portal-count">{requests.total}</span> : null}</div>
          {requestsLoading && <p className="notice">Carregando solicitações...</p>}
          {!requestsLoading && requestsError && <><p className="notice error">{requestsError}</p><button type="button" className="btn-cancel portal-retry" onClick={() => loadRequests(requestsPage)}>Tentar novamente</button></>}
          {!requestsLoading && !requestsError && requests?.items.length === 0 && <p className="muted">Você ainda não fez solicitações.</p>}
          {!requestsLoading && !requestsError && requests?.items.length > 0 && <div className="portal-request-list">{visibleRequests.map((request) => <article className={`portal-request request-card request-card-${requestStateLabel(request).toLowerCase()}`} key={request.id}><div className="portal-request-heading"><strong>{request.certificado?.nomeExibicao || 'Certificado'}</strong><span className="request-state">{requestStateLabel(request)}</span></div>{request.motivo && <small>Motivo: {request.motivo}</small>}{request.motivoNegativa && <small>Motivo da negativa: {request.motivoNegativa}</small>}{releaseMessage(request) && <small>{releaseMessage(request)}</small>}{request.liberacao?.expiresAt && <small>Disponível até: {new Date(request.liberacao.expiresAt).toLocaleString()}</small>}</article>)}</div>}
          {!requestsLoading && !requestsError && requests?.items.length > visibleRequests.length && <button type="button" className="portal-request-toggle" onClick={() => setShowOlderRequests((visible) => !visible)}>{showOlderRequests ? 'Recolher solicitações anteriores' : 'Ver solicitações anteriores'}</button>}
          {!requestsLoading && !requestsError && requests?.totalPages > 1 && <div className="certificate-pagination"><button type="button" onClick={() => setRequestsPage((current) => Math.max(1, current - 1))} disabled={requestsPage <= 1}>Anterior</button><span>Página {requestsPage} de {requests.totalPages}</span><button type="button" onClick={() => setRequestsPage((current) => Math.min(requests.totalPages, current + 1))} disabled={requestsPage >= requests.totalPages}>Próxima</button></div>}
        </section>
      </>}
    </div>
  </main>
}
