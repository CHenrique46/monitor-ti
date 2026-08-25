import { useState, useEffect, useMemo } from 'react'
import SummaryCards from './SummaryCards'
import SearchBar from './SearchBar'
import ComputerCard from './ComputerCard'
import { computeAlerts, sortComputadores } from '../utils/alerts'
import { API_URL } from '../config'

export default function Dashboard() {
  const [serverOk, setServerOk] = useState(true)
  const [computadores, setComputadores] = useState([])
  const [search, setSearch] = useState('')

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
            <ComputerCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}
