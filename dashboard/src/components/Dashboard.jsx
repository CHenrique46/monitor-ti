import { useState, useEffect, useMemo } from 'react'
import SummaryCards from './SummaryCards'
import SearchBar from './SearchBar'
import ComputerCard from './ComputerCard'
import { computeAlerts, sortComputadores } from '../utils/alerts'
import { fmtDate } from '../utils/formatters'
import { API_URL } from '../config'

export default function Dashboard() {
  const [serverOk, setServerOk] = useState(true)
  const [computadores, setComputadores] = useState([])
  const [search, setSearch] = useState('')
  const [alertasAtivos, setAlertasAtivos] = useState([])
  const [latestVersion, setLatestVersion] = useState(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const h = await fetch(`${API_URL}/health`)
        if (!active) return
        setServerOk(h.ok)
      } catch (e) {
        if (active) setServerOk(false)
      }

      try {
        const r = await fetch(`${API_URL}/api/computadores`)
        if (!active) return
        if (r.ok) {
          setComputadores(await r.json())
        }
      } catch (e) {}
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
        const r = await fetch(`${API_URL}/api/agent/releases/latest`)
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
        const r = await fetch(`${API_URL}/api/alertas?ativos=true`)
        if (!active) return
        if (r.ok) setAlertasAtivos(await r.json())
      } catch (e) {}
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
    const list = term
      ? computadores.filter(
          (c) =>
            (c.hostname || '').toLowerCase().includes(term) ||
            (c.usuario || '').toLowerCase().includes(term) ||
            (c.ip || '').toLowerCase().includes(term)
        )
      : computadores
    return sortComputadores(list)
  }, [computadores, search])

  const summary = useMemo(() => {
    const total = computadores.length
    const online = computadores.filter((c) => c.status === 'online').length
    const offline = computadores.filter((c) => c.status === 'offline').length
    const alerts = computadores.filter((c) => computeAlerts(c).hasAlert).length
    return { total, online, offline, alerts }
  }, [computadores])

  return (
    <div className="container">
      <h1>Monitor TI</h1>
      <p>
        Servidor:{' '}
        <span className={serverOk ? 'online' : 'offline'}>
          {serverOk ? 'Online' : 'Offline'}
        </span>
      </p>
      {!serverOk && (
        <p className="server-warn">Não foi possível atualizar os dados.</p>
      )}

      <SummaryCards summary={summary} />

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

      <SearchBar value={search} onChange={setSearch} />

      <h2>Computadores</h2>
      <hr />

      {computadores.length === 0 ? (
        <p className="empty">
          Nenhum computador cadastrado.
          <br />
          Instale ou execute o Monitor TI Agent em uma máquina para ela aparecer
          aqui.
        </p>
      ) : filtered.length === 0 ? (
        <p className="muted">Nenhum computador corresponde à busca.</p>
      ) : (
        <div className="grid">
          {filtered.map((c) => (
            <ComputerCard key={c.id} c={c} latestVersion={latestVersion} />
          ))}
        </div>
      )}
    </div>
  )
}
