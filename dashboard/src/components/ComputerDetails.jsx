import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import SiteNav from './SiteNav'
import { computeAlerts } from '../utils/alerts'
import {
  bytesToGB,
  formatUptime,
  formatPercent,
  sistemaLabel,
  fmtDate
} from '../utils/formatters'
import { API_URL } from '../config'
import MetricChart from './MetricChart'

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
  const [periodo, setPeriodo] = useState("24h")
  const [metricas, setMetricas] = useState(null)
  const [alertas, setAlertas] = useState([])
  const [release, setRelease] = useState(null)
  const [updateStatus, setUpdateStatus] = useState(null)
  const [confirm, setConfirm] = useState(false)
  const [remoteActions, setRemoteActions] = useState([])
  const [spoolerConfirm, setSpoolerConfirm] = useState(false)
  const [serviceRestartConfirm, setServiceRestartConfirm] = useState(false)
  const [serviceRestartError, setServiceRestartError] = useState(null)

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

  useEffect(() => {
    let active = true
    const loadM = async () => {
      try {
        const r = await fetch(
          `${API_URL}/api/computadores/${id}/metricas?periodo=${periodo}`
        )
        if (active && r.ok) setMetricas(await r.json())
      } catch (e) {}
    }
    loadM()
    const t = setInterval(loadM, 60000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [id, periodo])

  useEffect(() => {
    let active = true
    const loadA = async () => {
      try {
        const r = await fetch(`${API_URL}/api/computadores/${id}/alertas`)
        if (active && r.ok) setAlertas(await r.json())
      } catch (e) {}
    }
    loadA()
    const t = setInterval(loadA, 10000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [id])

  useEffect(() => {
    let active = true
    const loadRelease = async () => {
      try {
        const r = await fetch(`${API_URL}/api/agent/releases/latest`)
        if (active && r.ok) setRelease(await r.json())
        else if (active) setRelease(null)
      } catch (e) {
        if (active) setRelease(null)
      }
    }
    loadRelease()
    const t = setInterval(loadRelease, 30000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [id])

  useEffect(() => {
    if (!release) return
    let active = true
    const loadStatus = async () => {
      try {
        const r = await fetch(`${API_URL}/api/computadores/${id}/agent-update`)
        if (active && r.ok) setUpdateStatus(await r.json())
      } catch (e) {}
    }
    loadStatus()
    const t = setInterval(loadStatus, 3000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [id, release])

  useEffect(() => {
    let active = true
    const loadActions = async () => {
      try {
        const r = await fetch(`${API_URL}/api/computadores/${id}/actions?take=10`)
        if (active && r.ok) setRemoteActions(await r.json())
      } catch (e) {}
    }
    loadActions()
    const t = setInterval(loadActions, 5000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [id])

  const updateAvailable =
    release && c && c.agentVersion && release.version !== c.agentVersion
  const inProgress =
    updateStatus &&
    ["update_pending", "update_downloading", "update_validating", "update_installing"].includes(
      updateStatus.status
    )
  const remoteInProgress = remoteActions.some((a) =>
    ["PENDING", "DISPATCHED", "RUNNING"].includes(a.status)
  )
  const serviceRestartActions = remoteActions.filter(
    (a) => a.action === "service_restart" && a.payload && a.payload.serviceKey === "spooler"
  )
  const serviceRestartInProgress = serviceRestartActions.some((a) =>
    ["PENDING", "DISPATCHED", "RUNNING"].includes(a.status)
  )

  const statusLabel = (s) => {
    switch (s) {
      case "update_pending":
        return "Preparando..."
      case "update_downloading":
        return "Baixando..."
      case "update_validating":
        return "Validando..."
      case "update_installing":
        return "Instalando..."
      case "update_success":
        return "Atualizado ✓"
      case "update_failed":
        return "Falha na atualização"
      default:
        return s || ""
    }
  }

  const actionStatusLabel = (s) => {
    switch (s) {
      case "PENDING":
        return "Pendente"
      case "DISPATCHED":
        return "Enviado"
      case "RUNNING":
        return "Executando"
      case "SUCCESS":
        return "Concluído"
      case "FAILED":
        return "Falhou"
      case "REJECTED":
        return "Rejeitado"
      default:
        return s || ""
    }
  }

  const triggerUpdate = async () => {
    setConfirm(false)
    try {
      const r = await fetch(`${API_URL}/api/computadores/${id}/agent-update`, {
        method: "POST"
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        setUpdateStatus({
          status: "update_failed",
          message: e.erro || "Falha ao iniciar atualização"
        })
      }
    } catch (e) {
      setUpdateStatus({ status: "update_failed", message: e.message })
    }
  }

  const triggerSpoolerReset = async () => {
    setSpoolerConfirm(false)
    try {
      const r = await fetch(`${API_URL}/api/computadores/${id}/actions/spooler-reset`, {
        method: 'POST'
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (body.execution) {
          setRemoteActions((prev) => [body.execution, ...prev.filter((a) => a.actionExecutionId !== body.execution.actionExecutionId)])
        }
        return
      }
      if (body.execution) {
        setRemoteActions((prev) => [body.execution, ...prev.filter((a) => a.actionExecutionId !== body.execution.actionExecutionId)])
      }
    } catch (e) {}
  }

  const triggerServiceRestart = async () => {
    setServiceRestartConfirm(false)
    setServiceRestartError(null)
    try {
      const r = await fetch(`${API_URL}/api/computadores/${id}/actions/service-restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceKey: 'spooler' })
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) {
        setServiceRestartError(body.erro || 'Não foi possível reiniciar o serviço.')
        return
      }
      if (body.execution) {
        setRemoteActions((prev) => [body.execution, ...prev.filter((a) => a.actionExecutionId !== body.execution.actionExecutionId)])
      }
    } catch (e) {
      setServiceRestartError('Não foi possível reiniciar o serviço.')
    }
  }

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
  const val = (x) => (x != null && x !== '' ? x : 'Não informado')
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
      <SiteNav />
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

          <Section title="Agent">
            <div>
              <span className="detail-key">Versão instalada</span>
              <span className="detail-val">v{c.agentVersion || 'desconhecida'}</span>
            </div>
            {release && updateAvailable && (
              <div>
                <span className="detail-key">Versão disponível</span>
                <span className="detail-val">v{release.version}</span>
              </div>
            )}
            {release && !updateAvailable && (
              <div className="update-ok">✓ Agent atualizado (v{release.version})</div>
            )}

            {updateStatus && (
              <div
                className={`update-status ${
                  updateStatus.status === "update_failed"
                    ? "failed"
                    : updateStatus.status === "update_success"
                    ? "ok"
                    : "running"
                }`}
              >
                {statusLabel(updateStatus.status)}
                {updateStatus.message ? ` — ${updateStatus.message}` : ""}
              </div>
            )}

            {release && updateAvailable && online && !inProgress && (
              <button type="button" className="btn-update" onClick={() => setConfirm(true)}>
                Atualizar Agent
              </button>
            )}
            {release && updateAvailable && !online && (
              <div className="muted">Computador offline: não é possível atualizar agora.</div>
            )}

            {confirm && (
              <div className="confirm-box">
                <p>
                  Atualizar o Agent da máquina <strong>{c.hostname}</strong> de v
                  {c.agentVersion} para v{release.version}?
                </p>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={() => setConfirm(false)}
                  >
                    Cancelar
                  </button>
                  <button type="button" className="btn-update" onClick={triggerUpdate}>
                    Atualizar
                  </button>
                </div>
              </div>
            )}
          </Section>

          <Section title="Ações remotas">
            <div>
              <span className="detail-key">Spooler</span>
              <span className="detail-val">Reset da fila de impressão</span>
            </div>
            {remoteActions[0] && (
              <div className={`update-status ${remoteActions[0].status === 'FAILED' || remoteActions[0].status === 'REJECTED' ? 'failed' : remoteActions[0].status === 'SUCCESS' ? 'ok' : 'running'}`}>
                {remoteActions[0].label || 'Reiniciar spooler'}: {actionStatusLabel(remoteActions[0].status)}
                {remoteActions[0].mensagem ? ` — ${remoteActions[0].mensagem}` : ''}
                {remoteActions[0].erro ? ` — ${remoteActions[0].erro}` : ''}
              </div>
            )}

            {online && !remoteInProgress && (
              <button type="button" className="btn-update" onClick={() => setSpoolerConfirm(true)}>
                Reiniciar spooler
              </button>
            )}
            {online && remoteInProgress && (
              <div className="muted">Uma ação remota já está em andamento.</div>
            )}
            {!online && (
              <div className="muted">Computador offline: ação remota indisponível.</div>
            )}

            {spoolerConfirm && (
              <div className="confirm-box">
                <p>
                  Reiniciar o spooler de impressão de <strong>{c.hostname}</strong>?
                </p>
                <div className="confirm-actions">
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={() => setSpoolerConfirm(false)}
                  >
                    Cancelar
                  </button>
                  <button type="button" className="btn-update" onClick={triggerSpoolerReset}>
                    Reiniciar
                  </button>
                </div>
              </div>
            )}

            <div className="alert-history">
              {remoteActions.length === 0 ? (
                <div className="muted">Nenhuma execução registrada.</div>
              ) : (
                remoteActions.map((a) => (
                  <div key={a.actionExecutionId} className={`alert-history-item ${a.status === 'SUCCESS' ? 'resolvido' : a.status === 'FAILED' || a.status === 'REJECTED' ? 'ativo' : ''}`}>
                    <div className="ah-top">
                      <span className="alert info">{a.label || a.action}</span>
                      <span className="ah-badge">{actionStatusLabel(a.status)}</span>
                    </div>
                    <div className="ah-meta">
                      {a.actionExecutionId}
                      {` · ${fmtDate(a.solicitadaEm)}`}
                      {a.concluidaEm ? ` · Concluída: ${fmtDate(a.concluidaEm)}` : ''}
                    </div>
                    {(a.mensagem || a.erro) && (
                      <div className="muted">{a.mensagem || a.erro}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section title="Serviços do Windows">
            <div>
              <span className="detail-key">Serviço</span>
              <span className="detail-val">Spooler de Impressão</span>
            </div>
            {serviceRestartActions[0] && (
              <div className={`update-status ${serviceRestartActions[0].status === 'FAILED' || serviceRestartActions[0].status === 'REJECTED' ? 'failed' : serviceRestartActions[0].status === 'SUCCESS' ? 'ok' : 'running'}`}>
                Reiniciar serviço: {actionStatusLabel(serviceRestartActions[0].status)}
                {serviceRestartActions[0].mensagem ? ` — ${serviceRestartActions[0].mensagem}` : ''}
                {serviceRestartActions[0].erro ? ` — ${serviceRestartActions[0].erro}` : ''}
              </div>
            )}
            {serviceRestartError && <div className="update-status failed">{serviceRestartError}</div>}
            {online && !serviceRestartInProgress && (
              <button type="button" className="btn-update" onClick={() => setServiceRestartConfirm(true)}>
                Reiniciar serviço
              </button>
            )}
            {online && serviceRestartInProgress && (
              <div className="muted">Reinício de serviço em andamento.</div>
            )}
            {!online && (
              <div className="muted">Computador offline: ação remota indisponível.</div>
            )}
            {serviceRestartConfirm && (
              <div className="confirm-box">
                <p>
                  Reiniciar o serviço Spooler de Impressão na máquina <strong>{c.hostname}</strong>?
                </p>
                <div className="confirm-actions">
                  <button type="button" className="btn-cancel" onClick={() => setServiceRestartConfirm(false)}>
                    Cancelar
                  </button>
                  <button type="button" className="btn-update" onClick={triggerServiceRestart}>
                    Reiniciar serviço
                  </button>
                </div>
              </div>
            )}
            <div className="alert-history">
              {serviceRestartActions.length === 0 ? (
                <div className="muted">Nenhuma execução registrada.</div>
              ) : (
                serviceRestartActions.map((a) => (
                  <div key={a.actionExecutionId} className={`alert-history-item ${a.status === 'SUCCESS' ? 'resolvido' : a.status === 'FAILED' || a.status === 'REJECTED' ? 'ativo' : ''}`}>
                    <div className="ah-top">
                      <span className="alert info">Spooler de Impressão</span>
                      <span className="ah-badge">{actionStatusLabel(a.status)}</span>
                    </div>
                    <div className="ah-meta">
                      {a.actionExecutionId} · {fmtDate(a.solicitadaEm)}
                      {a.concluidaEm ? ` · Concluída: ${fmtDate(a.concluidaEm)}` : ''}
                    </div>
                    {(a.mensagem || a.erro) && <div className="muted">{a.mensagem || a.erro}</div>}
                  </div>
                ))
              )}
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

          <Section title="Equipamento">
            <div>
              <span className="detail-key">Fabricante</span>
              <span className="detail-val">{val(c.fabricante)}</span>
            </div>
            <div>
              <span className="detail-key">Modelo</span>
              <span className="detail-val">{val(c.modeloEquipamento)}</span>
            </div>
            <div>
              <span className="detail-key">Número de série</span>
              <span className="detail-val">{val(c.numeroSerie)}</span>
            </div>
          </Section>

          <Section title="Placa-mãe">
            <div>
              <span className="detail-key">Fabricante</span>
              <span className="detail-val">{val(c.placaMaeFabricante)}</span>
            </div>
            <div>
              <span className="detail-key">Modelo</span>
              <span className="detail-val">{val(c.placaMaeModelo)}</span>
            </div>
          </Section>

          <Section title="BIOS">
            <div>
              <span className="detail-key">Fabricante</span>
              <span className="detail-val">{val(c.biosFabricante)}</span>
            </div>
            <div>
              <span className="detail-key">Versão</span>
              <span className="detail-val">{val(c.biosVersao)}</span>
            </div>
          </Section>

          <Section title="Armazenamento físico">
            {c.discosFisicos && c.discosFisicos.length > 0 ? (
              c.discosFisicos.map((d, i) => (
                <div key={d.id || i} className="disco-item">
                  <div className="disco-titulo">Disco {i + 1}</div>
                  <div>
                    <span className="detail-key">Modelo</span>
                    <span className="detail-val">{val(d.modelo)}</span>
                  </div>
                  <div>
                    <span className="detail-key">Capacidade</span>
                    <span className="detail-val">
                      {d.tamanho != null ? bytesToGB(d.tamanho) : "Não informado"}
                    </span>
                  </div>
                  <div>
                    <span className="detail-key">Interface</span>
                    <span className="detail-val">{val(d.interface)}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhum disco físico informado.</div>
            )}
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

          <Section title="Histórico">
            <div className="period-selector">
              {["24h", "7d", "30d"].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={periodo === p ? "period-btn active" : "period-btn"}
                  onClick={() => setPeriodo(p)}
                >
                  {p === "24h" ? "24 horas" : p === "7d" ? "7 dias" : "30 dias"}
                </button>
              ))}
            </div>
            <MetricChart title="CPU %" data={metricas} dataKey="cpuUso" color="#38bdf8" />
            <MetricChart title="RAM %" data={metricas} dataKey="ramUsoPct" color="#a78bfa" />
            <MetricChart title="Disco %" data={metricas} dataKey="discoUsoPct" color="#f59e0b" />
          </Section>

          <Section title="Histórico de alertas">
            {alertas.length === 0 ? (
              <div className="muted">Nenhum alerta registrado para este equipamento.</div>
            ) : (
              <div className="alert-history">
                {alertas.map((a) => {
                  const fim = a.resolvidoEm ? new Date(a.resolvidoEm) : new Date()
                  const ms = fim - new Date(a.iniciadoEm)
                  const min = Math.max(0, Math.floor(ms / 60000))
                  const dur =
                    min < 60
                      ? `${min} min`
                      : min < 1440
                      ? `${Math.floor(min / 60)}h ${min % 60}min`
                      : `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`
                  return (
                    <div
                      key={a.id}
                      className={`alert-history-item ${a.ativo ? "ativo" : "resolvido"}`}
                    >
                      <div className="ah-top">
                        <span className={`alert ${a.nivel}`}>{a.mensagem}</span>
                        {a.ativo ? (
                          <span className="ah-badge">ATIVO</span>
                        ) : (
                          <span className="ah-badge resolvido">RESOLVIDO</span>
                        )}
                      </div>
                      <div className="ah-meta">
                        Início: {fmtDate(a.iniciadoEm)}
                        {a.resolvidoEm ? ` · Fim: ${fmtDate(a.resolvidoEm)}` : ""}
                        {` · Duração: ${dur}`}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
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
