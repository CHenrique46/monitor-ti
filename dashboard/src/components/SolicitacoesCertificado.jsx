import { useEffect, useState } from 'react'
import SiteNav from './SiteNav'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { useAuth } from '../auth/AuthContext'

export default function SolicitacoesCertificado() {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)

  async function load() {
    try {
      const response = await apiFetch(`${API_URL}/api/certificados/solicitacoes`)
      if (!response.ok) throw new Error('Não foi possível carregar as solicitações.')
      setItems(await response.json())
    } catch (loadError) { setError(loadError.message) }
  }

  useEffect(() => { if (user.role === 'ADMIN') load() }, [user.role])

  async function decide(id, estado) {
    let motivoNegativa = ''
    if (estado === 'NEGADA') {
      motivoNegativa = window.prompt('Informe o motivo da negativa:')?.trim() || ''
      if (!motivoNegativa) { setError('O motivo da negativa é obrigatório.'); return }
    } else if (!window.confirm(estado === 'APROVADA' ? 'Aprovar e liberar este certificado agora?' : 'Atualizar esta solicitação?')) return
    setBusy(id)
    setError('')
    try {
      const response = await apiFetch(`${API_URL}/api/certificados/solicitacoes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado, motivoNegativa }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.erro || 'Não foi possível atualizar a solicitação.')
      await load()
    } catch (updateError) { setError(updateError.message) } finally { setBusy(null) }
  }

  if (user.role !== 'ADMIN') return <main className="container"><SiteNav /><section className="panel certificate-access-denied"><p className="eyebrow">Acesso restrito</p><h1>Acesso negado</h1><p className="muted">A gestão de solicitações está disponível somente para administradores.</p></section></main>
   return <main className="container certificate-requests-page"><SiteNav /><section className="certificates-heading"><div><p className="eyebrow">Fluxo administrativo</p><h1>Solicitações de certificados</h1><p className="muted">Revise solicitações recebidas pelo portal.</p></div><span className="certificate-admin-badge">ADMIN</span></section>
     {error && <p className="notice error">{error}</p>}
     <section className="certificate-request-list">{items.length === 0 && !error && <div className="empty">Nenhuma solicitação registrada.</div>}{items.map((item) => <article className="certificate-request-row" key={item.id}><div><strong>{item.certificado?.nomeExibicao || 'Certificado'}</strong><p className="muted">{item.protocolo} · {item.computador?.hostname || 'Estação desconhecida'} · {item.computador?.ip || 'IP indisponível'}</p>{item.motivo && <p>Motivo: {item.motivo}</p>}{item.motivoNegativa && <p>Negativa: {item.motivoNegativa}</p>}{item.estado === 'APROVADA' && !item.liberacao && <p className="notice">Aprovada anteriormente, arquivo ainda não liberado.</p>}{item.liberacao && <p className="muted">Liberado: {item.liberacao.nomeArquivoLiberado} · {new Date(item.liberacao.liberadoEm).toLocaleString()} · {item.liberacao.compartilhamento}</p>}</div><div className="certificate-request-actions"><span className={`certificate-status request-${item.estado.toLowerCase()}`}>{item.estado}</span>{item.estado === 'PENDENTE' && <><button type="button" className="btn-update" disabled={busy === item.id} onClick={() => decide(item.id, 'APROVADA')}>{busy === item.id ? 'Liberando...' : 'Aprovar e liberar'}</button><button type="button" className="btn-cancel" disabled={busy === item.id} onClick={() => decide(item.id, 'NEGADA')}>Negar</button></>}{item.estado === 'APROVADA' && !item.liberacao && <button type="button" className="btn-update" disabled={busy === item.id} onClick={() => decide(item.id, 'APROVADA')}>{busy === item.id ? 'Liberando...' : 'Liberar arquivo'}</button>}{item.liberacao && <span className="request-aprovada">Liberado</span>}</div></article>)}</section>
  </main>
}
