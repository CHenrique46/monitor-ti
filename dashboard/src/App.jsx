import { useState, useEffect } from 'react'
import { bytesToGB, formatUptime, formatPercent } from './format'

const API = 'http://127.0.0.1:4000'

function sistemaLabel(s) {
  if (s === 'win32' || s === 'Windows_NT') return 'Windows'
  if (s === 'darwin') return 'macOS'
  if (s === 'linux') return 'Linux'
  return s || '-'
}

function fmtDate(d) {
  if (!d) return '-'
  return new Date(d).toLocaleString('pt-BR')
}

function MetricBar({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0))
  return (
    <div className="bar">
      <div className="bar-fill" style={{ width: pct + '%' }}></div>
    </div>
  )
}

function App() {
  const [serverOk, setServerOk] = useState(false)
  const [computadores, setComputadores] = useState([])

  useEffect(() => {
    const load = async () => {
      try {
        const h = await fetch(`${API}/health`)
        setServerOk(h.ok)
      } catch (e) {
        setServerOk(false)
      }

      try {
        const r = await fetch(`${API}/api/computadores`)
        if (r.ok) {
          setComputadores(await r.json())
        }
      } catch (e) {
        // mantem lista anterior em caso de falha transitória
      }
    }

    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="container">
      <h1>Monitor TI</h1>
      <p>
        Servidor:{' '}
        <span className={serverOk ? 'online' : 'offline'}>
          {serverOk ? 'Online' : 'Offline'}
        </span>
      </p>

      <h2>Computadores</h2>
      <hr />

      {computadores.length === 0 && (
        <p className="muted">Nenhum computador conectado.</p>
      )}

      {computadores.map((c) => {
        const online = c.status === 'online'
        const ramPct =
          c.ramTotal && c.ramUsada
            ? Math.round((c.ramUsada / c.ramTotal) * 100)
            : null
        const discoPct =
          c.discoTotal && c.discoLivre != null
            ? Math.round(((c.discoTotal - c.discoLivre) / c.discoTotal) * 100)
            : null

        return (
          <div className="card" key={c.id}>
            <div className="hostname">{c.hostname || '(sem nome)'}</div>
            <div className="sub">
              Usuário: {c.usuario || '-'} | IP: {c.ip || '-'} | Sistema:{' '}
              {sistemaLabel(c.sistema)}
            </div>
            <div>
              Status:{' '}
              <span className={online ? 'online' : 'offline'}>
                {online ? 'Online' : 'Offline'}
              </span>
            </div>

            <div className="metric">
              <div className="metric-label">CPU</div>
              <div className="metric-value">{formatPercent(c.cpuUso)}</div>
              <MetricBar value={c.cpuUso || 0} />
            </div>

            <div className="metric">
              <div className="metric-label">RAM</div>
              <div className="metric-value">
                {bytesToGB(c.ramUsada)} / {bytesToGB(c.ramTotal)} (
                {formatPercent(ramPct)})
              </div>
              <MetricBar value={ramPct || 0} />
            </div>

            <div className="metric">
              <div className="metric-label">Disco C:</div>
              <div className="metric-value">
                {bytesToGB(c.discoLivre)} livres de {bytesToGB(c.discoTotal)} (
                {formatPercent(discoPct)} usado)
              </div>
              <MetricBar value={discoPct || 0} />
            </div>

            <div className="metric">
              <div className="metric-label">Ligado há</div>
              <div className="metric-value">{formatUptime(c.uptime)}</div>
            </div>

            {!online && (
              <div className="offline-info">
                Últimos dados conhecidos. Última conexão: {fmtDate(c.ultimaConexao)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default App
