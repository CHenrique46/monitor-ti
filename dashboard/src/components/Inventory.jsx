import { useEffect, useMemo, useState } from 'react'
import SiteNav from './SiteNav'
import { API_URL } from '../config'
import { apiFetch } from '../api'
import { computeAlerts } from '../utils/alerts'
import { bytesToGB } from '../format'
import { useAuth } from '../auth/AuthContext'
import { hostnameEquipmentSuggestion } from '../utils/inventorySuggestion'

const columns = [
  ['equipment', 'Nº Equipamento'], ['responsible', 'Responsável'], ['hostname', 'Hostname'],
  ['ip', 'IP'], ['cpu', 'Processador'], ['ram', 'RAM'], ['storage', 'Armazenamento'],
  ['free', 'Espaço Livre'], ['windows', 'Windows'], ['office', 'Office'], ['officeKey', 'Office Last5']
]

function privateIp(value) {
  const ip = String(value || '')
  const parts = ip.split('.').map(Number)
  const valid = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  return valid && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)) ? ip : null
}

function valueOr(value, fallback = 'Não informado') {
  return value === null || value === undefined || value === '' ? fallback : value
}

function officeLabel(office) {
  if (!office) return 'Não informado'
  return valueOr(office.productName || office.edition, 'Não identificado')
}

function compareValues(a, b, key) {
  if (key === 'equipment') {
    const an = a.equipamentoNumero == null ? Number.POSITIVE_INFINITY : Number(a.equipamentoNumero)
    const bn = b.equipamentoNumero == null ? Number.POSITIVE_INFINITY : Number(b.equipamentoNumero)
    return an - bn
  }
  const values = {
    responsible: [a.responsavel, b.responsavel], hostname: [a.hostname, b.hostname], ip: [privateIp(a.ip), privateIp(b.ip)],
    cpu: [a.processador, b.processador], ram: [a.ramTotal, b.ramTotal], storage: [a.discoTotal, b.discoTotal],
    free: [a.discoLivre, b.discoLivre], windows: [a.windows, b.windows], office: [officeLabel(a.office), officeLabel(b.office)],
    officeKey: [a.office?.partialProductKey, b.office?.partialProductKey]
  }[key] || ['', '']
  if (typeof values[0] === 'number' || typeof values[1] === 'number') return (values[0] ?? -1) - (values[1] ?? -1)
  return String(values[0] || '').localeCompare(String(values[1] || ''), 'pt-BR', { sensitivity: 'base', numeric: true })
}

function InventoryRow({ computer, isAdmin, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [form, setForm] = useState({ equipamentoNumero: computer.equipamentoNumero || '', usuario: computer.responsavel || '' })
  const ip = privateIp(computer.ip)
  const diskAlert = computeAlerts(computer).alerts.some((alert) => alert.type === 'disk')
  const suggestion = !computer.equipamentoNumero ? hostnameEquipmentSuggestion(computer.hostname) : null
  const updateForm = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const save = async (event) => {
    event.preventDefault()
    if (computer.equipamentoNumero && !form.equipamentoNumero.trim() && !window.confirm('Limpar o número deste equipamento?')) return
    setSaving(true)
    setError(null)
    try {
      const response = await apiFetch(`${API_URL}/api/computadores/${computer.id}/inventory-metadata`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ equipamentoNumero: form.equipamentoNumero, usuario: form.usuario }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.erro || 'Não foi possível atualizar o inventário.')
      onSaved(computer.id, { equipamentoNumero: body.equipamentoNumero || null, responsavel: body.apelido || null })
      setSaved(true)
      setEditing(false)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }
  if (editing) return <tr className="inventory-edit-row"><td colSpan={columns.length}><form onSubmit={save} className="inventory-edit-form"><label>Nº Equipamento<input value={form.equipamentoNumero} maxLength={64} onChange={(event) => updateForm('equipamentoNumero', event.target.value)} autoFocus /></label><label>Responsável<input value={form.usuario} maxLength={120} onChange={(event) => updateForm('usuario', event.target.value)} /></label>{suggestion && <span className="inventory-suggestion">Sugestão pelo hostname: <strong>{suggestion}</strong><button type="button" onClick={() => updateForm('equipamentoNumero', suggestion)}>Usar {suggestion}</button></span>}<div className="inventory-edit-actions"><button type="button" className="btn-cancel" onClick={() => { setEditing(false); setError(null) }} disabled={saving}>Cancelar</button><button type="submit" className="btn-update" disabled={saving}>{saving ? 'Salvando...' : 'Salvar'}</button></div>{error && <span className="update-status failed">{error}</span>}</form></td></tr>
  return <tr>
    <td>{valueOr(computer.equipamentoNumero)}{isAdmin && <button type="button" className="inventory-edit-link" onClick={() => { setSaved(false); setForm({ equipamentoNumero: computer.equipamentoNumero || '', usuario: computer.responsavel || '' }); setEditing(true) }}>Editar</button>}{saved && <span className="inventory-saved">Inventário atualizado.</span>}</td>
    <td>{valueOr(computer.responsavel)}</td>
    <td>{valueOr(computer.hostname)}</td>
    <td>{ip || 'IP LAN não identificado'}</td>
    <td className="inventory-cpu" title={valueOr(computer.processador)}>{valueOr(computer.processador)}</td>
    <td>{bytesToGB(computer.ramTotal, 0)}</td>
    <td>{bytesToGB(computer.discoTotal, 0)}</td>
    <td className={diskAlert ? 'inventory-disk-warning' : ''}>{computer.discoLivre == null ? 'Não informado' : `${bytesToGB(computer.discoLivre, 0)} livre`}</td>
    <td>{valueOr(computer.windows)}</td>
    <td>{officeLabel(computer.office)}</td>
    <td>{valueOr(computer.office?.partialProductKey, 'Não identificado')}</td>
  </tr>
}

export default function Inventory() {
  const { user } = useAuth()
  const isAdmin = user.role === 'ADMIN'
  const [computers, setComputers] = useState([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('equipment')
  const [direction, setDirection] = useState(1)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    apiFetch(`${API_URL}/api/inventario`).then(async (response) => {
      if (!active) return
      if (!response.ok) throw new Error('inventory')
      setComputers(await response.json())
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [])

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    return computers.filter((computer) => {
      const matchesSearch = !term || [computer.equipamentoNumero, computer.responsavel, computer.hostname, privateIp(computer.ip)].some((value) => String(value || '').toLowerCase().includes(term))
      const matchesFilter = filter === 'all' || (filter === 'equipment' && !computer.equipamentoNumero) || (filter === 'responsible' && !computer.responsavel) || (filter === 'disk' && computeAlerts(computer).alerts.some((alert) => alert.type === 'disk'))
      return matchesSearch && matchesFilter
    }).sort((a, b) => direction * compareValues(a, b, sort))
  }, [computers, search, filter, sort, direction])

  const changeSort = (key) => {
    if (sort === key) setDirection((current) => current * -1)
    else { setSort(key); setDirection(1) }
  }

  const updateComputer = (id, changes) => setComputers((current) => current.map((computer) => computer.id === id ? { ...computer, ...changes } : computer))

  return <main className="container inventory-page">
    <SiteNav />
    <div className="inventory-heading"><div><p className="eyebrow">Consulta operacional</p><h1>Inventário</h1><p className="muted">Dados técnicos atuais do HenriTech Control. Campos administrativos ausentes não bloqueiam a consulta.</p></div><strong className="inventory-count">{visible.length} de {computers.length}</strong></div>
    <div className="inventory-toolbar">
      <label className="inventory-search"><span className="sr-only">Buscar no inventário</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar equipamento, responsável, hostname ou IP" /></label>
      <label className="toolbar-field"><span>Filtro</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Todos</option><option value="equipment">Sem Nº Equipamento</option><option value="responsible">Sem Responsável</option><option value="disk">Pouco espaço</option></select></label>
    </div>
    {error && <p className="server-warn">Não foi possível carregar o inventário.</p>}
    {!error && <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr>{columns.map(([key, label]) => <th key={key} scope="col"><button type="button" onClick={() => changeSort(key)}>{label}{sort === key && <span aria-hidden="true"> {direction === 1 ? '↑' : '↓'}</span>}</button></th>)}</tr></thead><tbody>{visible.map((computer) => <InventoryRow key={computer.id} computer={computer} isAdmin={isAdmin} onSaved={updateComputer} />)}</tbody></table>{computers.length > 0 && visible.length === 0 && <p className="muted inventory-empty">Nenhum computador corresponde aos critérios.</p>}{computers.length === 0 && <p className="muted inventory-empty">Carregando inventário...</p>}</div>}
  </main>
}
