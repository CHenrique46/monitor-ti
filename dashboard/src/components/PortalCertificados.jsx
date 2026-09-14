import { useEffect, useState } from 'react'
import { API_URL } from '../config'

const PAGE_SIZE = 10

function stateLabel(state) {
  return { PENDENTE: 'Pendente', APROVADA: 'Aprovada', NEGADA: 'Negada' }[state] || state
}

export default function PortalCertificados() {
  const [session, setSession] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [requests, setRequests] = useState(null)
  const [selected, setSelected] = useState('')
  const [motivo, setMotivo] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [requestsError, setRequestsError] = useState('')

  async function loadRequests(targetPage = page) {
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
        const [catalogResponse] = await Promise.all([
          fetch(`${API_URL}/api/portal/certificados`, { credentials: 'include' })
        ])
        const catalogBody = await catalogResponse.json()
        if (!catalogResponse.ok) throw new Error(catalogBody.erro || 'Não foi possível carregar o catálogo.')
        if (active) { setSession(body); setCatalog(catalogBody) }
      } catch (loadError) { if (active) setError(loadError.message) } finally { if (active) setLoading(false) }
    }
    load()
    return () => { active = false }
  }, [])

  useEffect(() => { if (session) loadRequests(page) }, [session, page])

  async function submit(event) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setMessage('')
    setError('')
    try {
      const response = await fetch(`${API_URL}/api/portal/solicitacoes`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certificadoId: Number(selected), motivo }) })
      const body = await response.json()
      if (!response.ok) {
        if (response.status === 409) throw new Error('Já existe uma solicitação pendente deste certificado para esta estação.')
        throw new Error(body.erro || 'Não foi possível registrar a solicitação.')
      }
      setMessage('Solicitação enviada para análise do TI. O certificado ainda não foi liberado.')
      setSelected('')
      setMotivo('')
      setPage(1)
      await loadRequests(1)
    } catch (submitError) { setError(submitError.message) } finally { setSubmitting(false) }
  }

  if (loading) return <main className="portal-shell"><p>Identificando esta estação...</p></main>
  return <main className="portal-shell">
    <section className="portal-card">
      <p className="eyebrow">Portal de certificados</p>
      <h1>Solicitar certificado</h1>
      {session && <p className="muted">Estação: <strong>{session.hostname}</strong>{session.usuarioWindows ? ` · ${session.usuarioWindows}` : ''}<br />{session.identificacao}</p>}
      {error && <p className="notice error">{error}</p>}
      {message && <p className="notice success">{message}</p>}
      {!error && catalog && <form onSubmit={submit} className="portal-form">
        <label htmlFor="portal-certificate">Certificado CLIENTE</label>
        <select id="portal-certificate" value={selected} onChange={(event) => setSelected(event.target.value)} required disabled={submitting}>
          <option value="">Selecione um certificado</option>
          {catalog.items.map((certificate) => <option key={certificate.id} value={certificate.id}>{certificate.nomeExibicao} {certificate.documento ? `· ${certificate.documento}` : ''}</option>)}
        </select>
        <label htmlFor="portal-reason">Motivo (opcional)</label>
        <textarea id="portal-reason" maxLength="500" value={motivo} onChange={(event) => setMotivo(event.target.value)} rows="3" disabled={submitting} />
        <button type="submit" className="btn-update" disabled={submitting}>{submitting ? 'Solicitando...' : 'Solicitar'}</button>
      </form>}
      {!error && catalog?.items.length === 0 && <p className="muted">Nenhum certificado CLIENTE disponível.</p>}
      <section className="portal-requests" aria-live="polite">
        <h2>Minhas solicitações</h2>
        {requestsLoading && <p className="notice">Carregando solicitações...</p>}
        {!requestsLoading && requestsError && <p className="notice error">{requestsError}</p>}
        {!requestsLoading && !requestsError && requests?.items.length === 0 && <p className="muted">Nenhuma solicitação feita por esta estação.</p>}
        {!requestsLoading && !requestsError && requests?.items.map((request) => <article className="portal-request" key={request.id}><strong>{request.certificado?.nomeExibicao || 'Certificado'}</strong><span className={`request-state request-${request.estado.toLowerCase()}`}>{stateLabel(request.estado)}</span>{request.motivo && <small>Motivo: {request.motivo}</small>}{request.motivoNegativa && <small>Motivo da negativa: {request.motivoNegativa}</small>}</article>)}
        {!requestsLoading && !requestsError && requests?.totalPages > 1 && <div className="certificate-pagination"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>Anterior</button><span>Página {page} de {requests.totalPages}</span><button type="button" onClick={() => setPage((current) => Math.min(requests.totalPages, current + 1))} disabled={page >= requests.totalPages}>Próxima</button></div>}
      </section>
    </section>
  </main>
}
