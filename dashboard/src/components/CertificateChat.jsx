import { useRef, useState } from 'react'
import * as guidedCertificateProvider from '../services/certificateChatApi'
import { formatCertificateValidity } from '../formatCertificateValidity'

function chatDocument(certificate) {
  return certificate.documento || 'Documento não identificado'
}

function isPendingForCertificate(request, certificateId) {
  return request.certificado?.id === certificateId && request.estado === 'PENDENTE'
}

export default function CertificateChat({ onRequestConfirmed, assistantProvider = guidedCertificateProvider }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selected, setSelected] = useState(null)
  const [reason, setReason] = useState('')
  const [step, setStep] = useState('start')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const searchController = useRef(null)

  function reset() {
    searchController.current?.abort()
    setQuery('')
    setResults([])
    setSelected(null)
    setReason('')
    setStep('start')
    setBusy(false)
    setMessage('')
    setError('')
  }

  function close() {
    if (!busy) {
      setOpen(false)
      reset()
    }
  }

  async function search(event) {
    event.preventDefault()
    const value = query.trim()
    if (!value || busy) return
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setBusy(true)
    setError('')
    setMessage('')
    setSelected(null)
    setStep('searching')
    try {
      const catalog = await assistantProvider.searchCertificateCatalog(value, controller.signal)
      setResults(catalog.items)
      if (catalog.items.length === 0) setStep('empty')
      else if (catalog.items.length === 1) {
        setSelected(catalog.items[0])
        setStep('confirm')
      } else setStep('choose')
    } catch (searchError) {
      if (searchError.name !== 'AbortError') {
        setError(searchError.message)
        setStep('start')
      }
    } finally {
      if (searchController.current === controller) setBusy(false)
    }
  }

  function choose(certificate) {
    if (busy) return
    setSelected(certificate)
    setError('')
    setStep('confirm')
  }

  async function verifyAfterUncertainResult() {
    try {
      const requests = await assistantProvider.listCertificateRequests()
      return { verified: true, pending: requests.items.some((request) => isPendingForCertificate(request, selected.id)) }
    } catch {
      return { verified: false, pending: false }
    }
  }

  async function confirm() {
    if (!selected || busy) return
    setBusy(true)
    setError('')
    setStep('submitting')
    try {
      await assistantProvider.createCertificateRequest({ certificadoId: selected.id, motivo: reason })
      setMessage('Solicitação enviada para o TI. O certificado ainda não foi liberado.')
      setStep('sent')
      onRequestConfirmed?.()
    } catch (requestError) {
      const state = await verifyAfterUncertainResult()
      if (requestError.status === 409 && state.pending) {
        setError('Já existe uma solicitação pendente deste certificado para esta estação. Não reenviamos o pedido.')
        setStep('uncertain')
      } else if (state.pending) {
        setMessage('Solicitação enviada para o TI. O certificado ainda não foi liberado.')
        setStep('sent')
        onRequestConfirmed?.()
      } else {
        setError(requestError.message)
        setStep('uncertain')
      }
    } finally {
      setBusy(false)
    }
  }

  const validity = selected ? formatCertificateValidity(selected) : null

  return <section className="certificate-chat">
    <div className="certificate-chat-heading">
      <div><p className="eyebrow">Atendimento guiado</p><h2>Peça ao chat</h2><p className="muted">Um passo a passo para localizar e solicitar um certificado. Não é uma IA generativa.</p></div>
      {!open && <button type="button" className="btn-update" onClick={() => { reset(); setOpen(true) }}>Iniciar atendimento</button>}
    </div>
    {open && <div className="certificate-chat-panel" aria-live="polite">
      {step === 'start' || step === 'searching' ? <form onSubmit={search} className="certificate-chat-form">
        <label htmlFor="certificate-chat-query">Qual empresa ou documento você procura?</label>
        <div className="certificate-chat-input-row"><input id="certificate-chat-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome da empresa ou CNPJ/CPF" autoComplete="off" disabled={busy} /><button type="submit" className="btn-update" disabled={busy || !query.trim()}>{busy ? 'Consultando...' : 'Consultar catálogo'}</button></div>
      </form> : null}
      {error && step === 'start' && <p className="notice error">{error}</p>}
      {step === 'empty' && <div><p className="notice">Nenhum certificado autorizado foi encontrado para essa busca.</p><button type="button" className="btn-cancel" onClick={reset}>Nova busca</button></div>}
      {step === 'choose' && <div className="certificate-chat-results"><p>Encontrei mais de um resultado. Qual deles você deseja solicitar?</p>{results.map((certificate) => <button type="button" className="certificate-chat-result" key={certificate.id} onClick={() => choose(certificate)}><strong>{certificate.nomeEmpresa || certificate.nomeExibicao}</strong><span>{chatDocument(certificate)} · {formatCertificateValidity(certificate).label}</span></button>)}<button type="button" className="btn-cancel" onClick={reset}>Cancelar</button></div>}
      {selected && ['confirm', 'submitting'].includes(step) && <div className="certificate-chat-confirm"><p>Confirme os dados do catálogo:</p><div className="certificate-chat-card"><strong>{selected.nomeEmpresa || selected.nomeExibicao}</strong><span>{chatDocument(selected)}</span><span>{validity.label}</span>{validity.detail && <small>{validity.detail}</small>}</div><p>Este é o certificado que você deseja solicitar?</p><label htmlFor="certificate-chat-reason">Motivo (opcional)</label><textarea id="certificate-chat-reason" value={reason} maxLength="500" onChange={(event) => setReason(event.target.value)} rows="2" disabled={busy} /><div className="certificate-chat-actions"><button type="button" className="btn-update" onClick={confirm} disabled={busy}>{busy ? 'Confirmando...' : 'Sim, solicitar'}</button><button type="button" className="btn-cancel" onClick={reset} disabled={busy}>Não, cancelar</button></div></div>}
      {step === 'sent' && <div><p className="notice success">{message}</p><p className="muted">A solicitação entrou na fila do TI para análise. A aprovação e a liberação continuam no fluxo administrativo.</p><button type="button" className="btn-update" onClick={reset}>Nova solicitação</button></div>}
      {step === 'uncertain' && <div><p className="notice error">{error || 'Não foi possível confirmar o estado da solicitação.'}</p><p className="muted">O sistema consultou o estado antes de permitir qualquer novo envio. Feche este atendimento e tente novamente somente quando o serviço estiver disponível.</p><button type="button" className="btn-cancel" onClick={reset}>Fechar</button></div>}
      {open && step !== 'sent' && step !== 'uncertain' && <button type="button" className="certificate-chat-close" onClick={close} disabled={busy}>Fechar atendimento</button>}
    </div>}
  </section>
}
