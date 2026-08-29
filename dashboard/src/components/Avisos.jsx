import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import SiteNav from './SiteNav'
import { API_URL } from '../config'
import {
  NIVEL_OPTIONS,
  buildAvisoPayload,
  formatApiError,
  groupAvisosHistory,
  historyStatusSummary,
  mapEstadoToLabel,
  mapNivelToLabel
} from '../utils/avisos'

function fmtDate(value) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('pt-BR')
}

function Stat({ label, value, tone = '' }) {
  return (
    <div className="summary-item aviso-stat">
      <span className={`summary-num ${tone}`}>{value}</span>
      <span className="summary-label">{label}</span>
    </div>
  )
}

export default function Avisos() {
  const [serverOk, setServerOk] = useState(true)
  const [computadores, setComputadores] = useState([])
  const [avisos, setAvisos] = useState([])
  const [entregas, setEntregas] = useState([])
  const [titulo, setTitulo] = useState('')
  const [mensagem, setMensagem] = useState('')
  const [nivel, setNivel] = useState('info')
  const [alvoTipo, setAlvoTipo] = useState('todos')
  const [selectedIds, setSelectedIds] = useState([])
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pendingPayload, setPendingPayload] = useState(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const [computersRes, avisosRes, entregasRes] = await Promise.all([
          fetch(`${API_URL}/api/computadores`),
          fetch(`${API_URL}/api/avisos`),
          fetch(`${API_URL}/api/avisos/entregas?limit=300`)
        ])

        if (!active) return
        setServerOk(computersRes.ok && avisosRes.ok && entregasRes.ok)
        const failures = []

        if (!computersRes.ok) failures.push('computadores')
        if (!avisosRes.ok) failures.push('avisos')
        if (!entregasRes.ok) failures.push('entregas')

        setLoadError(
          failures.length ? `Falha ao carregar: ${failures.join(', ')}.` : ''
        )

        if (computersRes.ok) setComputadores(await computersRes.json())
        if (avisosRes.ok) setAvisos(await avisosRes.json())
        if (entregasRes.ok) setEntregas(await entregasRes.json())
      } catch (e) {
        if (active) setServerOk(false)
        if (active) setLoadError('Falha ao carregar os dados da tela de avisos.')
      }
    }

    load()
    const id = setInterval(load, 10000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const targetComputers = useMemo(() => {
    if (alvoTipo === 'selecionados') {
      return computadores.filter((c) => selectedSet.has(c.id))
    }
    if (alvoTipo === 'online') {
      return computadores.filter((c) => c.status === 'online')
    }
    return computadores
  }, [alvoTipo, computadores, selectedSet])

  const history = useMemo(() => groupAvisosHistory(avisos, entregas, computadores), [avisos, entregas, computadores])

  const stats = useMemo(() => {
    const counts = { PENDENTE: 0, ENVIADO: 0, EXIBIDO: 0, CONFIRMADO: 0, EXPIRADO: 0, FALHOU: 0 }
    for (const entrega of entregas) {
      const key = String(entrega?.estado || '').toUpperCase()
      if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1
    }
    return counts
  }, [entregas])

  const clearSelection = () => setSelectedIds([])

  const toggleSelected = (id) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  }

  const selectOnline = () => {
    setSelectedIds(computadores.filter((c) => c.status === 'online').map((c) => c.id))
    setAlvoTipo('selecionados')
  }

  const selectAll = () => {
    setSelectedIds(computadores.map((c) => c.id))
    setAlvoTipo('selecionados')
  }

  const needsConfirmation =
    alvoTipo === 'todos' || alvoTipo === 'online' || (alvoTipo === 'selecionados' && selectedIds.length > 1)

  const sendAviso = async (payload) => {
    const response = await fetch(`${API_URL}/api/avisos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(formatApiError(data, 'Falha ao enviar aviso'))
    }

    setTitulo('')
    setMensagem('')
    setNivel('info')
    setNotice('Aviso enviado com sucesso.')
    setPendingPayload(null)

    const [nextAvisos, nextEntregas] = await Promise.all([
      fetch(`${API_URL}/api/avisos`).then((r) => (r.ok ? r.json() : avisos)),
      fetch(`${API_URL}/api/avisos/entregas?limit=300`).then((r) => (r.ok ? r.json() : entregas))
    ])
    setAvisos(nextAvisos)
    setEntregas(nextEntregas)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    const payload = buildAvisoPayload({ titulo, mensagem, nivel, alvoTipo }, selectedIds)

    if (needsConfirmation) {
      setPendingPayload(payload)
      return
    }

    setSaving(true)
    try {
      await sendAviso(payload)
    } catch (e) {
      setError(e.message || 'Falha ao enviar aviso')
    } finally {
      setSaving(false)
    }
  }

  const confirmSend = async () => {
    if (!pendingPayload) return
    setSaving(true)
    setError('')
    try {
      await sendAviso(pendingPayload)
    } catch (e) {
      setError(e.message || 'Falha ao enviar aviso')
    } finally {
      setSaving(false)
    }
  }

  const formDisabled = saving
  const canSubmit = titulo.trim() && mensagem.trim() && targetComputers.length > 0

  return (
    <div className="container avisos-page">
      <SiteNav />
      <div className="page-head">
        <div>
          <h1>Avisos</h1>
          <p>Envie notificações imediatas e acompanhe o status de entrega por máquina.</p>
        </div>
        <Link className="details-link" to="/">
          Voltar ao Dashboard
        </Link>
      </div>

      <p>
        Servidor: <span className={serverOk ? 'online' : 'offline'}>{serverOk ? 'Online' : 'Offline'}</span>
      </p>
      {!serverOk && <p className="server-warn">Não foi possível atualizar os dados.</p>}
      {loadError && <p className="notice error">{loadError}</p>}

      {notice && <p className="notice success">{notice}</p>}
      {error && <p className="notice error">{error}</p>}

      <div className="summary aviso-summary">
        <Stat label="Total" value={avisos.length} />
        <Stat label="Pendente" value={stats.PENDENTE} />
        <Stat label="Enviado" value={stats.ENVIADO} />
        <Stat label="Confirmado" value={stats.CONFIRMADO} tone="online" />
      </div>

      <div className="avisos-layout">
        <section className="panel">
          <h2>Novo aviso</h2>
          <form className="aviso-form" onSubmit={handleSubmit}>
            <label>
              Título
              <input
                type="text"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                maxLength={100}
                disabled={formDisabled}
                placeholder="Ex.: Manutenção agendada"
              />
            </label>

            <label>
              Mensagem
              <textarea
                value={mensagem}
                onChange={(e) => setMensagem(e.target.value)}
                maxLength={2000}
                disabled={formDisabled}
                rows={6}
                placeholder="Descreva o comunicado para os usuários"
              />
            </label>

            <div className="field-group">
              <label>
                Nível
                <select value={nivel} onChange={(e) => setNivel(e.target.value)} disabled={formDisabled}>
                  {NIVEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Destino
                <select
                  value={alvoTipo}
                  onChange={(e) => setAlvoTipo(e.target.value)}
                  disabled={formDisabled}
                >
                  <option value="todos">Todas as máquinas</option>
                  <option value="online">Somente online</option>
                  <option value="selecionados">Selecionar máquinas</option>
                </select>
              </label>
            </div>

            <div className="destination-tools">
              <button type="button" className="btn-tool" onClick={selectAll} disabled={formDisabled}>
                Selecionar todas
              </button>
              <button type="button" className="btn-tool" onClick={selectOnline} disabled={formDisabled}>
                Selecionar online
              </button>
              <button type="button" className="btn-tool" onClick={clearSelection} disabled={formDisabled}>
                Limpar seleção
              </button>
            </div>

            {alvoTipo === 'selecionados' && (
              <div className="computer-picker">
                {computadores.length === 0 ? (
                  <p className="muted">Nenhum computador disponível para seleção.</p>
                ) : (
                  computadores.map((c) => (
                    <label key={c.id} className="computer-option">
                      <input
                        type="checkbox"
                        checked={selectedSet.has(c.id)}
                        onChange={() => toggleSelected(c.id)}
                        disabled={formDisabled}
                      />
                      <span>
                        <strong>{c.hostname || '(sem nome)'}</strong>
                        <small>
                          {c.usuario || '-'} · {c.status || '-'}
                        </small>
                        {('noticesReady' in c) && (
                          <small>
                            Prontidão para avisos: {c.noticesReady ? 'Pronto' : 'Indisponível'}
                          </small>
                        )}
                      </span>
                    </label>
                  ))
                )}
              </div>
            )}

            <div className="destination-preview">
              Destino atual:{' '}
              <strong>
                {alvoTipo === 'selecionados'
                  ? `${targetComputers.length} máquina(s)`
                  : alvoTipo === 'online'
                  ? 'Máquinas online'
                  : 'Todas as máquinas'}
              </strong>
            </div>

            <button type="submit" className="btn-update" disabled={formDisabled || !canSubmit}>
              {saving ? 'Enviando...' : 'Enviar agora'}
            </button>

            {pendingPayload && (
              <div className="confirm-box">
                <p>
                  Este aviso será enviado para{' '}
                  <strong>
                    {alvoTipo === 'selecionados'
                      ? `${selectedIds.length} máquina(s)`
                      : alvoTipo === 'online'
                      ? 'máquinas online'
                      : 'todas as máquinas'}
                  </strong>
                  . Deseja continuar?
                </p>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={() => setPendingPayload(null)}
                    disabled={saving}
                  >
                    Cancelar
                  </button>
                  <button type="button" className="btn-update" onClick={confirmSend} disabled={saving}>
                    Confirmar envio
                  </button>
                </div>
              </div>
            )}
          </form>
        </section>

        <section className="panel">
          <h2>Histórico</h2>
          {history.length === 0 ? (
            <p className="empty">Nenhum aviso enviado ainda.</p>
          ) : (
            <div className="avisos-history">
              {history.map((item) => (
                <article key={item.id} className="aviso-history-item">
                  <div className="aviso-history-top">
                    <div>
                      <div className="aviso-history-title">{item.titulo}</div>
                      <div className="aviso-history-meta">
                        {mapNivelToLabel(item.nivel)} · {fmtDate(item.criadoEm)}
                      </div>
                    </div>
                    <span className={`ah-badge ${item.primaryStatus === 'CONFIRMADO' ? 'resolvido' : ''}`}>
                      {mapEstadoToLabel(item.primaryStatus)}
                    </span>
                  </div>

                  <div className="aviso-history-info">
                    <span>{item.destinoLabel}</span>
                    <span>
                      {item.quantidadeMaquinas} máquina(s) · {historyStatusSummary(item.counts)}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
