import { useEffect, useState } from 'react'
import SiteNav from './SiteNav'
import { API_URL } from '../config'
import { apiFetch } from '../api'

const weekdays = [
  'Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira',
  'Quinta-feira', 'Sexta-feira', 'Sábado'
]

const emptyForm = {
  name: 'Manutenção preventiva semanal',
  dayOfWeek: 4,
  time: '20:00',
  timezone: 'America/Sao_Paulo',
  targetMode: 'ALL',
  enabled: false,
  computerIds: []
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('pt-BR')
}

export default function MaintenanceSchedules() {
  const [schedules, setSchedules] = useState([])
  const [computers, setComputers] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null)
  const [plan, setPlan] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const [scheduleResponse, computerResponse] = await Promise.all([
        apiFetch(`${API_URL}/api/maintenance-schedules`),
        apiFetch(`${API_URL}/api/computadores`)
      ])
      if (!scheduleResponse.ok || !computerResponse.ok) throw new Error('Não foi possível carregar os agendamentos.')
      const nextSchedules = await scheduleResponse.json()
      setSchedules(nextSchedules)
      setComputers(await computerResponse.json())
      if (!editingId && nextSchedules[0]) {
        const current = nextSchedules[0]
        setEditingId(current.id)
        setForm({ ...emptyForm, ...current, computerIds: current.computerIds || [] })
      }
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  const updateField = (field, value) => setForm((current) => ({ ...current, [field]: value }))

  const save = async (event) => {
    event.preventDefault()
    setNotice('')
    setError('')
    try {
      const response = await apiFetch(`${API_URL}/api/maintenance-schedules${editingId ? `/${editingId}` : ''}`, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, dayOfWeek: Number(form.dayOfWeek), computerIds: form.computerIds.map(Number) })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.erro || 'Não foi possível salvar o agendamento.')
      setEditingId(body.id)
      setForm({ ...emptyForm, ...body, computerIds: body.computerIds || [] })
      setNotice('Agendamento salvo. A execução automática continua desabilitada por segurança.')
      await load()
    } catch (e) { setError(e.message) }
  }

  const runDryRun = async () => {
    if (!editingId) return
    setNotice('')
    setError('')
    try {
      const response = await apiFetch(`${API_URL}/api/maintenance-schedules/${editingId}/dry-run`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.erro || 'Dry Run indisponível.')
      setPlan(body)
    } catch (e) { setError(e.message) }
  }

  const toggleComputer = (id) => setForm((current) => ({
    ...current,
    computerIds: current.computerIds.includes(id)
      ? current.computerIds.filter((item) => item !== id)
      : [...current.computerIds, id]
  }))

  return (
    <div className="container">
      <SiteNav />
      <div className="page-heading">
        <div>
          <p className="eyebrow">Operação segura</p>
          <h1>Manutenção programada</h1>
          <p className="muted">Planeje ciclos preventivos sem disparar manutenção automática nesta fase.</p>
        </div>
        <span className="safe-badge">DRY RUN padrão</span>
      </div>

      {notice && <p className="success-notice">{notice}</p>}
      {error && <p className="server-warn">{error}</p>}

      <div className="schedule-layout">
        <form className="card schedule-form" onSubmit={save}>
          <div className="section-kicker">Política</div>
          <label>Nome<input value={form.name} onChange={(e) => updateField('name', e.target.value)} maxLength={120} /></label>
          <div className="form-row">
            <label>Dia<select value={form.dayOfWeek} onChange={(e) => updateField('dayOfWeek', e.target.value)}>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
            <label>Horário<input type="time" value={form.time} onChange={(e) => updateField('time', e.target.value)} /></label>
          </div>
          <label>Timezone<input value={form.timezone} onChange={(e) => updateField('timezone', e.target.value)} /></label>
          <label>Alvo<select value={form.targetMode} onChange={(e) => updateField('targetMode', e.target.value)}><option value="ALL">Todos os computadores</option><option value="SELECTED">Computadores selecionados</option></select></label>
          {form.targetMode === 'SELECTED' && <div className="computer-picker">{computers.map((computer) => <label className="check-row" key={computer.id}><input type="checkbox" checked={form.computerIds.includes(computer.id)} onChange={() => toggleComputer(computer.id)} />{computer.hostname || `Computador ${computer.id}`} <span className={computer.status === 'online' ? 'online' : 'offline'}>{computer.status}</span></label>)}</div>}
          <label className="check-row schedule-enabled"><input type="checkbox" checked={form.enabled} onChange={(e) => updateField('enabled', e.target.checked)} /> Habilitar política <small>Não habilite sem validação operacional.</small></label>
          <div className="button-row"><button className="primary-button" type="submit">Salvar política</button><button type="button" onClick={runDryRun} disabled={!editingId}>Dry Run</button></div>
        </form>

        <section className="card schedule-summary">
          <div className="section-kicker">Próximo ciclo</div>
          {editingId ? <><h2>{weekdays[Number(form.dayOfWeek)]}, {form.time}</h2><p className="muted">{form.timezone}</p><dl className="fact-list"><div><dt>Alvo</dt><dd>{form.targetMode === 'ALL' ? 'Todos' : `${form.computerIds.length} selecionado(s)`}</dd></div><div><dt>Próxima execução</dt><dd>{formatDate(schedules.find((item) => item.id === editingId)?.nextExecution)}</dd></div><div><dt>Último ciclo</dt><dd>{schedules.find((item) => item.id === editingId)?.lastRun ? `${schedules.find((item) => item.id === editingId).lastRun.status} em ${formatDate(schedules.find((item) => item.id === editingId).lastRun.scheduledFor)}` : 'Nenhum ciclo'}</dd></div></dl></> : <p className="muted">Carregando política padrão...</p>}
          {plan && <div className="dry-run-result"><strong>Dry Run</strong><p>{plan.eligibleCount} elegível(is) de {plan.targetCount}; {plan.offlineCount} offline, {plan.inProgressCount} em andamento.</p>{plan.machines.map((machine) => <div className="plan-row" key={machine.id}><span>{machine.hostname}</span><span className={machine.eligible ? 'online' : 'muted'}>{machine.eligible ? 'elegível' : machine.reason}</span></div>)}</div>}
        </section>
      </div>
    </div>
  )
}
