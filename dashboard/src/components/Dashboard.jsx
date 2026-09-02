import { useState, useEffect, useMemo } from 'react'
import SummaryCards from './SummaryCards'
import SearchBar from './SearchBar'
import ComputerCard from './ComputerCard'
import SiteNav from './SiteNav'
import { sortComputadores } from '../utils/alerts'
import { fmtDate } from '../utils/formatters'
import { API_URL } from '../config'
import ComputerDetails from './ComputerDetails'
import DeleteComputerDialog from './DeleteComputerDialog'
import { computerMatchesFilter, sortComputadoresByPriority } from '../utils/computerAttention'
import { buildOperationalSummary } from '../utils/operationalSummary.js'
import { apiFetch } from '../api'

export default function Dashboard() {
  const [serverOk, setServerOk] = useState(true)
  const [computadores, setComputadores] = useState([])
  const [search, setSearch] = useState('')
  const [alertasAtivos, setAlertasAtivos] = useState([])
  const [latestVersion, setLatestVersion] = useState(null)
  const [selectedComputerId, setSelectedComputerId] = useState(null)
  const [computerFilter, setComputerFilter] = useState('all')
  const [sortMode, setSortMode] = useState('default')
  const [computersLoaded, setComputersLoaded] = useState(false)
  const [alertsLoaded, setAlertsLoaded] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const h = await apiFetch(`${API_URL}/health`)
        if (!active) return
        setServerOk(h.ok)
      } catch (e) {
        if (active) setServerOk(false)
      }

      try {
        const r = await apiFetch(`${API_URL}/api/computadores`)
        if (!active) return
        if (r.ok) {
          setComputadores(await r.json())
          setComputersLoaded(true)
        }
      } catch (e) {
        if (active) setComputersLoaded(true)
      }
    }

    load()
    const id = setInterval(load, 5000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    let active = true
    const loadLatest = async () => {
      try {
        const r = await apiFetch(`${API_URL}/api/agent/releases/latest`)
        if (!active) return
        if (r.ok) setLatestVersion((await r.json()).version)
        else setLatestVersion(null)
      } catch (e) {
        if (active) setLatestVersion(null)
      }
    }
    loadLatest()
    const id = setInterval(loadLatest, 30000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    let active = true
    const loadAlertas = async () => {
      try {
        const r = await apiFetch(`${API_URL}/api/alertas?ativos=true`)
        if (!active) return
        if (r.ok) setAlertasAtivos(await r.json())
        setAlertsLoaded(true)
      } catch (e) {
        if (active) setAlertsLoaded(true)
      }
    }
    loadAlertas()
    const id = setInterval(loadAlertas, 10000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    let list = term
      ? computadores.filter(
          (c) =>
            (c.hostname || '').toLowerCase().includes(term) ||
            (c.apelido || '').toLowerCase().includes(term) ||
            (c.equipamentoNumero || '').toLowerCase().includes(term) ||
            (c.usuario || '').toLowerCase().includes(term) ||
            (c.ip || '').toLowerCase().includes(term)
        )
      : computadores
    list = list.filter((computer) => computerMatchesFilter(computer, computerFilter, alertasAtivos))
    return sortMode === 'priority'
      ? sortComputadoresByPriority(list, alertasAtivos)
      : sortComputadores(list)
  }, [computadores, search, computerFilter, sortMode, alertasAtivos])

  const summary = useMemo(() => {
    return buildOperationalSummary(computadores, alertasAtivos)
  }, [computadores, alertasAtivos])

  const summaryLoading = !computersLoaded || !alertsLoaded

  const requestComputerDeletion = async () => {
    if (!deleteTarget || deleteTarget.status === 'online') return
    setDeleting(true)
    setDeleteError(null)
    try {
      const response = await apiFetch(`${API_URL}/api/computadores/${deleteTarget.id}`, { method: 'DELETE' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setDeleteError(body.erro || 'Não foi possível excluir o computador.')
        return
      }
      setComputadores((current) => current.filter((computer) => computer.id !== deleteTarget.id))
      if (selectedComputerId === deleteTarget.id) setSelectedComputerId(null)
      setDeleteTarget(null)
    } catch {
      setDeleteError('Não foi possível excluir o computador.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="container">
      <SiteNav />
       <h1>Visão geral do ambiente</h1>
      <p>
        Servidor:{' '}
        <span className={serverOk ? 'online' : 'offline'}>
          {serverOk ? 'Online' : 'Offline'}
        </span>
      </p>
      {!serverOk && (
        <p className="server-warn">Não foi possível atualizar os dados.</p>
      )}

       <SummaryCards
         summary={summary}
         loading={summaryLoading}
         activeFilter={computerFilter}
         onFilterChange={setComputerFilter}
       />

      {alertasAtivos.length > 0 && (
        <div className="alertas-ativos">
          <h2>Alertas ativos</h2>
          {alertasAtivos.map((a) => (
            <div key={a.id} className={`alert ${a.nivel}`}>
              <strong>
                {a.computador?.hostname || a.computador?.usuario || "Computador"}
              </strong>{" "}
              — {a.mensagem}
              <span className="alert-since"> desde {fmtDate(a.iniciadoEm)}</span>
            </div>
          ))}
        </div>
      )}

       <div className="computer-toolbar">
         <SearchBar value={search} onChange={setSearch} />
         <label className="toolbar-field">
           <span>Mostrar</span>
           <select value={computerFilter} onChange={(event) => setComputerFilter(event.target.value)}>
             <option value="all">Todos</option>
             <option value="online">Online</option>
             <option value="offline">Offline</option>
             <option value="attention">Requer atenção{summaryLoading ? '' : ` (${summary.attention})`}</option>
             <option value="reboot">Reinício recomendado</option>
             <option value="critical">Críticos</option>
             <option value="normal">Normais</option>
           </select>
         </label>
         <label className="toolbar-field">
           <span>Ordenar</span>
           <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
             <option value="default">Padrão</option>
             <option value="priority">Prioridade</option>
           </select>
         </label>
       </div>

      <h2>Computadores</h2>
      <hr />

      {computadores.length === 0 ? (
        <p className="empty">
          Nenhum computador cadastrado.
          <br />
           Instale ou execute o Agent do HenriTech Control em uma máquina para ela aparecer
          aqui.
        </p>
      ) : filtered.length === 0 ? (
        <p className="muted">Nenhum computador corresponde à busca.</p>
      ) : (
        <div className="grid">
             {filtered.map((c) => (
              <ComputerCard key={c.id} c={c} latestVersion={latestVersion} onOpen={setSelectedComputerId} onDelete={(computer) => { setDeleteError(null); setDeleteTarget(computer) }} hasActiveAlert={alertasAtivos.some((alert) => alert.computadorId === c.id)} />
            ))}
         </div>
       )}
      {selectedComputerId && (
        <ComputerDetails computerId={selectedComputerId} latestVersion={latestVersion} onClose={() => setSelectedComputerId(null)} />
      )}
      {deleteTarget && <DeleteComputerDialog computer={deleteTarget} error={deleteError} submitting={deleting} onCancel={() => { if (!deleting) setDeleteTarget(null) }} onConfirm={requestComputerDeletion} />}
    </div>
  )
}
