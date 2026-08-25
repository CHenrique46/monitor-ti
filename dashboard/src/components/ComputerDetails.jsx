import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { computeAlerts } from '../utils/alerts'
import {
  bytesToGB,
  formatUptime,
  formatPercent,
  sistemaLabel,
  fmtDate
} from '../utils/formatters'
import { API_URL } from '../config'

function MetricBar({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0))
  const cls = pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''
  return (
    <div className="bar">
      <div className={`bar-fill ${cls}`} style={{ width: pct + '%' }}></div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="detail-section">
      <h3>{title}</h3>
      <div className="detail-grid">{children}</div>
    </div>
  )
}

export default function ComputerDetails() {
  const { id } = useParams()
  const [serverOk, setServerOk] = useState(true)
  const [c, setC] = useState(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const r = await fetch(`${API_URL}/api/computadores/${id}`)
        if (!active) return
        if (r.status === 404) {
          setNotFound(true)
          setServerOk(true)
          return
        }
        if (!r.ok) {
          setServerOk(false)
          return
        }
        setNotFound(false)
        setServerOk(true)
        setC(await r.json())
      } catch (e) {
        if (active) setServerOk(false) // mantem ultimo estado em memoria
      }
    }

    load()
    const interval = setInterval(load, 5000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [id])

  if (notFound) {
    return (
      <div className="container">
        <Link className="back-link" to="/">
          ← Voltar ao Dashboard
        </Link>
        <div className="empty">
          Computador não encontrado.
          <br />
          <Link className="details-link" to="/">
            Voltar ao Dashboard
          </Link>
        </div>
      </div>
    )
  }

  const online = c && c.status === 'online'
  const { alerts } = c ? computeAlerts(c) : { alerts: [] }
  const ramPct =
    c && c.ramTotal && c.ramUsada != null
      ? Math.round((c.ramUsada / c.ramTotal) * 100)
      : null
  const discoPct =
    c && c.discoTotal && c.discoLivre != null
      ? Math.round(((c.discoTotal - c.discoLivre) / c.discoTotal) * 100)
      : null

  const hasCritical = alerts.some((a) => a.severity === 'critical')
  const hasWarn = alerts.some((a) => a.severity === 'warn')
  const cardClass = !c
    ? ''
    : !online
    ? 'offline-card'
    : hasCritical
    ? 'critical-card'
    : hasWarn
    ? 'warn-card'
    : 'online-card'

  return (
    <div className="container">
      <Link className="back-link" to="/">
        ← Voltar ao Dashboard
      </Link>

      <h1>{c ? c.hostname || '(sem nome)' : 'Carregando...'}</h1>
      <p>
        Servidor:{' '}
        <span className={serverOk ? 'online' : 'offline'}>
          {serverOk ? 'Online' : 'Offline'}
        </span>
        {c && (
          <>
            {' | '}Status:{' '}
            <span className={online ? 'online' : 'offline'}>
              {online ? 'Online' : 'Offline'}
            </span>
          </>
        )}
      </p>
      {!serverOk && (
        <p className="server-warn">Não foi possível atualizar os dados.</p>
      )}

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${a.severity}`}>
              ⚠ {a.msg}
            </div>
          ))}
        </div>
      )}

      {!c && <p className="muted">Carregando dados do computador...</p>}

      {c && (
        <>
          <Section title="Informações gerais">
            <div>
              <span className="detail-key">Usuário</span>
              <span className="detail-val">{c.usuario || '-'}</span>
            </div>
            <div>
              <span className="detail-key">IP</span>
              <span className="detail-val">{c.ip || '-'}</span>
            </div>
            <div>
              <span className="detail-key">Device ID</span>
              <span className="detail-val">{c.deviceId || '-'}</span>
            </div>
            <div>
              <span className="detail-key">Última conexão</span>
              <span className="detail-val">{fmtDate(c.ultimaConexao)}</span>
            </div>
          </Section>

          <Section title="Sistema">
            <div>
              <span className="detail-key">Sistema</span>
              <span className="detail-val">{sistemaLabel(c.sistema)}</span>
            </div>
            <div>
              <span className="detail-key">Release</span>
              <span className="detail-val">{c.sistemaRelease || '-'}</span>
            </div>
            <div>
              <span className="detail-key">Arquitetura</span>
              <span className="detail-val">{c.arquitetura || '-'}</span>
            </div>
            <div>
              <span className="detail-key">Uptime</span>
              <span className="detail-val">{formatUptime(c.uptime)}</span>
            </div>
          </Section>

          <Section title="Processador">
            <div>
              <span className="detail-key">Modelo</span>
              <span className="detail-val">{c.processador || '-'}</span>
            </div>
            <div>
              <span className="detail-key">CPUs lógicas</span>
              <span className="detail-val">
                {c.cpusLogicas != null ? c.cpusLogicas : '-'}
              </span>
            </div>
          </Section>

          <Section title="Memória">
            <div>
              <span className="detail-key">Usada</span>
              <span className="detail-val">{bytesToGB(c.ramUsada)}</span>
            </div>
            <div>
              <span className="detail-key">Total</span>
              <span className="detail-val">{bytesToGB(c.ramTotal)}</span>
            </div>
            <div className="metric-value-full">
              {formatPercent(ramPct)}
              <MetricBar value={ramPct || 0} />
            </div>
          </Section>

          <Section title="Disco C:">
            <div>
              <span className="detail-key">Livre</span>
              <span className="detail-val">{bytesToGB(c.discoLivre)}</span>
            </div>
            <div>
              <span className="detail-key">Total</span>
              <span className="detail-val">{bytesToGB(c.discoTotal)}</span>
            </div>
            <div className="metric-value-full">
              {formatPercent(discoPct)} usado
              <MetricBar value={discoPct || 0} />
            </div>
          </Section>

          <Section title="CPU">
            <div className="metric-value-full">
              {formatPercent(c.cpuUso)}
              <MetricBar value={c.cpuUso || 0} />
            </div>
          </Section>

          {!online && (
            <p className="offline-info">
              Últimos dados conhecidos. Última conexão: {fmtDate(c.ultimaConexao)}
            </p>
          )}
        </>
      )}
    </div>
  )
}
