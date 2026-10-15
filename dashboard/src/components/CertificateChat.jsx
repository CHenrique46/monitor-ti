import { useEffect, useRef, useState } from 'react'
import * as guidedCertificateProvider from '../services/certificateChatApi'
import * as aiCertificateProvider from '../services/certificateChatAiApi'
import { formatCertificateValidity } from '../formatCertificateValidity'

const OPENING_MESSAGE = 'Oi! Eu sou o Luca! 😊 Posso ajudar você a encontrar e solicitar um certificado. Qual empresa você procura?'
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

function isGreeting(value) {
  return /^(oi|olá|ola|bom dia|boa tarde|boa noite|olá luca|ola luca)[!,.\s]*$/i.test(value)
}

function isComputerProblem(value) {
  return /\b(?:computador|pc|notebook|windows|impressora|outlook|internet|dns|senha|erro técnico|problema técnico)\b/i.test(value)
}

function extractCatalogQuery(value) {
  return normalizeMessage(value)
    .replace(/^(?:oi|olá|ola|bom dia|boa tarde|boa noite)\b[,!\.\s]*/i, '')
    .replace(/\b(?:por favor|poderia|pode|quero|preciso|necessito|me consiga|me arrume)\b/gi, ' ')
    .replace(/\b(?:corrigir|corrijo|na verdade|trocar|troquei|é|e)\b/gi, ' ')
    .replace(/\b(?:do|da|de|dos|das|um|uma|o|a|os|as)\b/gi, ' ')
    .replace(/\bcertificados?\b/gi, ' ')
    .replace(/\b(?:para mim|pra mim)\b/gi, ' ')
    .replace(/[?!,.;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

export default function CertificateChat({ onRequestConfirmed, assistantProvider = previewAiEnabled ? aiCertificateProvider : guidedCertificateProvider }) {
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [selected, setSelected] = useState(null)
  const [phase, setPhase] = useState('waiting')
  const [busy, setBusy] = useState(false)
  const searchController = useRef(null)
  const conversationController = useRef(null)
  const sessionIdRef = useRef(null)
  const inputRef = useRef(null)
  const historyRef = useRef(null)

  function addMessage(role, text, extra) {
    setMessages((current) => [...current, newMessage(role, text, extra)])
  }

  function resetConversation() {
    searchController.current?.abort()
    conversationController.current?.abort()
    setInput('')
    setMessages([newMessage('luca', OPENING_MESSAGE)])
    setSelected(null)
    setPhase('waiting')
    setBusy(false)
    sessionIdRef.current = `luca-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  function openChat() {
    resetConversation()
    setOpen(true)
    setMinimized(false)
  }

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

  async function searchCatalog(query) {
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setBusy(true)
    setPhase('searching')
    try {
      const catalog = await assistantProvider.searchCertificateCatalog(query, controller.signal)
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
      if (error.name !== 'AbortError') {
        addMessage('luca', `Não consegui consultar o catálogo agora. ${error.message || 'Tente novamente em instantes.'}`)
        setPhase('waiting')
      }
    } finally {
      if (searchController.current === controller) setBusy(false)
    }
  }

  function fallbackConversation(value, currentPhase) {
    if (isGreeting(value)) return { reply: 'Olá! Eu sou o Luca, assistente do Escritório Vavá. Qual empresa ou certificado você procura?', intent: 'greeting' }
    if (/\b(?:obrigad[oa]|valeu|agradeço|agradeco)\b/i.test(value)) return { reply: 'Por nada! Se precisar de um certificado, é só me dizer a empresa.', intent: 'thanks' }
    if (isComputerProblem(value)) return { reply: 'Posso ajudar com solicitações de certificados. Para problemas no computador, procure o Henrique do TI.', intent: 'pc_support' }
    if (currentPhase === 'confirming') return { reply: 'Posso continuar com o certificado exibido ou você pode usar “Corrigir”. A mudança de assunto não altera a solicitação.', intent: 'change_subject' }
    return { reply: 'Entendi. Qual empresa ou certificado você procura?', intent: 'clarify', query: extractCatalogQuery(value) }
  }

  async function converse(value) {
    if (!assistantProvider.converse) return fallbackConversation(value, phase)
    conversationController.current?.abort()
    const controller = new AbortController()
    conversationController.current = controller
    try {
      return await assistantProvider.converse({ sessionId: sessionIdRef.current, message: value, phase }, controller.signal)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      return fallbackConversation(value, phase)
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

  async function confirmCertificate(certificate = selected, addUserMessage = true) {
    if (!certificate || busy) return
    setSelected(certificate)
    setBusy(true)
    setPhase('submitting')
    if (addUserMessage) addMessage('usuario', 'Sim, é esse certificado.')
    addMessage('luca', 'Vou confirmar a solicitação com o TI...')
    try {
      await assistantProvider.createCertificateRequest({ certificadoId: certificate.id })
      addMessage('luca', 'Solicitação enviada para o TI!')
      setPhase('sent')
      onRequestConfirmed?.()
    } catch (requestError) {
      const state = await verifyAfterUncertainResult(certificate.id)
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
      setBusy(false)
    }
  }

  function cancelSelection(addUserMessage = true) {
    if (busy) return
    if (addUserMessage) addMessage('usuario', 'Não, quero corrigir.')
    addMessage('luca', 'Tudo bem. Qual empresa ou documento devo procurar?')
    setSelected(null)
    setPhase('waiting')
  }

  function chooseCertificate(certificate) {
    if (busy) return
    setSelected(certificate)
    addMessage('usuario', `Vou verificar ${certificate.nomeEmpresa || certificate.nomeExibicao}.`)
    addMessage('luca', 'Encontrei este certificado. É esse que você precisa?', { certificate, action: 'confirm' })
    setPhase('confirming')
  }

  async function sendMessage(event) {
    event?.preventDefault()
    if (busy) return
    const value = normalizeMessage(input)
    if (!value) return
    setInput('')
    addMessage('usuario', value)
    const lowered = value.toLowerCase()
    if (/\b(?:cancelar|começar novamente|comecar novamente|recomeçar|recomecar)\b/.test(lowered)) {
      addMessage('luca', 'Tudo bem. Vamos começar novamente. Qual empresa ou documento você procura?')
      setSelected(null)
      setPhase('waiting')
      return
    }
    if (phase === 'confirming' && selected && /^(sim|s|é esse|e esse|confirmo|pode solicitar)/i.test(value)) {
      await confirmCertificate(selected, false)
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
      if (guidance.reply) addMessage('luca', guidance.reply)
      const query = normalizeMessage(guidance.query)
      if (query && phase !== 'confirming') await searchCatalog(query)
      else setPhase(phase === 'confirming' ? 'confirming' : 'waiting')
    } catch (error) {
      if (error.name !== 'AbortError') {
        addMessage('luca', 'Não consegui responder agora. Qual empresa ou certificado você procura?')
        setPhase('waiting')
      }
    } finally {
      setBusy(false)
    }
  }

  function handleInputKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage(event)
    }
  }

  return <>
    {!open && <button type="button" className="luca-launcher" onClick={openChat} aria-label="Abrir conversa com Luca"><Avatar small /><span>Peça para o Luca</span></button>}
    {open && <section className={`luca-window ${minimized ? 'is-minimized' : ''}`} role="dialog" aria-label="Conversa com Luca" aria-modal="false">
      <header className="luca-header">
        <Avatar small />
        <div><strong>Luca</strong><span>Certificados · atendimento guiado</span></div>
        <div className="luca-header-actions"><button type="button" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? 'Restaurar conversa' : 'Minimizar conversa'}>{minimized ? '□' : '−'}</button><button type="button" onClick={closeChat} aria-label="Fechar conversa">×</button></div>
      </header>
      {!minimized && <>
        <div className="luca-history" ref={historyRef} aria-live="polite">
          {messages.map((message) => <div className={`luca-message-row luca-message-${message.role}`} key={message.id}><div className="luca-message-bubble">{message.role === 'luca' && <Avatar small />}<div><p>{message.text}</p>{message.certificate && <CertificateCard certificate={message.certificate} actionLabel="Sim, é esse" onAction={() => confirmCertificate(message.certificate)} disabled={busy} />}{message.certificates && <div className="luca-result-list">{message.certificates.map((certificate) => <CertificateCard certificate={certificate} actionLabel="Escolher este" onAction={() => chooseCertificate(certificate)} disabled={busy} key={certificate.id} />)}</div>}{message.action === 'confirm' && <div className="luca-message-actions"><button type="button" onClick={cancelSelection} disabled={busy}>Corrigir</button></div>}</div></div></div>)}
          {busy && <div className="luca-message-row luca-message-luca"><div className="luca-message-bubble"><Avatar small /><div><p className="luca-typing">Luca está consultando...</p></div></div></div>}
        </div>
        <form className="luca-composer" onSubmit={sendMessage}><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleInputKeyDown} placeholder="Digite sua mensagem..." rows="1" disabled={busy} aria-label="Digite sua mensagem" /><button type="submit" disabled={busy || !input.trim()} aria-label="Enviar mensagem">Enviar</button></form>
      </>}
    </section>}
  </>
}
