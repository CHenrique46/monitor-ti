import { useEffect, useState } from 'react'
import { API_URL } from '../config'

const PAGE_SIZE = 10

function stateLabel(state) {
  return { PENDENTE: 'Pendente', APROVADA: 'Aprovada', NEGADA: 'Negada' }[state] || state
}

function displayFolder(value) {
  return value ? value.replace(/[_-]+/g, ' ') : 'Raiz do catálogo'
}

function releaseMessage(request) {
  if (request.estado !== 'APROVADA') return null
  return request.liberacao ? 'Certificado disponível.' : 'Aprovada pelo TI. Arquivo ainda não disponibilizado.'
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
  const [motivo, setMotivo] = useState('')
  const [loading, setLoading] = useState(true)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [requestsError, setRequestsError] = useState('')

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
      await loadRequests(1)
    } catch (submitError) { setError(submitError.message) } finally { setSubmitting(false) }
  }

  async function copyShare(share) {
    try { await navigator.clipboard.writeText(share); setMessage('Compartilhamento copiado.') } catch { setError('Não foi possível copiar o compartilhamento.') }
  }

  if (loading) return <main className="portal-shell"><p>Identificando esta estação...</p></main>
  return <main className="portal-shell">
    <section className="portal-card">
      <p className="eyebrow">Portal de certificados</p>
      <h1>Solicitar certificado</h1>
      {session && <p className="muted">Estação: <strong>{session.hostname}</strong>{session.usuarioWindows ? ` · ${session.usuarioWindows}` : ''}<br />{session.identificacao}</p>}
      {error && <p className="notice error">{error}</p>}
      {message && <p className="notice success">{message}</p>}
      {!error && <>
        <form className="portal-search" onSubmit={searchCatalog}>
          <label htmlFor="portal-search">Empresa ou CNPJ/CPF</label>
          <input id="portal-search" value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder="Digite parte do nome ou documento" autoComplete="off" />
          <label htmlFor="portal-year">Ano</label>
          <select id="portal-year" value={draftYear} onChange={(event) => setDraftYear(event.target.value)}><option value="">Todos</option><option value="2025">2025</option><option value="2026">2026</option></select>
          <button type="submit" className="btn-update" disabled={catalogLoading}>Pesquisar</button>
        </form>
        {catalogLoading && <p className="notice">Carregando certificados...</p>}
        {!catalogLoading && catalogError && <p className="notice error">{catalogError}</p>}
        {!catalogLoading && !catalogError && catalog && <div className="certificate-results-heading"><div><p className="eyebrow">Resultados</p><h2>{catalog.total} certificados encontrados</h2></div><span className="muted">{PAGE_SIZE} certificados por página · Página {catalog.page} de {catalog.totalPages || 1}</span></div>}
        {!catalogLoading && !catalogError && catalog?.items.length === 0 && <p className="muted">Nenhum certificado encontrado.</p>}
        {!catalogLoading && !catalogError && catalog?.items.length > 0 && <div className="portal-certificate-list">
          {catalog.items.map((certificate) => <article className={`portal-certificate ${selected?.id === certificate.id ? 'is-selected' : ''}`} key={certificate.id}>
            <div><strong>{certificate.nomeExibicao}</strong><span>{certificate.documento || 'Documento não identificado'}</span><small>{certificate.extensao?.replace('.', '').toUpperCase() || 'CERT'} · {certificate.anoReferencia || 'Ano não informado'} · {displayFolder(certificate.pastaLogica)} · {certificate.statusValidade}</small></div>
            <button type="button" onClick={() => setSelected(certificate)} disabled={submitting}>{selected?.id === certificate.id ? 'Selecionado' : 'Selecionar'}</button>
          </article>)}
        </div>}
        {!catalogLoading && catalog?.totalPages > 1 && <div className="certificate-pagination"><button type="button" onClick={() => setCatalogPage((current) => Math.max(1, current - 1))} disabled={catalogPage <= 1}>Anterior</button><span>Página {catalogPage} de {catalog.totalPages}</span><button type="button" onClick={() => setCatalogPage((current) => Math.min(catalog.totalPages, current + 1))} disabled={catalogPage >= catalog.totalPages}>Próxima</button></div>}
        {selected && <form onSubmit={submit} className="portal-form"><h2>Solicitar: {selected.nomeExibicao}</h2><p className="muted">{selected.documento || 'Documento não identificado'} · {selected.extensao?.replace('.', '').toUpperCase()} · {selected.anoReferencia || 'Ano não informado'}</p><label htmlFor="portal-reason">Motivo (opcional)</label><textarea id="portal-reason" maxLength="500" value={motivo} onChange={(event) => setMotivo(event.target.value)} rows="3" disabled={submitting} /><button type="submit" className="btn-update" disabled={submitting}>{submitting ? 'Solicitando...' : 'Solicitar'}</button></form>}
      </>}
      <section className="portal-requests" aria-live="polite">
        <h2>Minhas solicitações</h2>
        {requestsLoading && <p className="notice">Carregando solicitações...</p>}
        {!requestsLoading && requestsError && <p className="notice error">{requestsError}</p>}
        {!requestsLoading && !requestsError && requests?.items.length === 0 && <p className="muted">Nenhuma solicitação feita por esta estação.</p>}
        {!requestsLoading && !requestsError && requests?.items.map((request) => <article className="portal-request" key={request.id}><strong>{request.certificado?.nomeExibicao || 'Certificado'}</strong><span className={`request-state request-${request.estado.toLowerCase()}`}>{stateLabel(request.estado)}</span>{request.motivo && <small>Motivo: {request.motivo}</small>}{request.motivoNegativa && <small>Motivo da negativa: {request.motivoNegativa}</small>}{releaseMessage(request) && <small>{releaseMessage(request)}</small>}{request.liberacao && <><small>Arquivo: {request.liberacao.nomeArquivoLiberado}</small><small><button type="button" className="details-link" onClick={() => copyShare(request.liberacao.compartilhamento)}>Copiar compartilhamento</button> {request.liberacao.compartilhamento}</small></>}</article>)}
        {!requestsLoading && !requestsError && requests?.totalPages > 1 && <div className="certificate-pagination"><button type="button" onClick={() => setRequestsPage((current) => Math.max(1, current - 1))} disabled={requestsPage <= 1}>Anterior</button><span>Página {requestsPage} de {requests.totalPages}</span><button type="button" onClick={() => setRequestsPage((current) => Math.min(requests.totalPages, current + 1))} disabled={requestsPage >= requests.totalPages}>Próxima</button></div>}
      </section>
    </section>
  </main>
}
