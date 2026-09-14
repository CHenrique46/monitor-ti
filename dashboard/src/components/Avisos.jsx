import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import SiteNav from './SiteNav'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { useAuth } from '../auth/AuthContext'
import {
  buildSelectionSummary,
  NIVEL_OPTIONS,
  WEEKDAY_OPTIONS,
  buildAgendamentoCreatePayload,
  buildAgendamentoDraft,
  buildAgendamentoUpdateBody,
  buildAvisoPayload,
  filterComputersForSelection,
  filterAvisosHistory,
  describeScheduleTarget,
  formatApiError,
  formatRecurrenceLabel,
  formatScheduleStatus,
  formatZoneDateTime,
  formatNullableDateTime,
  getScheduleFormFromRecord,
  getZoneDateInputValue,
  getZoneTimeInputValue,
  groupAvisosHistory,
  historyStatusSummary,
  isComputerReadyForNotice,
  mapEstadoToLabel,
  mapNivelToLabel,
  getZoneWeekday,
  summarizeHistoryDeliveries,
  saoPauloToUtc,
  selectVisibleComputerIds
} from '../utils/avisos'

function Stat({ label, value, tone = '' }) {
  return (
    <div className="summary-item aviso-stat">
      <span className={`summary-num ${tone}`}>{value}</span>
      <span className="summary-label">{label}</span>
    </div>
  )
}

function fmtServerDate(value) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('pt-BR')
}

const defaultScheduleState = () => {
  const baseDate = getZoneDateInputValue()
  const baseTime = getZoneTimeInputValue()
  const [year, month, day] = baseDate.split('-').map(Number)
  const [hour, minute] = baseTime.split(':').map(Number)
  const tomorrow = saoPauloToUtc(year, month, day + 1, hour, minute)

  return {
    tipo: 'once',
    data: getZoneDateInputValue(tomorrow),
    hora: baseTime,
    diaSemana: getZoneWeekday()
  }
}

export default function Avisos() {
  const { user } = useAuth()
  const isAdmin = user.role === 'ADMIN'
  const [serverOk, setServerOk] = useState(true)
  const [computadores, setComputadores] = useState([])
  const [avisos, setAvisos] = useState([])
  const [entregas, setEntregas] = useState([])
  const [agendamentos, setAgendamentos] = useState([])
  const [titulo, setTitulo] = useState('')
  const [mensagem, setMensagem] = useState('')
  const [nivel, setNivel] = useState('info')
  const [alvoTipo, setAlvoTipo] = useState('todos')
  const [selectedIds, setSelectedIds] = useState([])
  const [selectionSearch, setSelectionSearch] = useState('')
  const [selectionStatusFilter, setSelectionStatusFilter] = useState('all')
  const [selectionReadinessFilter, setSelectionReadinessFilter] = useState('all')
  const [mode, setMode] = useState('immediate')
  const [historySearch, setHistorySearch] = useState('')
  const [historyStatusFilter, setHistoryStatusFilter] = useState('all')
  const [historyLevelFilter, setHistoryLevelFilter] = useState('all')
  const [historyPeriodFilter, setHistoryPeriodFilter] = useState('all')
  const [schedule, setSchedule] = useState(defaultScheduleState())
  const [editingScheduleId, setEditingScheduleId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [pendingImmediatePayload, setPendingImmediatePayload] = useState(null)
  const [pendingScheduleAction, setPendingScheduleAction] = useState(null)
  const [pendingDeleteSchedule, setPendingDeleteSchedule] = useState(null)

  const reloadData = async () => {
    try {
      const [computersRes, avisosRes, entregasRes, agendamentosRes] = await Promise.all([
        apiFetch(`${API_URL}/api/computadores`),
        apiFetch(`${API_URL}/api/avisos`),
        apiFetch(`${API_URL}/api/avisos/entregas?limit=300`),
        apiFetch(`${API_URL}/api/avisos/agendamentos`)
      ])

      setServerOk(computersRes.ok && avisosRes.ok && entregasRes.ok && agendamentosRes.ok)

      const failures = []
      if (!computersRes.ok) failures.push('computadores')
      if (!avisosRes.ok) failures.push('avisos')
      if (!entregasRes.ok) failures.push('entregas')
      if (!agendamentosRes.ok) failures.push('agendamentos')
      setLoadError(failures.length ? `Falha ao carregar: ${failures.join(', ')}.` : '')

      if (computersRes.ok) {
        const items = await computersRes.json()
        const enriched = await Promise.all(
          items.map(async (computer) => {
            try {
              const capRes = await apiFetch(`${API_URL}/api/computadores/${computer.id}/capabilities`)
              if (!capRes.ok) return { ...computer, noticesReady: null }
              const cap = await capRes.json()
              return {
                ...computer,
                noticesReady: typeof cap.notifierReady === 'boolean' ? cap.notifierReady : null
              }
            } catch (e) {
              return { ...computer, noticesReady: null }
            }
          })
        )
        setComputadores(enriched)
      }
      if (avisosRes.ok) setAvisos(await avisosRes.json())
      if (entregasRes.ok) setEntregas(await entregasRes.json())
      if (agendamentosRes.ok) setAgendamentos(await agendamentosRes.json())
    } catch (e) {
      setServerOk(false)
      setLoadError('Falha ao carregar os dados da tela de avisos.')
    }
  }

  useEffect(() => {
    let active = true

    const load = async () => {
      if (!active) return
      await reloadData()
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
    if (alvoTipo === 'selecionados') return computadores.filter((c) => selectedSet.has(c.id))
    if (alvoTipo === 'online') return computadores.filter((c) => c.status === 'online')
    return computadores
  }, [alvoTipo, computadores, selectedSet])

  const history = useMemo(() => groupAvisosHistory(avisos, entregas, computadores), [avisos, entregas, computadores])

  const filteredHistory = useMemo(
    () =>
      filterAvisosHistory(
        history,
        {
          search: historySearch,
          status: historyStatusFilter,
          nivel: historyLevelFilter,
          period: historyPeriodFilter
        },
        new Date()
      ),
    [history, historyLevelFilter, historyPeriodFilter, historySearch, historyStatusFilter]
  )

  const historyTotals = useMemo(
    () => summarizeHistoryDeliveries(filteredHistory),
    [filteredHistory]
  )

  const visibleComputers = useMemo(
    () =>
      filterComputersForSelection(computadores, {
        search: selectionSearch,
        statusFilter: selectionStatusFilter,
        readinessFilter: selectionReadinessFilter
      }),
    [computadores, selectionReadinessFilter, selectionSearch, selectionStatusFilter]
  )

  const selectionSummary = useMemo(
    () => buildSelectionSummary(computadores, visibleComputers, selectedIds),
    [computadores, selectedIds, visibleComputers]
  )

  const readinessFilterAvailable = useMemo(
    () => computadores.some((c) => isComputerReadyForNotice(c) != null),
    [computadores]
  )

  const scheduleDraft = useMemo(() => {
    if (mode !== 'schedule') return null
    try {
      return buildAgendamentoDraft(
        {
          tipo: schedule.tipo,
          data: schedule.data,
          hora: schedule.hora,
          diaSemana: schedule.diaSemana
        },
        new Date()
      )
    } catch (e) {
      return { error: e.message }
    }
  }, [mode, schedule])

  const immediateCanSubmit = titulo.trim() && mensagem.trim() && targetComputers.length > 0
  const scheduleCanSubmit =
    titulo.trim() && mensagem.trim() && targetComputers.length > 0 && !scheduleDraft?.error

  const clearMessages = () => {
    setNotice('')
    setError('')
  }

  const clearEditState = () => {
    setEditingScheduleId(null)
    setPendingScheduleAction(null)
  }

  const clearSelectionFilters = () => {
    setSelectionSearch('')
    setSelectionStatusFilter('all')
    setSelectionReadinessFilter('all')
  }

  const resetImmediateForm = () => {
    setTitulo('')
    setMensagem('')
    setNivel('info')
    setSelectedIds([])
    setAlvoTipo('todos')
    setPendingImmediatePayload(null)
  }

  const resetScheduleForm = () => {
    setSchedule(defaultScheduleState())
    setPendingScheduleAction(null)
  }

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

  const selectVisible = () => {
    setSelectedIds((current) => selectVisibleComputerIds(current, visibleComputers))
    setAlvoTipo('selecionados')
  }

  const clearSelection = () => setSelectedIds([])

  const loadScheduleRecord = (record) => {
    const form = getScheduleFormFromRecord(record)
    setMode('schedule')
    setTitulo(form.titulo)
    setMensagem(form.mensagem)
    setNivel(form.nivel)
    setAlvoTipo(form.alvoTipo)
    setSelectedIds(form.alvoTipo === 'selecionados' ? form.alvoIds : [])
    clearSelectionFilters()
    setSchedule({
      tipo: form.tipo,
      data: form.data,
      hora: form.hora,
      diaSemana: form.diaSemana
    })
    setEditingScheduleId(record.id)
    clearMessages()
    setPendingImmediatePayload(null)
  }

  const buildImmediateAction = () => buildAvisoPayload({ titulo, mensagem, nivel, alvoTipo }, selectedIds)

  const buildScheduleAction = () => {
    const form = {
      titulo,
      mensagem,
      nivel,
      alvoTipo,
      tipo: schedule.tipo,
      data: schedule.data,
      hora: schedule.hora,
      diaSemana: schedule.diaSemana
    }

    if (editingScheduleId) {
      return {
        method: 'PUT',
        url: `${API_URL}/api/avisos/agendamentos/${editingScheduleId}`,
        body: buildAgendamentoUpdateBody(form, selectedIds)
      }
    }

    const { payload, draft } = buildAgendamentoCreatePayload(form, selectedIds)
    return {
      method: 'POST',
      url: `${API_URL}/api/avisos`,
      body: payload,
      summary: draft.summary
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    clearMessages()

    if (mode === 'immediate') {
      const payload = buildImmediateAction()
      if (selectedIds.length > 1 || alvoTipo === 'todos' || alvoTipo === 'online') {
        setPendingScheduleAction(null)
        setPendingImmediatePayload(payload)
        return
      }

      setSaving(true)
      try {
        const response = await apiFetch(`${API_URL}/api/avisos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(formatApiError(data, 'Falha ao enviar aviso'))
        resetImmediateForm()
        setNotice('Aviso enviado com sucesso.')
        await reloadData()
      } catch (e) {
        setError(e.message || 'Falha ao enviar aviso')
      } finally {
        setSaving(false)
      }
      return
    }

    const action = buildScheduleAction()
    setPendingImmediatePayload(null)
    setPendingScheduleAction(action)
  }

  const confirmImmediateSend = async () => {
    if (!pendingImmediatePayload) return
    setSaving(true)
    clearMessages()
    try {
      const response = await apiFetch(`${API_URL}/api/avisos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingImmediatePayload)
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(formatApiError(data, 'Falha ao enviar aviso'))
      resetImmediateForm()
      setNotice('Aviso enviado com sucesso.')
      await reloadData()
    } catch (e) {
      setError(e.message || 'Falha ao enviar aviso')
    } finally {
      setSaving(false)
    }
  }

  const confirmScheduleAction = async () => {
    if (!pendingScheduleAction) return
    setSaving(true)
    clearMessages()
    try {
      const response = await apiFetch(pendingScheduleAction.url, {
        method: pendingScheduleAction.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingScheduleAction.body)
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(formatApiError(data, 'Falha ao salvar agendamento'))
      resetImmediateForm()
      resetScheduleForm()
      clearEditState()
      setNotice(
        pendingScheduleAction.method === 'PUT'
          ? 'Agendamento atualizado com sucesso.'
          : 'Agendamento criado com sucesso.'
      )
      await reloadData()
    } catch (e) {
      setError(e.message || 'Falha ao salvar agendamento')
    } finally {
      setSaving(false)
    }
  }

  const confirmDeleteSchedule = async () => {
    if (!pendingDeleteSchedule) return
    setSaving(true)
    clearMessages()
    try {
      const response = await apiFetch(`${API_URL}/api/avisos/agendamentos/${pendingDeleteSchedule.id}`, {
        method: 'DELETE'
      })
      if (!response.ok && response.status !== 204) {
        const data = await response.json().catch(() => ({}))
        throw new Error(formatApiError(data, 'Falha ao cancelar agendamento'))
      }
      if (editingScheduleId === pendingDeleteSchedule.id) {
        clearEditState()
        resetScheduleForm()
      }
      setNotice('Agendamento cancelado.')
      setPendingDeleteSchedule(null)
      await reloadData()
    } catch (e) {
      setError(e.message || 'Falha ao cancelar agendamento')
    } finally {
      setSaving(false)
    }
  }

  const formDisabled = !isAdmin || saving
  const canSubmit = mode === 'immediate' ? immediateCanSubmit : scheduleCanSubmit

  const scheduleLabel = editingScheduleId ? 'Salvar alterações' : 'Agendar'
  const scheduleSummary = scheduleDraft?.summary || '-'

  return (
    <div className={`container avisos-page ${isAdmin ? '' : 'viewer-mode'}`}>
      <SiteNav />
      <div className="page-head">
        <div>
          <h1>Avisos</h1>
          <p>Envie comunicados imediatos ou agende execuções recorrentes para as máquinas.</p>
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
        <Stat label="Pendente" value={entregas.filter((e) => e.estado === 'PENDENTE').length} />
        <Stat label="Enviado" value={entregas.filter((e) => e.estado === 'ENVIADO').length} />
        <Stat label="Confirmado" value={entregas.filter((e) => e.estado === 'CONFIRMADO').length} tone="online" />
      </div>

      <div className="avisos-layout">
        <section className="panel">
          <h2>Novo aviso</h2>
          <form className="aviso-form" onSubmit={handleSubmit}>
            <div className="segmented-control" role="tablist" aria-label="Modo do aviso">
              <button
                type="button"
                className={mode === 'immediate' ? 'segment-btn active' : 'segment-btn'}
                onClick={() => setMode('immediate')}
                disabled={formDisabled}
              >
                Enviar agora
              </button>
              <button
                type="button"
                className={mode === 'schedule' ? 'segment-btn active' : 'segment-btn'}
                onClick={() => setMode('schedule')}
                disabled={formDisabled}
              >
                Agendar
              </button>
            </div>

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
                  <option value="online">Máquinas online</option>
                  <option value="selecionados">Selecionar máquinas</option>
                </select>
              </label>
            </div>

            {alvoTipo === 'selecionados' && (
              <div className="selection-box">
                <div className="selection-toolbar">
                  <input
                    type="search"
                    value={selectionSearch}
                    onChange={(e) => setSelectionSearch(e.target.value)}
                    placeholder="Buscar por hostname, usuário ou IP"
                    disabled={formDisabled}
                  />

                  <select
                    value={selectionStatusFilter}
                    onChange={(e) => setSelectionStatusFilter(e.target.value)}
                    disabled={formDisabled}
                  >
                    <option value="all">Todas</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                  </select>

                  {readinessFilterAvailable && (
                    <select
                      value={selectionReadinessFilter}
                      onChange={(e) => setSelectionReadinessFilter(e.target.value)}
                      disabled={formDisabled}
                    >
                      <option value="all">Todas</option>
                      <option value="ready">Aptas para aviso</option>
                      <option value="unready">Indisponíveis para aviso</option>
                    </select>
                  )}
                </div>

                <div className="selection-meta">
                  <span>{selectionSummary.selected} selecionadas</span>
                  <span>{selectionSummary.visible} visíveis</span>
                  <span>{selectionSummary.total} máquinas</span>
                </div>

                <div className="destination-tools">
                  <button type="button" className="btn-tool" onClick={selectVisible} disabled={formDisabled}>
                    Selecionar visíveis
                  </button>
                  <button type="button" className="btn-tool" onClick={clearSelection} disabled={formDisabled}>
                    Limpar seleção
                  </button>
                </div>

                <div className="computer-picker">
                  {visibleComputers.length === 0 ? (
                    <p className="muted">Nenhum computador corresponde aos filtros.</p>
                  ) : (
                    visibleComputers.map((c) => {
                      const ready = isComputerReadyForNotice(c)
                      return (
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
                              {c.usuario || '-'} · {c.status === 'online' ? 'Online' : 'Offline'}
                              {c.ip ? ` · ${c.ip}` : ''}
                              {c.agentVersion ? ` · v${c.agentVersion}` : ''}
                            </small>
                            {ready != null && (
                              <small>Prontidão para avisos: {ready ? 'Pronto' : 'Indisponível'}</small>
                            )}
                          </span>
                        </label>
                      )
                    })
                  )}
                </div>
              </div>
            )}

            {mode === 'schedule' && (
              <div className="schedule-box">
                <div className="schedule-kind">
                  <label className={schedule.tipo === 'once' ? 'radio-pill active' : 'radio-pill'}>
                    <input
                      type="radio"
                      name="schedule-type"
                      value="once"
                      checked={schedule.tipo === 'once'}
                      onChange={() => setSchedule((s) => ({ ...s, tipo: 'once' }))}
                      disabled={formDisabled}
                    />
                    Uma vez
                  </label>
                  <label className={schedule.tipo === 'daily' ? 'radio-pill active' : 'radio-pill'}>
                    <input
                      type="radio"
                      name="schedule-type"
                      value="daily"
                      checked={schedule.tipo === 'daily'}
                      onChange={() => setSchedule((s) => ({ ...s, tipo: 'daily' }))}
                      disabled={formDisabled}
                    />
                    Diariamente
                  </label>
                  <label className={schedule.tipo === 'weekly' ? 'radio-pill active' : 'radio-pill'}>
                    <input
                      type="radio"
                      name="schedule-type"
                      value="weekly"
                      checked={schedule.tipo === 'weekly'}
                      onChange={() => setSchedule((s) => ({ ...s, tipo: 'weekly' }))}
                      disabled={formDisabled}
                    />
                    Semanalmente
                  </label>
                </div>

                {schedule.tipo === 'once' && (
                  <div className="schedule-grid two-cols">
                    <label>
                      Data
                      <input
                        type="date"
                        value={schedule.data}
                        onChange={(e) => setSchedule((s) => ({ ...s, data: e.target.value }))}
                        disabled={formDisabled}
                      />
                    </label>
                    <label>
                      Horário
                      <input
                        type="time"
                        value={schedule.hora}
                        onChange={(e) => setSchedule((s) => ({ ...s, hora: e.target.value }))}
                        disabled={formDisabled}
                      />
                    </label>
                  </div>
                )}

                {schedule.tipo === 'daily' && (
                  <div className="schedule-grid one-col">
                    <label>
                      Horário
                      <input
                        type="time"
                        value={schedule.hora}
                        onChange={(e) => setSchedule((s) => ({ ...s, hora: e.target.value }))}
                        disabled={formDisabled}
                      />
                    </label>
                    <p className="schedule-note">Todos os dias às {schedule.hora || '--:--'}.</p>
                  </div>
                )}

                {schedule.tipo === 'weekly' && (
                  <div className="schedule-grid two-cols">
                    <label>
                      Dia da semana
                      <select
                        value={schedule.diaSemana}
                        onChange={(e) => setSchedule((s) => ({ ...s, diaSemana: Number(e.target.value) }))}
                        disabled={formDisabled}
                      >
                        {WEEKDAY_OPTIONS.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.short}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Horário
                      <input
                        type="time"
                        value={schedule.hora}
                        onChange={(e) => setSchedule((s) => ({ ...s, hora: e.target.value }))}
                        disabled={formDisabled}
                      />
                    </label>
                    <p className="schedule-note">
                      Toda {WEEKDAY_OPTIONS.find((d) => d.value === Number(schedule.diaSemana))?.long || 'segunda-feira'} às {schedule.hora || '--:--'}.
                    </p>
                  </div>
                )}

                <div className="schedule-preview">
                  Primeira execução: <strong>{scheduleSummary}</strong>
                </div>
                {scheduleDraft?.error && <p className="schedule-error">{scheduleDraft.error}</p>}
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
              {saving ? 'Processando...' : mode === 'immediate' ? 'Enviar agora' : scheduleLabel}
            </button>

            {pendingImmediatePayload && (
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
                  <button type="button" className="btn-cancel" onClick={() => setPendingImmediatePayload(null)}>
                    Cancelar
                  </button>
                  <button type="button" className="btn-update" onClick={confirmImmediateSend} disabled={saving}>
                    Confirmar envio
                  </button>
                </div>
              </div>
            )}

            {pendingScheduleAction && (
              <div className="confirm-box">
                <p>
                  Título: <strong>{titulo || '-'}</strong>
                </p>
                <p>
                  Destino: <strong>{describeScheduleTarget(pendingScheduleAction.body, computadores)}</strong>
                </p>
                <p>
                  Execução: <strong>{pendingScheduleAction.summary || scheduleSummary}</strong>
                </p>
                <p>Deseja criar este agendamento?</p>
                <div className="confirm-actions">
                  <button type="button" className="btn-cancel" onClick={() => setPendingScheduleAction(null)}>
                    Cancelar
                  </button>
                  <button type="button" className="btn-update" onClick={confirmScheduleAction} disabled={saving}>
                    Confirmar agendamento
                  </button>
                </div>
              </div>
            )}
          </form>
        </section>

        <div className="avisos-side">
          <section className="panel">
            <h2>Agendamentos</h2>
            {agendamentos.length === 0 ? (
              <p className="empty">Nenhum agendamento cadastrado.</p>
            ) : (
              <div className="schedule-list">
                {agendamentos.map((agendamento) => (
                  <article key={agendamento.id} className="schedule-item">
                    <div className="schedule-item-top">
                      <div>
                        <div className="schedule-title">{agendamento.aviso?.titulo || '(sem título)'}</div>
                        <div className="schedule-meta">
                          {formatRecurrenceLabel(agendamento)} · {describeScheduleTarget(agendamento, computadores)}
                        </div>
                      </div>
                      <span className={`schedule-badge ${agendamento.ativo ? 'active' : 'inactive'}`}>
                        {formatScheduleStatus(agendamento)}
                      </span>
                    </div>

                    <div className="schedule-info">
                      <span>Próxima execução: {formatZoneDateTime(agendamento.proximaExecucao || agendamento.agendadoPara)}</span>
                      <span>Nível: {mapNivelToLabel(agendamento.aviso?.nivel || 'info')}</span>
                    </div>

                    <div className="schedule-actions">
                      <button type="button" className="btn-tool" onClick={() => loadScheduleRecord(agendamento)} disabled={saving}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="btn-tool danger"
                        onClick={() => setPendingDeleteSchedule(agendamento)}
                        disabled={saving}
                      >
                        Cancelar
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Histórico</h2>
            <div className="history-toolbar">
              <input
                type="search"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Buscar por título, hostname ou usuário"
              />
              <select value={historyStatusFilter} onChange={(e) => setHistoryStatusFilter(e.target.value)}>
                <option value="all">Todos</option>
                <option value="PENDENTE">Pendente</option>
                <option value="ENVIADO">Enviado</option>
                <option value="EXIBIDO">Exibido</option>
                <option value="CONFIRMADO">Confirmado</option>
                <option value="EXPIRADO">Expirado</option>
                <option value="FALHOU">Falhou</option>
              </select>
              <select value={historyLevelFilter} onChange={(e) => setHistoryLevelFilter(e.target.value)}>
                <option value="all">Todos</option>
                <option value="info">Informativo</option>
                <option value="aviso">Atenção</option>
                <option value="urgente">Crítico</option>
              </select>
              <select value={historyPeriodFilter} onChange={(e) => setHistoryPeriodFilter(e.target.value)}>
                <option value="all">Todos</option>
                <option value="today">Hoje</option>
                <option value="7d">Últimos 7 dias</option>
                <option value="30d">Últimos 30 dias</option>
              </select>
            </div>

            <div className="history-summary-row">
              <span>{filteredHistory.length} registros encontrados</span>
              <span>{historyTotals.entregas} entregas</span>
            </div>

            {filteredHistory.length === 0 ? (
              <p className="empty">Nenhum aviso corresponde aos filtros.</p>
            ) : (
              <div className="avisos-history">
                {filteredHistory.map((item) => (
                  <details key={item.id} className="aviso-history-item">
                    <summary className="aviso-history-summary">
                      <div className="aviso-history-main">
                        <div className="aviso-history-title">{item.titulo}</div>
                        <div className="aviso-history-meta">
                          {mapNivelToLabel(item.nivel)} · {fmtServerDate(item.criadoEm)}
                        </div>
                      </div>
                      <div className="aviso-history-side">
                        <span className={`ah-badge ${item.primaryStatus === 'CONFIRMADO' ? 'resolvido' : ''}`}>
                          {mapEstadoToLabel(item.primaryStatus)}
                        </span>
                        <span className="aviso-history-small">
                          {item.quantidadeMaquinas} máquina(s) · {historyStatusSummary(item.counts)}
                        </span>
                      </div>
                    </summary>

                    <div className="aviso-history-info compact">
                      <span>{item.destinoLabel}</span>
                      <span>aviso #{item.avisoId || '-'}</span>
                      <span>ocorrência #{item.ocorrenciaId || '-'}</span>
                    </div>

                    <div className="history-deliveries">
                      {item.deliveries.map((delivery) => (
                        <div key={delivery.id} className="history-delivery-row">
                          <div className="history-delivery-main">
                            <strong>{delivery.computador?.hostname || 'Computador'}</strong>
                            <span>{delivery.computador?.usuario || '—'}</span>
                          </div>
                          <div className="history-delivery-status">
                            <span className={`delivery-state ${String(delivery.estado || '').toLowerCase()}`}>
                              {mapEstadoToLabel(delivery.estado)}
                            </span>
                            <span>Enviado: {formatNullableDateTime(delivery.enviadoEm)}</span>
                            <span>Exibido: {formatNullableDateTime(delivery.exibidoEm)}</span>
                            <span>Confirmado: {formatNullableDateTime(delivery.confirmadoEm)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {pendingDeleteSchedule && (
        <div className="confirm-box confirm-floating">
          <p>
            Este agendamento será cancelado. Deseja continuar?
          </p>
          <div className="confirm-actions">
            <button type="button" className="btn-cancel" onClick={() => setPendingDeleteSchedule(null)}>
              Cancelar
            </button>
            <button type="button" className="btn-update" onClick={confirmDeleteSchedule} disabled={saving}>
              Confirmar cancelamento
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
