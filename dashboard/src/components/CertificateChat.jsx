import { useEffect, useRef, useState } from 'react'
import * as guidedCertificateProvider from '../services/certificateChatApi'
import * as aiCertificateProvider from '../services/certificateChatAiApi'
import { CERTIFICATE_PORTAL_READ_ONLY } from '../config'
import { formatCertificateValidity } from '../formatCertificateValidity'
import { createChatInactivityController } from './chatInactivity'

const OPENING_MESSAGE = 'Oi! Eu sou o Luca 😊 Me diga qual certificado você procura. Se preferir, pode usar a pesquisa tradicional.'
const previewAiEnabled = import.meta.env.VITE_LUCA_AI_PREVIEW === 'true'

function chatDocument(certificate) {
  return certificate.documento || 'Documento não identificado'
}

function isPendingForCertificate(request, certificateId) {
  return request.certificado?.id === certificateId && request.estado === 'PENDENTE'
}

function newMessage(role, text, extra = {}) {
  return { id: `${Date.now()}-${Math.random()}`, role, text, ...extra }
}

function normalizeMessage(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function Avatar({ small = false }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? <span className={`luca-avatar luca-avatar-placeholder ${small ? 'luca-avatar-small' : ''}`} aria-hidden="true">L</span>
    : <img className={`luca-avatar ${small ? 'luca-avatar-small' : ''}`} src="/lucaacenando.png" alt="" onError={() => setFailed(true)} />
}

function CertificateCard({ certificate, actionLabel, onAction, disabled }) {
  const validity = formatCertificateValidity(certificate)
  return <div className="luca-certificate-card">
    <strong>{certificate.nomeEmpresa || certificate.nomeExibicao}</strong>
    <span>{chatDocument(certificate)}</span>
    <span>{validity.label}</span>
    {validity.detail && <small>{validity.detail}</small>}
    {actionLabel && <button type="button" className="luca-card-action" onClick={onAction} disabled={disabled}>{actionLabel}</button>}
  </div>
}

export default function CertificateChat({ onRequestConfirmed, onOpenTraditionalSearch, embedded = false, alwaysOpen = false, assistantProvider = previewAiEnabled ? aiCertificateProvider : guidedCertificateProvider }) {
  const [open, setOpen] = useState(alwaysOpen)
  const [minimized, setMinimized] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [selected, setSelected] = useState(null)
  const [phase, setPhase] = useState('waiting')
  const [busy, setBusy] = useState(false)
  const [idleWarning, setIdleWarning] = useState(false)
  const searchController = useRef(null)
  const conversationController = useRef(null)
  const sessionIdRef = useRef(null)
  const turnRef = useRef(0)
  const busyRef = useRef(false)
  const inactivityRef = useRef(null)
  const inputRef = useRef(null)
  const historyRef = useRef(null)

  function addMessage(role, text, extra) {
    setMessages((current) => [...current, newMessage(role, text, extra)])
  }

  function resetConversation() {
    turnRef.current += 1
    searchController.current?.abort()
    conversationController.current?.abort()
    setInput('')
     setMessages([newMessage('luca', OPENING_MESSAGE, { action: 'open-search' })])
    setSelected(null)
    setPhase('waiting')
    setBusy(false)
    setIdleWarning(false)
    sessionIdRef.current = `luca-${Date.now()}-${Math.random().toString(36).slice(2)}`
    inactivityRef.current?.activity()
  }

  function registerActivity() {
    inactivityRef.current?.activity()
  }

  function openChat() {
    resetConversation()
    setOpen(true)
    setMinimized(false)
  }

  useEffect(() => {
    if (alwaysOpen && !sessionIdRef.current) resetConversation()
  }, [alwaysOpen])

  useEffect(() => {
    const controller = createChatInactivityController({
      isBusy: () => busyRef.current,
      onWarning: () => setIdleWarning(true),
      onTimeout: resetConversation
    })
    inactivityRef.current = controller
    controller.start()
    return () => {
      controller.dispose()
      inactivityRef.current = null
    }
  }, [])

  useEffect(() => {
    const wasBusy = busyRef.current
    busyRef.current = busy
    if (wasBusy && !busy) registerActivity()
  }, [busy])

  function closeChat() {
    if (!busy) setOpen(false)
  }

  useEffect(() => {
    if (open && !minimized) inputRef.current?.focus()
  }, [open, minimized])

  useEffect(() => {
    const history = historyRef.current
    if (history) history.scrollTop = history.scrollHeight
  }, [messages, busy])

  async function searchCatalog(query, turnId) {
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setBusy(true)
    setPhase('searching')
    try {
      const catalog = await assistantProvider.searchCertificateCatalog(query, controller.signal)
      if (turnId !== turnRef.current) return
      if (catalog.items.length === 0) {
        addMessage('luca', 'Não encontrei um certificado autorizado com esse nome ou documento. Você pode corrigir a empresa ou tentar outra busca.')
        setPhase('waiting')
      } else if (catalog.items.length === 1) {
        const certificate = catalog.items[0]
        setSelected(certificate)
        addMessage('luca', 'Encontrei este certificado:', { certificate, action: 'confirm' })
        setPhase('confirming')
      } else {
        addMessage('luca', 'Encontrei mais de um resultado. Qual deles você deseja solicitar?', { certificates: catalog.items })
        setPhase('choosing')
      }
    } catch (error) {
      if (error.name !== 'AbortError' && turnId === turnRef.current) {
        addMessage('luca', `Não consegui consultar o catálogo agora. ${error.message || 'Tente novamente em instantes.'}`)
        setPhase('waiting')
      }
    } finally {
      if (searchController.current === controller && turnId === turnRef.current) setBusy(false)
    }
  }

  async function converse(value) {
    if (!assistantProvider.converse) return { reply: 'A conversa inteligente está disponível somente na prévia. Você pode usar a pesquisa tradicional.', intent: 'conversation', query: '', source: 'guided' }
    conversationController.current?.abort()
    const controller = new AbortController()
    conversationController.current = controller
    try {
      return await assistantProvider.converse({ sessionId: sessionIdRef.current, message: value, phase }, controller.signal)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      return { reply: 'Não consegui responder agora. Você pode continuar pela pesquisa tradicional ou informar a empresa e o documento.', intent: 'conversation', query: '', source: 'fallback' }
    } finally {
      if (conversationController.current === controller) conversationController.current = null
    }
  }

  async function verifyAfterUncertainResult(certificateId) {
    try {
      const requests = await assistantProvider.listCertificateRequests()
      return { verified: true, pending: requests.items.some((request) => isPendingForCertificate(request, certificateId)) }
    } catch {
      return { verified: false, pending: false }
    }
  }

  async function confirmCertificate(certificate = selected, addUserMessage = true, turnId = turnRef.current) {
    if (CERTIFICATE_PORTAL_READ_ONLY || !certificate || busy) return
    registerActivity()
    setSelected(certificate)
    setBusy(true)
    setPhase('submitting')
    if (addUserMessage) addMessage('usuario', 'Sim, é esse certificado.')
    addMessage('luca', 'Vou confirmar a solicitação com o TI...')
    try {
      await assistantProvider.createCertificateRequest({ certificadoId: certificate.id })
      if (turnId !== turnRef.current) return
      addMessage('luca', 'Solicitação enviada para o TI!')
      setPhase('sent')
      onRequestConfirmed?.()
    } catch (requestError) {
      const state = await verifyAfterUncertainResult(certificate.id)
      if (turnId !== turnRef.current) return
      if (requestError.status === 409 && state.pending) {
        addMessage('luca', 'Já existe uma solicitação pendente deste certificado para esta estação. Não reenviamos o pedido.')
        setPhase('uncertain')
      } else if (state.pending) {
        addMessage('luca', 'Solicitação enviada para o TI!')
        setPhase('sent')
        onRequestConfirmed?.()
      } else {
        addMessage('luca', `${requestError.message || 'Não consegui confirmar a solicitação.'} O estado foi consultado e não farei um novo envio automático.`)
        setPhase('uncertain')
      }
    } finally {
      if (turnId === turnRef.current) setBusy(false)
    }
  }

  function cancelSelection(addUserMessage = true) {
    if (busy) return
    registerActivity()
    if (addUserMessage) addMessage('usuario', 'Não, quero corrigir.')
    addMessage('luca', 'Tudo bem. Qual empresa ou documento devo procurar?')
    setSelected(null)
    setPhase('waiting')
  }

  function chooseCertificate(certificate) {
    if (busy) return
    registerActivity()
    setSelected(certificate)
    addMessage('usuario', `Vou verificar ${certificate.nomeEmpresa || certificate.nomeExibicao}.`)
    addMessage('luca', 'Encontrei este certificado. É esse que você precisa?', { certificate, action: 'confirm' })
    setPhase('confirming')
  }

  async function sendMessage(event) {
    event?.preventDefault()
    registerActivity()
    if (busy) return
    const value = normalizeMessage(input)
    if (!value) return
    const turnId = ++turnRef.current
    setInput('')
    addMessage('usuario', value)
    const lowered = value.toLowerCase()
    if (/pesquisa tradicional|pesquisar certificado|pesquisar certificados|consulta tradicional/.test(lowered)) {
      onOpenTraditionalSearch?.()
      addMessage('luca', 'Claro. A pesquisa tradicional foi aberta ao lado da conversa.')
      setPhase('waiting')
      return
    }
    if (/\b(?:cancelar|começar novamente|comecar novamente|recomeçar|recomecar)\b/.test(lowered)) {
      addMessage('luca', 'Tudo bem. Vamos começar novamente. Qual empresa ou documento você procura?')
      setSelected(null)
      setPhase('waiting')
      return
    }
    if (phase === 'confirming' && selected && /^(sim|s|é esse|e esse|confirmo|pode solicitar)/i.test(value)) {
      await confirmCertificate(selected, false, turnId)
      return
    }
    if (phase === 'confirming' && /\b(?:não|nao|corrigir|outra empresa)\b/i.test(value)) {
      cancelSelection(false)
      return
    }
    setBusy(true)
    setPhase('thinking')
    try {
      const guidance = await converse(value)
      if (turnId !== turnRef.current) return
      if (guidance.reply) addMessage('luca', guidance.reply)
      const query = normalizeMessage(guidance.query)
      if (guidance.intent === 'certificate_search' && query && phase !== 'confirming') await searchCatalog(query, turnId)
      else setPhase(phase === 'confirming' ? 'confirming' : 'waiting')
    } catch (error) {
      if (error.name !== 'AbortError' && turnId === turnRef.current) {
        addMessage('luca', 'Não consegui responder agora. Qual empresa ou certificado você procura?')
        setPhase('waiting')
      }
    } finally {
      if (turnId === turnRef.current) setBusy(false)
    }
  }

  function handleInputKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage(event)
    }
  }

  return <>
    {!open && !alwaysOpen && <button type="button" className="luca-launcher" onClick={openChat} aria-label="Abrir conversa com Luca"><Avatar small /><span>Peça para o Luca</span></button>}
    {open && <section className={`luca-window ${embedded ? 'luca-window-embedded' : ''} ${minimized ? 'is-minimized' : ''}`} role="dialog" aria-label="Conversa com Luca" aria-modal="false">
      <header className="luca-header">
        <Avatar small />
         <div><strong>Luca</strong><span>Certificados · atendimento guiado · somente consulta</span></div>
        {!embedded && <div className="luca-header-actions"><button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? 'Restaurar conversa' : 'Minimizar conversa'}>{minimized ? '□' : '−'}</button><button type="button" onClick={closeChat} aria-label="Fechar conversa">×</button></div>}
      </header>
      {!minimized && <>
        <div className="luca-history" ref={historyRef} aria-live="polite" onClick={registerActivity}>
            {messages.map((message) => <div className={`luca-message-row luca-message-${message.role}`} key={message.id}><div className="luca-message-bubble">{message.role === 'luca' && <Avatar small />}<div><p>{message.text}</p>{message.action === 'open-search' && <button type="button" className="luca-search-action" onClick={() => onOpenTraditionalSearch?.()}>Abrir pesquisa tradicional</button>}{message.certificate && <CertificateCard certificate={message.certificate} actionLabel={CERTIFICATE_PORTAL_READ_ONLY ? null : 'Sim, é esse'} onAction={() => confirmCertificate(message.certificate)} disabled={busy} />}{message.certificates && <div className="luca-result-list">{message.certificates.map((certificate) => <CertificateCard certificate={certificate} actionLabel={CERTIFICATE_PORTAL_READ_ONLY ? null : 'Escolher este'} onAction={() => chooseCertificate(certificate)} disabled={busy} key={certificate.id} />)}</div>}{message.action === 'confirm' && !CERTIFICATE_PORTAL_READ_ONLY && <div className="luca-message-actions"><button type="button" onClick={cancelSelection} disabled={busy}>Corrigir</button></div>}</div></div></div>)}
           {busy && <div className="luca-message-row luca-message-luca"><div className="luca-message-bubble"><Avatar small /><div><p className="luca-typing">Luca está consultando...</p></div></div></div>}
           {idleWarning && <div className="luca-idle-warning" role="alert"><p>Vou encerrar esta conversa em 1 minuto por inatividade.</p><button type="button" onClick={registerActivity}>Continuar conversa</button></div>}
         </div>
         <form className="luca-composer" onSubmit={sendMessage}><textarea ref={inputRef} value={input} onChange={(event) => { registerActivity(); setInput(event.target.value) }} onKeyDown={handleInputKeyDown} placeholder="Digite sua mensagem..." rows="1" disabled={busy} aria-label="Digite sua mensagem" /><button type="submit" disabled={busy || !input.trim()} aria-label="Enviar mensagem">Enviar</button></form>
      </>}
    </section>}
  </>
}
